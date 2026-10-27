//! Disposable-vault prototype: one Rust thread owns the actual embedded core.
//! No Node runtime, localhost server, child host, or renderer-selected roots.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc::{sync_channel, SyncSender},
    Arc, Mutex,
};
use tauri::{Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;
use zorid_desktop_host::EmbeddedHost;

const MAX_HEADER: usize = 1024 * 1024;
const MAX_BODY: usize = 32 * 1024 * 1024;
const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Failure {
    code: &'static str,
    commit_uncertain: bool,
}
fn failure(code: &'static str, uncertain: bool) -> Failure {
    Failure {
        code,
        commit_uncertain: uncertain,
    }
}
type Reply = Result<Value, Failure>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestInput {
    header: String,
    body: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LifecycleAck {
    id: String,
    ok: bool,
}

enum Operation {
    Context,
    Refresh,
    Request(RequestInput),
    Close,
}
struct Job {
    operation: Operation,
    charge: usize,
    reply: oneshot::Sender<Reply>,
}
#[derive(Default)]
struct CloseState {
    ready: bool,
    pending: Option<String>,
    allowed: bool,
}
struct NativeState {
    jobs: SyncSender<Job>,
    queued_bytes: Arc<AtomicUsize>,
    close: Arc<Mutex<CloseState>>,
}
struct BenchmarkState {
    enabled: bool,
    data: PathBuf,
}

const MAX_BENCH_REPORT: usize = 2 * 1024 * 1024;

#[tauri::command]
fn tauri_bench_close(window: WebviewWindow, state: State<'_, BenchmarkState>) -> Reply {
    authorize(&window)?;
    if !state.enabled {
        return Err(failure("benchmark_disabled", false));
    }
    // Ordinary close event only: the registered lifecycle handshake remains
    // responsible for flushing, exact lease release and worker teardown.
    window
        .close()
        .map_err(|_| failure("native_close_failed", false))?;
    Ok(json!({"requested":true}))
}

#[tauri::command]
fn tauri_bench_control(window: WebviewWindow, state: State<'_, BenchmarkState>) -> Reply {
    authorize(&window)?;
    if !state.enabled {
        return Err(failure("benchmark_disabled", false));
    }
    use std::io::Read;
    let file = match std::fs::File::open(state.data.join("control.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(json!({"phase":null}))
        }
        Err(_) => return Err(failure("benchmark_control_unavailable", false)),
    };
    let mut bytes = Vec::new();
    file.take((MAX_BENCH_REPORT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("benchmark_control_unavailable", false))?;
    if bytes.len() > MAX_BENCH_REPORT {
        return Err(failure("benchmark_report_limit", false));
    }
    serde_json::from_slice(&bytes).map_err(|_| failure("benchmark_control_invalid", false))
}

#[tauri::command]
fn tauri_bench_report(
    window: WebviewWindow,
    state: State<'_, BenchmarkState>,
    input: Value,
) -> Reply {
    authorize(&window)?;
    if !state.enabled {
        return Err(failure("benchmark_disabled", false));
    }
    if !input.is_object() {
        return Err(failure("benchmark_report_invalid", false));
    }
    let file_name = match input.get("phase").and_then(Value::as_str) {
        Some("single") => "phase-single.json",
        Some("tabs") => "phase-tabs.json",
        Some("large") => "phase-large.json",
        Some("save") | None => "report.json",
        _ => return Err(failure("benchmark_report_invalid", false)),
    };
    let bytes =
        serde_json::to_vec(&input).map_err(|_| failure("benchmark_report_invalid", false))?;
    if bytes.len() > MAX_BENCH_REPORT {
        return Err(failure("benchmark_report_limit", false));
    }
    let temporary = state
        .data
        .join(format!(".report-{}.tmp", uuid::Uuid::new_v4()));
    use std::io::Write;
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        std::fs::rename(&temporary, state.data.join(file_name))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
        return Err(failure("benchmark_report_write_failed", false));
    }
    Ok(json!({"written":true}))
}

impl NativeState {
    async fn call(&self, operation: Operation, charge: usize) -> Reply {
        self.queued_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                used.checked_add(charge)
                    .filter(|next| *next <= MAX_QUEUED_BYTES)
            })
            .map_err(|_| failure("native_queue_full", false))?;
        let (reply, response) = oneshot::channel();
        if self
            .jobs
            .try_send(Job {
                operation,
                charge,
                reply,
            })
            .is_err()
        {
            self.queued_bytes.fetch_sub(charge, Ordering::AcqRel);
            return Err(failure("native_queue_unavailable", false));
        }
        response
            .await
            .unwrap_or_else(|_| Err(failure("native_worker_lost", true)))
    }
}

