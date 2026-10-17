//! Small owned C ABI over the shared native host. Swift/Kotlin never implement
//! storage, Markdown or sync semantics. Each session is used on one serial queue.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::{
    ffi::{c_char, CStr},
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
};
use zorid_desktop_host::{
    EmbeddedFixtureSyncLimits, EmbeddedHost, TrustedFixtureSyncOptions, TrustedImportSelection,
    TrustedStagedImportSource, MAX_EMBEDDED_FIXTURE_RESULT_BYTES, MAX_IMPORT_RESULT_BYTES,
};

#[repr(C)]
pub struct ZoridBuffer {
    pub data: *mut u8,
    pub len: usize,
}

fn import_error(code: &'static str, uncertain: bool) -> Value {
    json!({"code":code,"commit_uncertain":uncertain})
}
fn normalized_import_error(value: Value) -> Value {
    // Shared admission faults may contain a generic message. The native import
    // ABI has exactly TWO error fields; never forward arbitrary error payloads.
    let code = match value.get("code").and_then(Value::as_str) {
        Some("import_invalid_selection") => "import_invalid_selection",
        Some("import_invalid_destination") => "import_invalid_destination",
        Some("import_invalid_source") => "import_invalid_source",
        Some("import_invalid_operation") => "import_invalid_operation",
        Some("import_too_large") => "import_too_large",
        Some("import_name_limit") => "import_name_limit",
        Some("import_checkpoint") => "import_checkpoint",
        Some("import_idempotency_conflict") => "import_idempotency_conflict",
        Some("import_invalid_text") => "import_invalid_text",
        Some("import_unsupported") => "import_unsupported",
        Some("import_source_changed") => "import_source_changed",
        Some("import_target_rejected") => "import_target_rejected",
        Some("import_storage") => "import_storage",
        Some("import_busy") => "import_busy",
        Some("import_not_found") => "import_not_found",
        Some("client_not_admitted") => "client_not_admitted",
        Some("client_scope_mismatch") => "client_scope_mismatch",
        Some("invalid_client_id") => "invalid_client_id",
        Some("client_in_use") => "client_in_use",
        Some("unsafe_path") => "unsafe_path",
        Some("filesystem_changed") => "filesystem_changed",
        Some("unsupported") => "unsupported",
        Some("lock_timeout") => "lock_timeout",
        Some("unsupported_schema") => "unsupported_schema",
        Some("reload_required") => "reload_required",
        Some("corrupt_storage") => "corrupt_storage",
        Some("storage_io") => "storage_io",
        Some("filesystem_io") => "filesystem_io",
        _ => "import_error",
    };
    import_error(
        code,
        value
            .get("commit_uncertain")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    )
}
fn import_reply(
    result: Result<zorid_desktop_host::ImportProgress, Value>,
) -> std::io::Result<Vec<u8>> {
    let value = match result {
        Ok(result) => json!({"version":1,"ok":true,"result":result}),
        Err(error) => json!({"version":1,"ok":false,"error":normalized_import_error(error)}),
    };
    let bytes = serde_json::to_vec(&value).map_err(|_| std::io::Error::other("import encoding"))?;
    if bytes.len() <= MAX_IMPORT_RESULT_BYTES {
        return Ok(bytes);
    }
    // Failure to encode a mutation acknowledgement is uncertain, never retryable
    // under a fresh operation identity. This envelope itself is statically bounded.
    serde_json::to_vec(&json!({"version":1,"ok":false,
        "error":import_error("import_response_limit",true)}))
    .map_err(|_| std::io::Error::other("import encoding"))
}

/// Duplicate raw native descriptor BEFORE constructing File ownership. Invalid
/// positive/closed descriptors are ordinary OS failures, never Rust IO-safety UB.
/// F_DUPFD_CLOEXEC atomically prevents inheritance without a fork/exec race.
#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
))]
fn duplicate_import_source(fd: i32) -> Result<TrustedStagedImportSource, Value> {
    use std::os::fd::FromRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, command: i32, ...) -> i32;
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    const DUP_CLOEXEC: i32 = 67;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const DUP_CLOEXEC: i32 = 1030;
    if fd < 0 {
        return Err(import_error("import_invalid_source", false));
    }
    let duplicate = unsafe { fcntl(fd, DUP_CLOEXEC, 0i32) };
    if duplicate < 0 {
        return Err(import_error("import_invalid_source", false));
    }
    // Only successful OS duplication establishes ownership; original is untouched.
    let file = unsafe { std::fs::File::from_raw_fd(duplicate) };
    TrustedStagedImportSource::new(file)
}
#[cfg(not(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "linux",
    target_os = "android"
)))]
fn duplicate_import_source(_: i32) -> Result<TrustedStagedImportSource, Value> {
    Err(import_error("import_unsupported", false))
}

