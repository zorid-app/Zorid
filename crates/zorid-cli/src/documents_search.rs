//! One standalone rich query, one admitted snapshot, bounded NDJSON pages.
//! Core cursors never cross this process boundary. No source mutation or index
//! build is performed here, and output never accumulates earlier result pages.
use super::{documents, Failure, Result};
use clap::{Args, ValueEnum};
use serde::Serialize;
use serde_json::json;
use std::{
    io::{self, Write},
    os::fd::RawFd,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use zorid_native::{
    NativeDocumentError, NativeDocumentResult, NativeRichPreparation, NativeVault, RichPageProfile,
    SearchContext, SearchSort, SearchSpec,
};

const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
const PREPARATION_WORK: usize = 2_000_000;
static STOP: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum Sort {
    #[default]
    NameAsc,
    NameDesc,
    ModifiedDesc,
    ModifiedAsc,
    CreatedDesc,
    CreatedAsc,
}
impl From<Sort> for SearchSort {
    fn from(value: Sort) -> Self {
        match value {
            Sort::NameAsc => Self::NameAsc,
            Sort::NameDesc => Self::NameDesc,
            Sort::ModifiedDesc => Self::ModifiedDesc,
            Sort::ModifiedAsc => Self::ModifiedAsc,
            Sort::CreatedDesc => Self::CreatedDesc,
            Sort::CreatedAsc => Self::CreatedAsc,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum Context {
    #[default]
    Line,
    Section,
}
impl From<Context> for SearchContext {
    fn from(value: Context) -> Self {
        match value {
            Context::Line => Self::Line,
            Context::Section => Self::Section,
        }
    }
}
#[derive(Args)]
pub struct Options {
    /// Rust rich-search expression; this is not the indexed-search literal API.
    query: String,
    #[arg(long)]
    case_sensitive: bool,
    #[arg(long, value_enum, default_value_t = Sort::NameAsc)]
    sort: Sort,
    #[arg(long, value_enum, default_value_t = Context::Line)]
    context: Context,
    #[arg(long)]
    explain: bool,
    /// Stop with an explicitly partial end event after this many output pages.
    #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u32).range(1..=100_000))]
    max_pages: u32,
    /// Finite sort/preparation work; exhaustion is an error, not an empty answer.
    #[arg(long, default_value_t = 1000, value_parser = clap::value_parser!(u32).range(1..=100_000))]
    max_preparation_pumps: u32,
    /// Full snapshot JSON expectation; never a resumable cursor.
    #[arg(long, value_name = "JSON")]
    expected_snapshot: Option<String>,
}

#[derive(Serialize)]
struct Envelope<T> {
    version: u8,
    ok: bool,
    result: T,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page<'a, T> {
    operation: &'static str,
    event: &'static str,
    page: u32,
    has_next: bool,
    #[serde(flatten)]
    data: &'a T,
}

pub fn run(vault: &NativeVault, options: Options) -> Result<()> {
    // Declare signals first so cancellation remains installed through query/pin
    // and output cleanup on every return path.
    let _signals = Signals::install()?;
    let output = NonblockingOutput::new(libc::STDOUT_FILENO).map_err(output_error)?;
    check_cancelled().map_err(rich_failure)?;
    let pin = Arc::new(documents::open(
        vault,
        options.expected_snapshot.as_deref(),
    )?);
    let spec = SearchSpec {
        query: options.query,
        case_sensitive: options.case_sensitive,
        sort: options.sort.into(),
        context: options.context.into(),
        explain: options.explain,
    };
    let query = vault
        .start_rich_document_query(pin.clone(), spec, RichPageProfile::default(), |_| {
            check_cancelled()
        })
        .map_err(rich_failure)?;
    let mut cursor = None;
    for _ in 0..options.max_preparation_pumps {
        check_cancelled().map_err(rich_failure)?;
        match vault
            .prepare_rich_document_query(&query, PREPARATION_WORK, |_| check_cancelled())
            .map_err(rich_failure)?
        {
            NativeRichPreparation::Preparing => {}
            NativeRichPreparation::Ready(ready) => {
                cursor = Some(ready);
                break;
            }
        }
    }
    let mut cursor = cursor.ok_or_else(|| {
        Failure::new(
            "preparation_limit",
            "Rich query preparation reached this invocation's pump limit",
            3,
        )
    })?;
    for page_number in 1..=options.max_pages {
        check_cancelled().map_err(rich_failure)?;
        let page = vault
            .rich_document_page(&query, &cursor, |_| check_cancelled())
            .map_err(rich_failure)?;
        let has_next = page.next.is_some();
        emit(
            &output,
            &Page {
                operation: "indexed_query",
                event: "page",
                page: page_number,
                has_next,
                data: &page.result,
            },
        )?;
        if !has_next || page_number == options.max_pages {
            // These are already cumulative core totals, not sums of pages or
            // repeated per-file chunks. Retain no source body or old page.
            let value = &page.result.value;
            let summary = json!({
                "snapshot": page.result.snapshot, "source": page.result.source,
                "coverageComplete": page.result.coverage_complete,
                "scanComplete": value.scan_complete, "complete": value.complete,
                "outputComplete": value.output_complete,
                "coverage": value.coverage, "totals": value.totals,
            });
            emit(
                &output,
                &json!({
                    "operation": "indexed_query", "event": "end", "pages": page_number,
                    "stopReason": if has_next { "pageLimit" } else { "exhausted" },
                    "hasNext": has_next, "summary": summary,
                }),
            )?;
            // Query Drop closes its exact native state before either Arc pin is
            // released; this ordering also holds on all preceding error paths.
            drop(query);
            drop(pin);
            return Ok(());
        }
        cursor = page.next.expect("has_next checked above");
    }
    unreachable!("clap admits at least one page")
}

fn check_cancelled() -> NativeDocumentResult<()> {
    if STOP.load(Ordering::Relaxed) {
        Err(NativeDocumentError::QueryCancelled)
    } else {
        Ok(())
    }
}
fn rich_failure(error: NativeDocumentError) -> Failure {
    match error {
        NativeDocumentError::SearchCompile(diagnostic) => {
            let mut failure = Failure::new(
                "search_compile",
                "Shared rich search rejected this query",
                2,
            );
            failure.detail = Some(json!({"diagnostic": diagnostic}));
            failure
        }
        NativeDocumentError::SearchResource(_) => Failure::new(
            "search_resource",
            "Rich query exceeded its admitted resource limit",
            2,
        ),
        NativeDocumentError::SearchInvalid(_) => Failure::new(
            "invalid_request",
            "Shared rich search rejected this request",
            2,
        ),
        NativeDocumentError::SearchExpired => Failure::new(
            "search_expired",
            "Rich query continuation is no longer retained",
            3,
        ),
        NativeDocumentError::SearchBusy => {
            Failure::new("search_busy", "Rich query already has an active page", 3)
        }
        NativeDocumentError::QueryCancelled => Failure::new("cancelled", "Rich query cancelled", 3),
        error => documents::failure(error),
    }
}

fn output_error(error: io::Error) -> Failure {
    if error.kind() == io::ErrorKind::Interrupted && STOP.load(Ordering::Relaxed) {
        Failure::new("cancelled", "Rich query cancelled", 3)
    } else {
        Failure::new("output_io", "Could not deliver rich query output", 1)
    }
}

struct BoundedLine(Vec<u8>);
impl Write for BoundedLine {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > MAX_LINE_BYTES - 1 {
            return Err(io::Error::other("rich output line exceeds its bound"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn encode_line(value: &impl Serialize) -> Result<Vec<u8>> {
    let mut line = BoundedLine(Vec::new());
    serde_json::to_writer(
        &mut line,
        &Envelope {
            version: 1,
            ok: true,
            result: value,
        },
    )
    .map_err(|_| {
        Failure::new(
            "output_limit",
            "Rich query output exceeds this command's line bound",
            2,
        )
    })?;
    line.0.push(b'\n');
    Ok(line.0)
}
fn emit(output: &NonblockingOutput, value: &impl Serialize) -> Result<()> {
    let bytes = encode_line(value)?;
    output
        .write(&bytes, || STOP.load(Ordering::Relaxed))
        .map_err(output_error)
}

extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
struct Signals {
    interrupt: libc::sigaction,
    terminate: libc::sigaction,
}
impl Signals {
    fn install() -> Result<Self> {
        STOP.store(false, Ordering::Relaxed);
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = stop as *const () as libc::sighandler_t;
            // Interrupted syscalls must return so output can observe STOP.
            action.sa_flags = 0;
            libc::sigemptyset(&mut action.sa_mask);
            let mut interrupt = std::mem::zeroed();
            let mut terminate = std::mem::zeroed();
            if libc::sigaction(libc::SIGINT, &action, &mut interrupt) != 0 {
                return Err(Failure::new(
                    "signal_setup",
                    "Could not install rich query cancellation",
                    1,
                ));
            }
            if libc::sigaction(libc::SIGTERM, &action, &mut terminate) != 0 {
                libc::sigaction(libc::SIGINT, &interrupt, std::ptr::null_mut());
                return Err(Failure::new(
                    "signal_setup",
                    "Could not install rich query cancellation",
                    1,
                ));
            }
            Ok(Self {
                interrupt,
                terminate,
            })
        }
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        unsafe {
            libc::sigaction(libc::SIGINT, &self.interrupt, std::ptr::null_mut());
            libc::sigaction(libc::SIGTERM, &self.terminate, std::ptr::null_mut());
        }
    }
}

/// Only this standalone command writes stdout. A temporarily nonblocking file
/// description prevents a full consumer pipe from trapping cancellation inside
/// write_all. Restore the original flags without closing caller-owned stdout.
struct NonblockingOutput {
    fd: RawFd,
    flags: libc::c_int,
}
impl NonblockingOutput {
    fn new(fd: RawFd) -> io::Result<Self> {
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags == -1 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { fd, flags })
    }
    fn write(&self, mut bytes: &[u8], mut cancelled: impl FnMut() -> bool) -> io::Result<()> {
        while !bytes.is_empty() {
            if cancelled() {
                return Err(io::ErrorKind::Interrupted.into());
            }
            let count = unsafe { libc::write(self.fd, bytes.as_ptr().cast(), bytes.len()) };
            if count > 0 {
                bytes = &bytes[count as usize..];
            } else if count == 0 {
                return Err(io::ErrorKind::WriteZero.into());
            } else {
                let error = io::Error::last_os_error();
                match error.kind() {
                    io::ErrorKind::Interrupted => continue,
                    io::ErrorKind::WouldBlock => {
                        let mut descriptor = libc::pollfd {
                            fd: self.fd,
                            events: libc::POLLOUT,
                            revents: 0,
                        };
                        if unsafe { libc::poll(&mut descriptor, 1, 100) } < 0 {
                            let error = io::Error::last_os_error();
                            if error.kind() != io::ErrorKind::Interrupted {
                                return Err(error);
                            }
                        }
                    }
                    _ => return Err(error),
                }
            }
        }
        // A signal after a successful last write must not produce a false
        // successful terminal invocation while cancellation is pending.
        if cancelled() {
            Err(io::ErrorKind::Interrupted.into())
        } else {
            Ok(())
        }
    }
}
impl Drop for NonblockingOutput {
    fn drop(&mut self) {
        unsafe {
            libc::fcntl(self.fd, libc::F_SETFL, self.flags);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [-1; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }
    #[test]
    fn bounded_encoder_never_emits_a_partial_json_line() {
        let bytes = encode_line(&json!({"text":"a\n😀"})).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["result"]["text"], "a\n😀");
        assert!(encode_line(&"x".repeat(MAX_LINE_BYTES)).is_err());
    }
    #[test]
    fn output_restores_flags_and_writes_exact_utf8() {
        for initially_nonblocking in [false, true] {
            let (read, write) = pipe();
            if initially_nonblocking {
                let flags = unsafe { libc::fcntl(write.as_raw_fd(), libc::F_GETFL) };
                assert!(flags >= 0);
                assert_eq!(
                    unsafe {
                        libc::fcntl(write.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK)
                    },
                    0
                );
            }
            let original = unsafe { libc::fcntl(write.as_raw_fd(), libc::F_GETFL) };
            assert!(original >= 0);
            let after_write;
            {
                let output = NonblockingOutput::new(write.as_raw_fd()).unwrap();
                assert_ne!(
                    unsafe { libc::fcntl(write.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK,
                    0
                );
                output.write("one😀\n".as_bytes(), || false).unwrap();
                after_write = unsafe { libc::fcntl(write.as_raw_fd(), libc::F_GETFL) };
                assert!(after_write >= 0);
            }
            // A successful write can add kernel-maintained status (Darwin's
            // write-history flag). Restore the original NONBLOCK bit and check
            // every other bit against its exact post-write value.
            let restored = unsafe { libc::fcntl(write.as_raw_fd(), libc::F_GETFL) };
            assert_eq!(
                restored,
                (after_write & !libc::O_NONBLOCK) | (original & libc::O_NONBLOCK)
            );
            let mut result = [0; 32];
            let count =
                unsafe { libc::read(read.as_raw_fd(), result.as_mut_ptr().cast(), result.len()) };
            assert_eq!(&result[..count as usize], "one😀\n".as_bytes());
        }
    }
    #[test]
    fn full_pipe_observes_cancellation_without_waiting_for_a_reader() {
        let (_read, write) = pipe();
        let output = NonblockingOutput::new(write.as_raw_fd()).unwrap();
        let block = [0_u8; 4096];
        loop {
            let result =
                unsafe { libc::write(write.as_raw_fd(), block.as_ptr().cast(), block.len()) };
            if result < 0 {
                assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
                break;
            }
        }
        let mut checks = 0;
        let error = output
            .write(b"pending", || {
                checks += 1;
                checks > 1
            })
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(checks, 2);
    }
    #[test]
    fn closed_consumer_is_an_error_not_success() {
        let (read, write) = pipe();
        let output = NonblockingOutput::new(write.as_raw_fd()).unwrap();
        drop(read);
        assert_eq!(
            output.write(b"pending", || false).unwrap_err().kind(),
            io::ErrorKind::BrokenPipe
        );
    }
}