fn local_url(url: &tauri::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
}
fn authorize(window: &WebviewWindow) -> Result<(), Failure> {
    if window.label() != "main"
        || !local_url(&window.url().map_err(|_| failure("native_sender", false))?)
    {
        return Err(failure("native_sender", false));
    }
    Ok(())
}

#[tauri::command]
async fn tauri_context(window: WebviewWindow, state: State<'_, NativeState>) -> Reply {
    authorize(&window)?;
    state.call(Operation::Context, 0).await
}
#[tauri::command]
async fn tauri_refresh(window: WebviewWindow, state: State<'_, NativeState>) -> Reply {
    authorize(&window)?;
    state.call(Operation::Refresh, 0).await
}
#[tauri::command]
async fn tauri_request(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: RequestInput,
) -> Reply {
    authorize(&window)?;
    if input.header.len() > MAX_HEADER || input.body.len() > MAX_BODY.div_ceil(3) * 4 {
        return Err(failure("native_frame_limit", false));
    }
    let charge = input.header.len() + input.body.len();
    state.call(Operation::Request(input), charge).await
}
#[tauri::command]
fn tauri_lifecycle_ready(
    window: WebviewWindow,
    state: State<'_, NativeState>,
) -> Result<(), Failure> {
    authorize(&window)?;
    state
        .close
        .lock()
        .map_err(|_| failure("native_close_state", false))?
        .ready = true;
    Ok(())
}
#[tauri::command]
async fn tauri_lifecycle_ack(
    window: WebviewWindow,
    state: State<'_, NativeState>,
    input: LifecycleAck,
) -> Reply {
    authorize(&window)?;
    {
        let mut close = state
            .close
            .lock()
            .map_err(|_| failure("native_close_state", false))?;
        if close.pending.as_deref() != Some(input.id.as_str()) {
            return Err(failure("native_close_token", false));
        }
        if !input.ok {
            close.pending = None;
            return Ok(json!({"closed":false}));
        }
    }
    // FIFO worker ownership drains all previously admitted requests, releases
    // the exact captured core lease and drops the core before native close.
    match state.call(Operation::Close, 0).await {
        Ok(_) => {
            state
                .close
                .lock()
                .map_err(|_| failure("native_close_state", true))?
                .allowed = true;
            window
                .close()
                .map_err(|_| failure("native_close_failed", true))?;
            Ok(json!({"closed":true}))
        }
        Err(error) => {
            state
                .close
                .lock()
                .map_err(|_| failure("native_close_state", true))?
                .pending = None;
            Err(error)
        }
    }
}

fn encode_frame(header: &[u8], body: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(8 + header.len() + body.len());
    frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(header);
    frame.extend_from_slice(body);
    frame
}
fn decode_frame(bytes: &[u8]) -> Result<(&str, &[u8]), Failure> {
    if bytes.len() < 8 {
        return Err(failure("native_response_invalid", true));
    }
    let header_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    let body_len = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if header_len > MAX_HEADER || body_len > MAX_BODY || bytes.len() != 8 + header_len + body_len {
        return Err(failure("native_response_invalid", true));
    }
    let header = std::str::from_utf8(&bytes[8..8 + header_len])
        .map_err(|_| failure("native_response_invalid", true))?;
    Ok((header, &bytes[8 + header_len..]))
}