/// Native-only import capability. Never register this as a renderer/plugin method.
/// Copy provider data into an immutable app-owned regular file first. The shell
/// persists exact selection before begin, and retains it on any uncertain result.
/// borrowed_fd stays open through this call; Rust owns a CLOEXEC duplicate only.
/// -1 permits source-free recovery of an existing sealed/terminal binary or saved
/// text intent; it never grants a new import. No source path is decoded here.
/// # Safety
/// Session is live/exclusive; selection covers selection_len readable bytes for
/// this call. Serialize request/import/free/close, drain all accepted work first.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_import_begin(
    session: *mut MobileSession,
    borrowed_fd: i32,
    selection: *const u8,
    selection_len: usize,
) -> ZoridBuffer {
    if session.is_null() {
        return ZoridBuffer::empty();
    }
    (*session).guarded_request(|host| {
        if selection.is_null() || selection_len == 0 || selection_len > 8192 {
            return import_reply(Err(import_error("import_invalid_selection", false)));
        }
        let selection = match TrustedImportSelection::from_native_json(std::slice::from_raw_parts(
            selection,
            selection_len,
        )) {
            Ok(value) => value,
            Err(error) => return import_reply(Err(error)),
        };
        let source = if borrowed_fd == -1 {
            None
        } else {
            match duplicate_import_source(borrowed_fd) {
                Ok(source) => Some(source),
                Err(error) => return import_reply(Err(error)),
            }
        };
        import_reply(host.staged_import_begin(source, selection))
    })
}
unsafe fn import_action(
    session: *mut MobileSession,
    operation: *const u8,
    operation_len: usize,
    action: impl FnOnce(&mut EmbeddedHost, &str) -> Result<zorid_desktop_host::ImportProgress, Value>,
) -> ZoridBuffer {
    if session.is_null() {
        return ZoridBuffer::empty();
    }
    (*session).guarded_request(|host| {
        let operation = match trusted_utf8(operation, operation_len, 36, "import_invalid_operation")
        {
            Ok(value) if value.len() == 36 => value,
            _ => return import_reply(Err(import_error("import_invalid_operation", false))),
        };
        import_reply(action(host, operation))
    })
}
/// One bounded source hash/append unit, or one existing durable seal/commit call.
/// # Safety
/// Live exclusive session; operation readable for operation_len; serialized/free/close.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_import_step(
    session: *mut MobileSession,
    operation: *const u8,
    operation_len: usize,
) -> ZoridBuffer {
    import_action(session, operation, operation_len, |host, id| {
        host.staged_import_step(id)
    })
}
/// Native-only status; existing receipt outranks current path/projection state.
/// # Safety
/// Same pointer, lifetime and serialization contract as import_step.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_import_status(
    session: *mut MobileSession,
    operation: *const u8,
    operation_len: usize,
) -> ZoridBuffer {
    import_action(session, operation, operation_len, |host, id| {
        host.staged_import_status(id)
    })
}
/// Precommit abort only. After durable commit intent this reports finishing;
/// preserve the original selection and drain/replay step, never claim rollback.
/// # Safety
/// Same pointer, lifetime and serialization contract as import_step.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_import_cancel(
    session: *mut MobileSession,
    operation: *const u8,
    operation_len: usize,
) -> ZoridBuffer {
    import_action(session, operation, operation_len, |host, id| {
        host.staged_import_cancel(id)
    })
}
impl ZoridBuffer {
    fn empty() -> Self {
        Self {
            data: ptr::null_mut(),
            len: 0,
        }
    }
    fn owned(bytes: Vec<u8>) -> Self {
        let boxed = bytes.into_boxed_slice();
        let len = boxed.len();
        Self {
            data: Box::into_raw(boxed) as *mut u8,
            len,
        }
    }
}
pub struct MobileSession {
    host: Option<EmbeddedHost>,
}
impl MobileSession {
    fn guarded_fixture(
        &mut self,
        uncertain: bool,
        action: impl FnOnce(&mut EmbeddedHost) -> Result<Value, Value>,
    ) -> ZoridBuffer {
        self.guarded_request(|host| fixture_reply(action(host), uncertain))
    }
    fn guarded_request(
        &mut self,
        action: impl FnOnce(&mut EmbeddedHost) -> std::io::Result<Vec<u8>>,
    ) -> ZoridBuffer {
        let Some(host) = self.host.as_mut() else {
            return ZoridBuffer::empty();
        };
        match catch_unwind(AssertUnwindSafe(|| action(host))) {
            Ok(Ok(bytes)) => ZoridBuffer::owned(bytes),
            _ => {
                // A terminal frame failure/panic fences this generation and drops
                // leases. Reopen with the same persisted consumer/operation IDs.
                self.host.take();
                ZoridBuffer::empty()
            }
        }
    }
}
/// Path is a trusted native-selected UTF-8 app-local directory. Never web input.
/// The returned session is exclusive; do not call/drop it concurrently.
/// On failure a sanitized JSON error is returned in error_out, freed with buffer_free.
/// # Safety
/// root must be NUL-terminated; error_out must point to writable storage.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_open(
    root: *const c_char,
    error_out: *mut ZoridBuffer,
) -> *mut MobileSession {
    if root.is_null() || error_out.is_null() {
        return ptr::null_mut();
    }
    *error_out = ZoridBuffer::empty();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let path = CStr::from_ptr(root)
            .to_str()
            .map_err(|_| serde_json::json!({"code":"invalid_root"}))?;
        EmbeddedHost::open_local(std::path::Path::new(path))
    }));
    match result {
        Ok(Ok(host)) => Box::into_raw(Box::new(MobileSession { host: Some(host) })),
        other => {
            let error = match other {
                Ok(Err(error)) => error,
                _ => serde_json::json!({"code":"native_panic"}),
            };
            *error_out = ZoridBuffer::owned(serde_json::to_vec(&error).unwrap());
            ptr::null_mut()
        }
    }
}
// Only the trusted native shell selects these bytes; no renderer JSON is parsed.
// Length checks precede slice construction. Readability is an unsafe caller duty.
unsafe fn trusted_utf8<'a>(
    bytes: *const u8,
    len: usize,
    limit: usize,
    code: &'static str,
) -> Result<&'a str, Value> {
    if bytes.is_null() || len == 0 || len > limit {
        return Err(fixture_error(code, false));
    }
    let bytes = std::slice::from_raw_parts(bytes, len);
    if bytes.contains(&0) {
        return Err(fixture_error(code, false));
    }
    std::str::from_utf8(bytes).map_err(|_| fixture_error(code, false))
}
fn fixture_error(code: &'static str, uncertain: bool) -> Value {
    json!({"code":code,"commit_uncertain":uncertain})
}
fn fixture_reply(result: Result<Value, Value>, uncertain: bool) -> std::io::Result<Vec<u8>> {
    let value = match result {
        Ok(result) => json!({"version":1,"ok":true,"result":result}),
        Err(error) => json!({"version":1,"ok":false,"error":error}),
    };
    let bytes =
        serde_json::to_vec(&value).map_err(|_| std::io::Error::other("fixture encoding"))?;
    if bytes.len() <= MAX_EMBEDDED_FIXTURE_RESULT_BYTES {
        return Ok(bytes);
    }
    // Never truncate a valid JSON document or emit the oversized original value.
    serde_json::to_vec(&json!({"version":1,"ok":false,
        "error":fixture_error("sync_response_limit", uncertain)}))
    .map_err(|_| std::io::Error::other("fixture encoding"))
}