fn dispatch(
    host: &mut EmbeddedHost,
    input: RequestInput,
    client_id: &str,
    lease: &mut Option<Value>,
) -> Reply {
    let header: Value = serde_json::from_str(&input.header)
        .map_err(|_| failure("native_request_invalid", false))?;
    let command = header
        .get("command")
        .and_then(Value::as_object)
        .ok_or_else(|| failure("native_request_invalid", false))?;
    let method = command
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| failure("native_request_invalid", false))?;
    if method == "claim_client"
        && command.get("client_id").and_then(Value::as_str) != Some(client_id)
    {
        return Err(failure("native_client_mismatch", false));
    }
    let body = STANDARD
        .decode(&input.body)
        .map_err(|_| failure("native_request_invalid", false))?;
    let body_limit = if method.starts_with("checkpoint_") {
        MAX_BODY
    } else {
        16 * 1024 * 1024
    };
    if body.len() > body_limit {
        return Err(failure("native_frame_limit", false));
    }
    let frame = encode_frame(input.header.as_bytes(), &body);
    let reply = host
        .dispatch(&frame)
        .map_err(|_| failure("native_dispatch_failed", true))?;
    let (response_header, response_body) = decode_frame(&reply)?;
    let response: Value = serde_json::from_str(response_header)
        .map_err(|_| failure("native_response_invalid", true))?;
    if response.get("version") != Some(&json!(1))
        || response.get("request_id") != header.get("request_id")
        || !response.get("ok").is_some_and(Value::is_boolean)
    {
        return Err(failure("native_response_invalid", true));
    }
    if response.get("ok") == Some(&Value::Bool(true)) {
        if method == "claim_client" {
            let claimed = &response["result"]["lease"];
            if claimed.get("client_id").and_then(Value::as_str) != Some(client_id)
                || claimed.get("token").and_then(Value::as_str).is_none()
                || claimed
                    .get("local_store_id")
                    .and_then(Value::as_str)
                    .is_none()
            {
                return Err(failure("native_response_invalid", true));
            }
            *lease = Some(claimed.clone());
        } else if method == "release_client" && response["result"]["released"] == true {
            if lease.as_ref() == Some(&response["result"]["reference"]) {
                *lease = None;
            }
        }
    }
    Ok(json!({"header":response_header,"body":STANDARD.encode(response_body)}))
}

fn release_and_close(host: &mut EmbeddedHost, lease: &mut Option<Value>, client_id: &str) -> Reply {
    if let Some(reference) = lease.clone() {
        let header = json!({"version":1,"request_id":"18446744073709551614",
            "command":{"method":"release_client","reference":reference}})
        .to_string();
        let response = dispatch(
            host,
            RequestInput {
                header,
                body: String::new(),
            },
            client_id,
            lease,
        )?;
        let envelope: Value = serde_json::from_str(response["header"].as_str().unwrap())
            .map_err(|_| failure("native_release_failed", true))?;
        if envelope["ok"] != true
            || envelope["result"]["released"] != true
            || envelope["result"]["reference"] != reference
            || lease.is_some()
        {
            return Err(failure("native_release_failed", true));
        }
    }
    Ok(json!({"released":true}))
}