/// Open an already prepared disposable loopback fixture. Native-only authority;
/// never register this constructor or fixture operations as renderer methods.
/// No enroll, rebind or local-only fallback occurs when configuration is invalid.
/// On failure, error_out owns a bounded version-1 JSON error envelope.
/// # Safety
/// Each non-null byte pointer must cover its stated readable length for this call;
/// error_out is writable/non-aliasing. No concurrent use/drop of the returned
/// session is permitted; serialize calls and buffer frees, drain before close.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_open_fixture(
    root: *const u8,
    root_len: usize,
    persisted_client_id: *const u8,
    client_id_len: usize,
    credentials_path: *const u8,
    credentials_path_len: usize,
    error_out: *mut ZoridBuffer,
) -> *mut MobileSession {
    if error_out.is_null() {
        return ptr::null_mut();
    }
    *error_out = ZoridBuffer::empty();
    let result = catch_unwind(AssertUnwindSafe(|| {
        let root = trusted_utf8(root, root_len, 4096, "invalid_root")?;
        if !Path::new(root).is_absolute() {
            return Err(fixture_error("invalid_root", false));
        }
        let client = trusted_utf8(persisted_client_id, client_id_len, 36, "invalid_client_id")?;
        let config = trusted_utf8(
            credentials_path,
            credentials_path_len,
            4096,
            "credentials_permissions",
        )?;
        let options = TrustedFixtureSyncOptions::new(client, PathBuf::from(config))?;
        EmbeddedHost::open_local_with_fixture(Path::new(root), options)
    }));
    match result {
        Ok(Ok(host)) => Box::into_raw(Box::new(MobileSession { host: Some(host) })),
        other => {
            let error = match other {
                Ok(Err(error)) => error,
                _ => fixture_error("native_panic", false),
            };
            if let Ok(bytes) = fixture_reply(Err(error), false) {
                *error_out = ZoridBuffer::owned(bytes);
            }
            ptr::null_mut()
        }
    }
}

/// Read-only native fixture status using this host's current admitted consumer.
/// The owned result/error JSON is <=64KiB. Empty output is terminal/unavailable.
/// # Safety
/// session is live and exclusive; serialize with request/startup/refresh/free/close.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_fixture_status(session: *mut MobileSession) -> ZoridBuffer {
    if session.is_null() {
        return ZoridBuffer::empty();
    }
    (*session).guarded_fixture(false, |host| {
        let status = host.fixture_sync_status()?;
        serde_json::to_value(status).map_err(|_| fixture_error("native_response_invalid", false))
    })
}

/// One existing host sweep, no enrollment or credential/endpoint selection.
/// Host validates 0..=1 budgets and current admission. After runner entry, errors
/// preserve uncertain-progress semantics; UI cancellation is not a rollback.
/// # Safety
/// session is live/exclusive. Drain this synchronous call and free its owned
/// buffer before close. Never interrupt by dropping the host on another thread.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_fixture_once(
    session: *mut MobileSession,
    max_push: u32,
    max_pages: u32,
) -> ZoridBuffer {
    if session.is_null() {
        return ZoridBuffer::empty();
    }
    (*session).guarded_fixture(true, |host| {
        let report = host.fixture_sync_once(EmbeddedFixtureSyncLimits {
            max_push,
            max_pages,
        })?;
        serde_json::to_value(report).map_err(|_| fixture_error("native_response_invalid", true))
    })
}