fn trusted_paths() -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    // Scope is deliberately restricted to agent-created disposable fixtures.
    let root = std::fs::canonicalize(std::env::var("ZORID_NATIVE_VAULT")?)?;
    let data = PathBuf::from(std::env::var("ZORID_NATIVE_DATA")?);
    std::fs::create_dir_all(&data)?;
    let data = std::fs::canonicalize(data)?;
    for path in [&root, &data] {
        if !path.starts_with(Path::new("/private/tmp"))
            || !path.to_string_lossy().contains("zorid-tauri-native-")
        {
            return Err(
                "Native prototype requires disposable /private/tmp/zorid-tauri-native-* roots"
                    .into(),
            );
        }
    }
    Ok((root, data))
}
fn client_id(data: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let path = data.join("native-client-id");
    if let Ok(value) = std::fs::read_to_string(&path) {
        return Ok(uuid::Uuid::parse_str(value.trim())?.to_string());
    }
    let value = uuid::Uuid::new_v4().to_string();
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()?;
    Ok(value)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (root, data) = trusted_paths()?;
    let benchmark_data = data.clone();
    let client = client_id(&data)?;
    let name = root.file_name().unwrap().to_string_lossy().into_owned();
    let (jobs, receiver) = sync_channel::<Job>(32);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let worker_bytes = queued_bytes.clone();
    let close = Arc::new(Mutex::new(CloseState::default()));
    let worker = std::thread::Builder::new()
        .name("zorid-embedded-core".into())
        .spawn(move || {
            // Opening, all dispatches, lease release, and dropping the SQLite owner
            // happen on this one dedicated native thread.
            let mut host = EmbeddedHost::open_local_with_data_root(&root, &data).ok();
            let mut lease = None;
            while let Ok(job) = receiver.recv() {
                let closing = matches!(&job.operation, Operation::Close);
                let result = match host.as_mut() {
                    None => Err(failure("native_core_unavailable", false)),
                    Some(core) => match job.operation {
                        Operation::Context => Ok(json!({"name":name,"clientId":client,
                        "reconciliation":core.reconciliation(),"documentSemantics":true})),
                        Operation::Refresh => core
                            .refresh_local()
                            .map(|reconciliation| json!({"reconciliation":reconciliation}))
                            .map_err(|_| failure("native_refresh_failed", false)),
                        Operation::Request(input) => dispatch(core, input, &client, &mut lease),
                        Operation::Close => release_and_close(core, &mut lease, &client),
                    },
                };
                let terminal = result.as_ref().is_err_and(|error| error.commit_uncertain);
                let closed = closing && result.is_ok();
                if terminal || closed {
                    host.take();
                }
                worker_bytes.fetch_sub(job.charge, Ordering::AcqRel);
                let _ = job.reply.send(result);
                if closed {
                    break;
                }
            }
        })?;
    let event_close = close.clone();
    let native_bench = std::env::var("ZORID_NATIVE_BENCH").as_deref() == Ok("1");
    let init = format!(
        "window.__ZORID_TAURI__ = true; window.__ZORID_NATIVE_BENCH_ENABLED__ = {native_bench};"
    );
    let app = tauri::Builder::default()
        .manage(BenchmarkState {
            enabled: native_bench,
            data: benchmark_data,
        })
        .manage(NativeState {
            jobs,
            queued_bytes,
            close,
        })
        .invoke_handler(tauri::generate_handler![
            tauri_context,
            tauri_refresh,
            tauri_request,
            tauri_lifecycle_ready,
            tauri_lifecycle_ack,
            tauri_bench_control,
            tauri_bench_report,
            tauri_bench_close
        ])
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Zorid Native Tauri Prototype — disposable fixtures")
            .inner_size(1280.0, 870.0)
            .min_inner_size(640.0, 480.0)
            .initialization_script(&init)
            .on_navigation(local_url)
            .focused(true)
            .build()?;
            window.show()?;
            window.set_focus()?;
            Ok(())
        })
        .on_window_event(move |window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let Ok(mut close) = event_close.lock() else {
                    api.prevent_close();
                    return;
                };
                if close.allowed {
                    return;
                }
                api.prevent_close();
                if !close.ready || close.pending.is_some() {
                    return;
                }
                let id = uuid::Uuid::new_v4().to_string();
                close.pending = Some(id.clone());
                if window
                    .emit("tauri:lifecycle", json!({"id":id,"reason":"switchVault"}))
                    .is_err()
                {
                    close.pending = None;
                }
            }
        })
        .build(tauri::generate_context!())?;
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app.state::<NativeState>();
            let allowed = state
                .close
                .lock()
                .map(|close| close.allowed)
                .unwrap_or(false);
            if !allowed {
                api.prevent_exit();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.close();
                }
            }
        }
    });
    // Successful close sends the worker its final FIFO message before exit.
    let _ = worker.join();
    Ok(())
}