/// One complete bounded stdio-compatible frame. Empty response means transport
/// failure; caller preserves every in-flight operation/checkpoint identity.
/// # Safety
/// session is live/exclusive, bytes points to len readable bytes.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_request(
    session: *mut MobileSession,
    bytes: *const u8,
    len: usize,
) -> ZoridBuffer {
    if session.is_null() {
        return ZoridBuffer::empty();
    }
    if bytes.is_null() || len > 34 * 1024 * 1024 {
        // Empty transport failure must not leave an invisible admitted lease.
        (*session).host.take();
        return ZoridBuffer::empty();
    }
    let frame = std::slice::from_raw_parts(bytes, len);
    (*session).guarded_request(|host| host.dispatch(frame))
}
/// # Safety
/// buffer was returned by this ABI and has not previously been freed.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_buffer_free(buffer: ZoridBuffer) {
    if !buffer.data.is_null() {
        drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
            buffer.data,
            buffer.len,
        )));
    }
}
/// Drop releases SQLite and consumer kernel leases; retained drafts/intents stay.
/// # Safety
/// session was returned by open, no calls remain and it was not already closed.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_close(session: *mut MobileSession) {
    if !session.is_null() {
        drop(Box::from_raw(session));
    }
}

/// Sanitized startup diagnostics; no selected root or file content.
/// # Safety
/// session is a live exclusive pointer returned by open.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_startup(session: *mut MobileSession) -> ZoridBuffer {
    if session.is_null() {
        return ZoridBuffer::empty();
    }
    (*session).guarded_request(|host| {
        // This source compiles against the host with admitted Documents dispatch.
        // Older static binaries omit the optional field; native must not infer it.
        serde_json::to_vec(
            &json!({"reconciliation":host.reconciliation(),"documentSemantics":true}),
        )
        .map_err(|_| std::io::Error::other("startup encoding"))
    })
}
/// Trusted shell-triggered bounded local refresh, never arbitrary root selection.
/// # Safety
/// session is a live exclusive pointer returned by open.
#[no_mangle]
pub unsafe extern "C" fn zorid_mobile_refresh(session: *mut MobileSession) -> ZoridBuffer {
    if session.is_null() {
        return ZoridBuffer::empty();
    }
    let state = &mut *session;
    let Some(host) = state.host.as_mut() else {
        return ZoridBuffer::empty();
    };
    match catch_unwind(AssertUnwindSafe(|| host.refresh_local())) {
        Ok(Ok(status)) => ZoridBuffer::owned(
            serde_json::to_vec(&serde_json::json!({"reconciliation":status})).unwrap(),
        ),
        Ok(Err(_)) => ZoridBuffer::empty(),
        Err(_) => {
            state.host.take();
            ZoridBuffer::empty()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame(command: serde_json::Value) -> Vec<u8> {
        let header = serde_json::to_vec(
            &serde_json::json!({"version":1,"request_id":"1","command":command}),
        )
        .unwrap();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(header.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend(header);
        bytes
    }
    fn claim() -> Vec<u8> {
        frame(
            serde_json::json!({"method":"claim_client","client_id":"abcdefab-0000-4000-8000-000000000001"}),
        )
    }
    #[test]
    fn panic_after_claim_fences_session_and_drops_invisible_lease() {
        let root = std::env::temp_dir().join(format!(
            "zorid-mobile-ffi-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let mut session = MobileSession {
            host: Some(EmbeddedHost::open_local(&root).unwrap()),
        };
        let response = session.guarded_request(|host| {
            host.dispatch(&claim())?;
            panic!("injected after claim");
        });
        assert!(response.data.is_null());
        assert!(session.host.is_none());
        let refused = session.guarded_request(|_| panic!("poisoned session must not dispatch"));
        assert!(refused.data.is_null());
        let mut reopened = EmbeddedHost::open_local(&root).unwrap();
        let reply = reopened.dispatch(&claim()).unwrap();
        let n = u32::from_be_bytes(reply[..4].try_into().unwrap()) as usize;
        let header: serde_json::Value = serde_json::from_slice(&reply[8..8 + n]).unwrap();
        assert_eq!(header["ok"], true);
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn buffer_round_trip_uses_owned_exact_slice() {
        let data = vec![0, 255, 1, 0, 42];
        let buffer = ZoridBuffer::owned(data.clone());
        assert_eq!(
            unsafe { std::slice::from_raw_parts(buffer.data, buffer.len) },
            data
        );
        unsafe {
            zorid_mobile_buffer_free(buffer);
            zorid_mobile_buffer_free(ZoridBuffer::empty());
        }
    }

    const CLIENT: &str = "abcdefab-0000-4000-8000-000000000001";
    fn framed_header(bytes: &[u8]) -> Value {
        let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        serde_json::from_slice(&bytes[8..8 + len]).unwrap()
    }
    unsafe fn consume_json(buffer: ZoridBuffer) -> Value {
        assert!(!buffer.data.is_null());
        let bytes = std::slice::from_raw_parts(buffer.data, buffer.len).to_vec();
        zorid_mobile_buffer_free(buffer);
        serde_json::from_slice(&bytes).unwrap()
    }
    struct TestSession(*mut MobileSession);
    impl Drop for TestSession {
        fn drop(&mut self) {
            unsafe { zorid_mobile_close(self.0) }
        }
    }
    struct DisposableFixture {
        parent: PathBuf,
        root: PathBuf,
        config: PathBuf,
    }
    impl Drop for DisposableFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.parent);
        }
    }
    impl DisposableFixture {
        fn new() -> Self {
            let parent = std::env::temp_dir().join(format!(
                "zorid-mobile-fixture-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let root = parent.join("vault");
            std::fs::create_dir_all(&root).unwrap();
            let mut seed = EmbeddedHost::open_local(&root).unwrap();
            let family = framed_header(
                &seed
                    .dispatch(&frame(json!({"method":"local_family_status"})))
                    .unwrap(),
            );
            let scope = &family["result"]["family"]["scope"];
            assert!(scope.is_object());
            let config = parent.join("fixture-secret-sentinel.json");
            // Synthetic disposable key/token, never a real credential store.
            let value = json!({"version":2,"transport":"grpc","endpoint":"http://127.0.0.1:9/",
                "realm_id":scope["realm_id"],"vault_id":scope["vault_id"],
                "server_epoch":"epoch-secret-sentinel","key_epoch":1,
                "key_base64":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","bearer_token":"a".repeat(64)});
            std::fs::write(&config, serde_json::to_vec(&value).unwrap()).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
                std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
            }
            drop(seed);
            Self {
                parent,
                root,
                config,
            }
        }
        unsafe fn open_fixture(&self) -> TestSession {
            let root = self.root.to_str().unwrap().as_bytes();
            let config = self.config.to_str().unwrap().as_bytes();
            let mut error = ZoridBuffer::empty();
            let pointer = zorid_mobile_open_fixture(
                root.as_ptr(),
                root.len(),
                CLIENT.as_ptr(),
                CLIENT.len(),
                config.as_ptr(),
                config.len(),
                &mut error,
            );
            assert!(error.data.is_null());
            assert!(!pointer.is_null());
            TestSession(pointer)
        }
        unsafe fn open_local(&self) -> TestSession {
            let root = std::ffi::CString::new(self.root.to_str().unwrap()).unwrap();
            let mut error = ZoridBuffer::empty();
            let pointer = zorid_mobile_open(root.as_ptr(), &mut error);
            assert!(error.data.is_null());
            assert!(!pointer.is_null());
            TestSession(pointer)
        }
    }
    unsafe fn request_json(session: &TestSession, command: Value) -> Value {
        let bytes = frame(command);
        let result = zorid_mobile_request(session.0, bytes.as_ptr(), bytes.len());
        assert!(!result.data.is_null());
        let parsed = framed_header(std::slice::from_raw_parts(result.data, result.len));
        zorid_mobile_buffer_free(result);
        parsed
    }
    fn check_error(value: &Value, code: &str, uncertain: bool) {
        assert_eq!(value["version"], 1);
        assert_eq!(value["ok"], false);
        assert!(value.get("result").is_none());
        assert_eq!(value["error"]["code"], code);
        assert_eq!(value["error"]["commit_uncertain"], uncertain);
        let text = serde_json::to_string(value).unwrap();
        assert!(!text.contains("secret-sentinel"));
        assert!(!text.contains(&"a".repeat(64)));
        assert!(!text.contains("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="));
        assert!(text.len() <= MAX_EMBEDDED_FIXTURE_RESULT_BYTES);
    }

    #[test]
    fn local_startup_capability_and_refresh_shape_preserve_legacy_open() {
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_local();
            let startup = consume_json(zorid_mobile_startup(session.0));
            assert_eq!(startup["documentSemantics"], true);
            assert!(startup["reconciliation"]["complete"].is_boolean());
            let refresh = consume_json(zorid_mobile_refresh(session.0));
            assert!(refresh.get("documentSemantics").is_none());
            assert!(refresh["reconciliation"]["complete"].is_boolean());
            check_error(
                &consume_json(zorid_mobile_fixture_status(session.0)),
                "fixture_sync_not_configured",
                false,
            );
            check_error(
                &consume_json(zorid_mobile_fixture_once(session.0, 1, 1)),
                "fixture_sync_not_configured",
                false,
            );
            assert_eq!(
                request_json(
                    &session,
                    json!({"method":"claim_client","client_id":CLIENT})
                )["ok"],
                true
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn configured_fixture_requires_admission_and_release_is_rechecked() {
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_fixture();
            check_error(
                &consume_json(zorid_mobile_fixture_status(session.0)),
                "client_not_admitted",
                false,
            );
            check_error(
                &consume_json(zorid_mobile_fixture_once(session.0, 1, 1)),
                "client_not_admitted",
                false,
            );
            let claim = request_json(
                &session,
                json!({"method":"claim_client","client_id":CLIENT}),
            );
            assert_eq!(claim["ok"], true);
            let status = consume_json(zorid_mobile_fixture_status(session.0));
            assert_eq!(status["version"], 1);
            assert_eq!(status["ok"], true);
            assert!(status.get("error").is_none());
            assert_eq!(status["result"]["scope"], "fixture_families_v2");
            assert!(status["result"].get("family").is_none());
            let text = serde_json::to_string(&status).unwrap();
            assert!(!text.contains(CLIENT));
            assert!(!text.contains(fixture.parent.to_str().unwrap()));
            assert!(!text.contains("secret-sentinel"));
            check_error(
                &consume_json(zorid_mobile_fixture_once(session.0, 2, 1)),
                "sync_limit",
                false,
            );
            let released = request_json(
                &session,
                json!({"method":"release_client","reference":claim["result"]["lease"]}),
            );
            assert_eq!(released["ok"], true);
            check_error(
                &consume_json(zorid_mobile_fixture_status(session.0)),
                "client_not_admitted",
                false,
            );
            check_error(
                &consume_json(zorid_mobile_fixture_once(session.0, 1, 1)),
                "client_not_admitted",
                false,
            );
        }
    }

    #[test]
    #[cfg(unix)]
    fn offline_once_error_is_uncertain_but_does_not_destroy_admitted_host() {
        let fixture = DisposableFixture::new();
        let socket = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/", socket.local_addr().unwrap());
        drop(socket);
        let mut config: Value =
            serde_json::from_slice(&std::fs::read(&fixture.config).unwrap()).unwrap();
        config["endpoint"] = json!(endpoint);
        std::fs::write(&fixture.config, serde_json::to_vec(&config).unwrap()).unwrap();
        unsafe {
            let session = fixture.open_fixture();
            assert_eq!(
                request_json(
                    &session,
                    json!({"method":"claim_client","client_id":CLIENT})
                )["ok"],
                true
            );
            check_error(
                &consume_json(zorid_mobile_fixture_once(session.0, 1, 1)),
                "sync_transport",
                true,
            );
            assert_eq!(
                consume_json(zorid_mobile_fixture_status(session.0))["ok"],
                true
            );
            assert_eq!(
                request_json(&session, json!({"method":"identity"}))["ok"],
                true
            );
        }
    }

    #[test]
    fn fixture_constructor_rejects_invalid_native_bytes_without_fallback() {
        let fixture = DisposableFixture::new();
        let root = fixture.root.to_str().unwrap().as_bytes();
        let config = fixture.config.to_str().unwrap().as_bytes();
        let long_root = vec![b'/'; 4097];
        let invalid_utf8 = [255];
        let embedded_nul = b"/private/fixture\0bad";
        let cases: Vec<(&[u8], &[u8], &[u8], &str)> = vec![
            (b"", CLIENT.as_bytes(), config, "invalid_root"),
            (b"relative", CLIENT.as_bytes(), config, "invalid_root"),
            (&long_root, CLIENT.as_bytes(), config, "invalid_root"),
            (&invalid_utf8, CLIENT.as_bytes(), config, "invalid_root"),
            (root, b"not-a-client", config, "invalid_client_id"),
            (
                root,
                b"ABCDEFAB-0000-4000-8000-000000000001",
                config,
                "invalid_client_id",
            ),
            (
                root,
                CLIENT.as_bytes(),
                b"relative.json",
                "credentials_permissions",
            ),
            (
                root,
                CLIENT.as_bytes(),
                embedded_nul,
                "credentials_permissions",
            ),
        ];
        unsafe {
            for (root, client, config, code) in cases {
                let mut error = ZoridBuffer::empty();
                let session = zorid_mobile_open_fixture(
                    root.as_ptr(),
                    root.len(),
                    client.as_ptr(),
                    client.len(),
                    config.as_ptr(),
                    config.len(),
                    &mut error,
                );
                assert!(session.is_null());
                check_error(&consume_json(error), code, false);
            }
            let mut error = ZoridBuffer::empty();
            assert!(zorid_mobile_open_fixture(
                ptr::null(),
                1,
                CLIENT.as_ptr(),
                CLIENT.len(),
                config.as_ptr(),
                config.len(),
                &mut error
            )
            .is_null());
            check_error(&consume_json(error), "invalid_root", false);
            assert!(zorid_mobile_open_fixture(
                root.as_ptr(),
                root.len(),
                CLIENT.as_ptr(),
                CLIENT.len(),
                config.as_ptr(),
                config.len(),
                ptr::null_mut()
            )
            .is_null());
        }
    }

    #[test]
    #[cfg(unix)]
    fn wrong_fixture_binding_returns_bounded_error_and_never_local_session() {
        let fixture = DisposableFixture::new();
        let mut config: Value =
            serde_json::from_slice(&std::fs::read(&fixture.config).unwrap()).unwrap();
        config["realm_id"] = json!("wrong-secret-sentinel");
        std::fs::write(&fixture.config, serde_json::to_vec(&config).unwrap()).unwrap();
        unsafe {
            let root = fixture.root.to_str().unwrap().as_bytes();
            let path = fixture.config.to_str().unwrap().as_bytes();
            let mut error = ZoridBuffer::empty();
            assert!(zorid_mobile_open_fixture(
                root.as_ptr(),
                root.len(),
                CLIENT.as_ptr(),
                CLIENT.len(),
                path.as_ptr(),
                path.len(),
                &mut error
            )
            .is_null());
            check_error(&consume_json(error), "sync_binding_mismatch", false);
            let local = fixture.open_local();
            assert_eq!(
                request_json(&local, json!({"method":"claim_client","client_id":CLIENT}))["ok"],
                true
            );
        }
    }

    #[test]
    fn malformed_frame_and_invalid_transport_arguments_fence_claimed_session() {
        for malformed in [true, false] {
            let fixture = DisposableFixture::new();
            unsafe {
                let session = fixture.open_local();
                assert_eq!(
                    request_json(
                        &session,
                        json!({"method":"claim_client","client_id":CLIENT})
                    )["ok"],
                    true
                );
                let bad = [0u8];
                let reply = if malformed {
                    zorid_mobile_request(session.0, bad.as_ptr(), bad.len())
                } else {
                    zorid_mobile_request(session.0, ptr::null(), 1)
                };
                assert!(reply.data.is_null());
                assert!((*session.0).host.is_none());
                assert!(zorid_mobile_fixture_status(session.0).data.is_null());
                assert!(zorid_mobile_startup(session.0).data.is_null());
                let reopened = fixture.open_local();
                assert_eq!(
                    request_json(
                        &reopened,
                        json!({"method":"claim_client","client_id":CLIENT})
                    )["ok"],
                    true
                );
            }
        }
    }

    #[test]
    fn fixture_panic_fences_and_releases_lease_while_known_errors_do_not() {
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_local();
            assert_eq!(
                request_json(
                    &session,
                    json!({"method":"claim_client","client_id":CLIENT})
                )["ok"],
                true
            );
            check_error(
                &consume_json(zorid_mobile_fixture_status(session.0)),
                "fixture_sync_not_configured",
                false,
            );
            let panic = (*session.0).guarded_fixture(true, |_| panic!("injected fixture failure"));
            assert!(panic.data.is_null());
            assert!((*session.0).host.is_none());
            let reopened = fixture.open_local();
            assert_eq!(
                request_json(
                    &reopened,
                    json!({"method":"claim_client","client_id":CLIENT})
                )["ok"],
                true
            );
        }
    }

    #[test]
    fn oversized_fixture_reply_is_a_complete_redacted_error_not_truncated_json() {
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_local();
            let reply = (*session.0).guarded_fixture(true, |_| {
                Ok(json!({
                    "secret-sentinel":"z".repeat(MAX_EMBEDDED_FIXTURE_RESULT_BYTES)
                }))
            });
            assert!(reply.len <= MAX_EMBEDDED_FIXTURE_RESULT_BYTES);
            check_error(&consume_json(reply), "sync_response_limit", true);
            assert!((*session.0).host.is_some());
        }
    }

    const IMPORT_OP: &str = "abcdefab-0000-4000-8000-000000000002";
    unsafe fn import_selection(session: &TestSession, token: &str) -> Vec<u8> {
        let identity = request_json(session, json!({"method":"identity"}));
        serde_json::to_vec(&json!({"version":1,"clientId":CLIENT,
            "localStoreId":identity["result"]["identity"]["local_store_id"],"leaseToken":token,
            "operationId":IMPORT_OP,"entryId":"abcdefab-0000-4000-8000-000000000003",
            "destinationFolder":"","fileName":"x.bin","kind":"auto","expectedLength":"1",
            "sha256":"ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"}))
        .unwrap()
    }
    unsafe fn import_begin_json(session: &TestSession, fd: i32, selection: &[u8]) -> Value {
        consume_json(zorid_mobile_import_begin(
            session.0,
            fd,
            selection.as_ptr(),
            selection.len(),
        ))
    }
    unsafe fn import_step_json(session: &TestSession) -> Value {
        consume_json(zorid_mobile_import_step(
            session.0,
            IMPORT_OP.as_ptr(),
            IMPORT_OP.len(),
        ))
    }
    #[test]
    #[cfg(unix)]
    fn import_invalid_and_closed_descriptors_are_nonterminal_and_do_not_close_caller() {
        use std::os::fd::AsRawFd;
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_local();
            let mut selection = import_selection(&session, CLIENT);
            let acquired = request_json(
                &session,
                json!({"method":"claim_client","client_id":CLIENT}),
            );
            assert_eq!(acquired["ok"], true);
            selection = import_selection(
                &session,
                acquired["result"]["lease"]["token"].as_str().unwrap(),
            );
            let path = fixture.parent.join("import-source");
            std::fs::write(&path, b"a").unwrap();
            let file = std::fs::File::open(&path).unwrap();
            let fd = file.as_raw_fd();
            drop(file);
            for invalid in [-2, fd, i32::MAX] {
                check_error(
                    &import_begin_json(&session, invalid, &selection),
                    "import_invalid_source",
                    false,
                );
                assert!((*session.0).host.is_some());
            }
            check_error(
                &import_begin_json(&session, -1, &selection),
                "import_invalid_source",
                false,
            );
            let directory = std::fs::File::open(&fixture.parent).unwrap();
            check_error(
                &import_begin_json(&session, directory.as_raw_fd(), &selection),
                "import_invalid_source",
                false,
            );
            assert!(directory.metadata().unwrap().is_dir());
            let (socket, _peer) = std::os::unix::net::UnixStream::pair().unwrap();
            check_error(
                &import_begin_json(&session, socket.as_raw_fd(), &selection),
                "import_invalid_source",
                false,
            );
            assert!(socket.peer_addr().is_ok());
        }
    }
    #[test]
    #[cfg(unix)]
    fn import_dup_owns_only_duplicate_and_positional_reads_preserve_caller_cursor() {
        use std::io::{Seek, SeekFrom};
        use std::os::fd::AsRawFd;
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_local();
            let mut selection = import_selection(&session, CLIENT);
            let path = fixture.parent.join("import-source");
            std::fs::write(&path, b"a").unwrap();
            let mut file = std::fs::File::open(&path).unwrap();
            file.seek(SeekFrom::Start(1)).unwrap();
            check_error(
                &import_begin_json(&session, file.as_raw_fd(), &selection),
                "client_not_admitted",
                false,
            );
            let claim = request_json(
                &session,
                json!({"method":"claim_client","client_id":CLIENT}),
            );
            assert_eq!(claim["ok"], true);
            selection = import_selection(
                &session,
                claim["result"]["lease"]["token"].as_str().unwrap(),
            );
            let begin = import_begin_json(&session, file.as_raw_fd(), &selection);
            assert_eq!(begin["ok"], true);
            assert_eq!(import_step_json(&session)["result"]["state"], "receiving");
            assert_eq!(file.stream_position().unwrap(), 1);
            assert_eq!(file.metadata().unwrap().len(), 1);
            drop(file); // Host's duplicate continues, even after caller closes original.
            let mut last = Value::Null;
            for _ in 0..10 {
                last = import_step_json(&session);
                if last["result"]["state"] == "committed" {
                    break;
                }
            }
            assert_eq!(last["result"]["state"], "committed");
            assert_eq!(last["result"]["canRetryCollision"], false);
            assert_eq!(std::fs::read(fixture.root.join("x.bin")).unwrap(), b"a");
            let encoded = serde_json::to_string(&last).unwrap();
            assert!(!encoded.contains(fixture.parent.to_str().unwrap()));
            assert!(encoded.len() <= MAX_IMPORT_RESULT_BYTES);
        }
    }
    #[test]
    #[cfg(unix)]
    fn import_lease_release_and_reclaim_reject_old_job_and_bad_json_stays_nonterminal() {
        use std::os::fd::AsRawFd;
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_local();
            let mut selection = import_selection(&session, CLIENT);
            let claim = request_json(
                &session,
                json!({"method":"claim_client","client_id":CLIENT}),
            );
            selection = import_selection(
                &session,
                claim["result"]["lease"]["token"].as_str().unwrap(),
            );
            let path = fixture.parent.join("import-source");
            std::fs::write(&path, b"a").unwrap();
            let file = std::fs::File::open(path).unwrap();
            assert_eq!(
                import_begin_json(&session, file.as_raw_fd(), &selection)["ok"],
                true
            );
            check_error(
                &consume_json(zorid_mobile_import_begin(
                    session.0,
                    file.as_raw_fd(),
                    ptr::null(),
                    100,
                )),
                "import_invalid_selection",
                false,
            );
            check_error(
                &import_begin_json(
                    &session,
                    file.as_raw_fd(),
                    b"{\"sourcePath\":\"secret-sentinel\"}",
                ),
                "import_invalid_selection",
                false,
            );
            assert_eq!(
                request_json(
                    &session,
                    json!({"method":"release_client","reference":claim["result"]["lease"]})
                )["ok"],
                true
            );
            check_error(&import_step_json(&session), "client_not_admitted", false);
            let acquired = request_json(
                &session,
                json!({"method":"claim_client","client_id":CLIENT}),
            );
            assert_eq!(acquired["ok"], true);
            selection = import_selection(
                &session,
                acquired["result"]["lease"]["token"].as_str().unwrap(),
            );
            check_error(&import_step_json(&session), "client_not_admitted", false);
            assert!((*session.0).host.is_some());
        }
    }
    #[test]
    #[cfg(unix)]
    fn import_panic_fences_host_and_releases_admission_without_erasing_plan() {
        use std::os::fd::AsRawFd;
        let fixture = DisposableFixture::new();
        unsafe {
            let session = fixture.open_local();
            let mut selection = import_selection(&session, CLIENT);
            let acquired = request_json(
                &session,
                json!({"method":"claim_client","client_id":CLIENT}),
            );
            assert_eq!(acquired["ok"], true);
            selection = import_selection(
                &session,
                acquired["result"]["lease"]["token"].as_str().unwrap(),
            );
            let path = fixture.parent.join("import-source");
            std::fs::write(&path, b"a").unwrap();
            let file = std::fs::File::open(path).unwrap();
            assert_eq!(
                import_begin_json(&session, file.as_raw_fd(), &selection)["ok"],
                true
            );
            let result = (*session.0).guarded_request(|_| panic!("injected import failure"));
            assert!(result.data.is_null());
            assert!((*session.0).host.is_none());
            let reopened = fixture.open_local();
            let reacquired = request_json(
                &reopened,
                json!({"method":"claim_client","client_id":CLIENT}),
            );
            assert_eq!(reacquired["ok"], true);
            selection = import_selection(
                &reopened,
                reacquired["result"]["lease"]["token"].as_str().unwrap(),
            );
            assert_eq!(
                import_begin_json(&reopened, file.as_raw_fd(), &selection)["ok"],
                true
            );
        }
    }
    #[test]
    fn import_error_envelope_strips_shared_message_and_unknown_payloads() {
        let bytes = import_reply(Err(
            json!({"code":"filesystem_changed","commit_uncertain":false,
            "message":"secret-sentinel","path":"private-sentinel"}),
        ))
        .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value["error"],
            json!({"code":"filesystem_changed","commit_uncertain":false})
        );
        assert!(!String::from_utf8(bytes).unwrap().contains("sentinel"));
        let bytes = import_reply(Err(json!({"code":"private-sentinel"}))).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            value["error"],
            json!({"code":"import_error","commit_uncertain":true})
        );
    }
}
