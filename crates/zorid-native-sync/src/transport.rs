use super::{credentials::Credentials, error, Result};
use std::{
    sync::mpsc::{self, Receiver, SyncSender},
    thread::{self, JoinHandle},
    time::Duration,
};
use tonic::{metadata::MetadataValue, transport::Channel, Code, Request, Status};
use zorid_client_sync::ReceiveCursor;
use zorid_sync_protocol::{
    rpc::{self, pb},
    transport::Page,
    Cursor, LogPosition, UpdateId, MAX_WIRE_BYTES,
};
use zorid_sync_rpc::relay_service_client::RelayServiceClient;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
type Client = RelayServiceClient<Channel>;

type Reply<T> = SyncSender<Result<T>>;
enum Command {
    Hello(Request<pb::HelloRequest>, Reply<pb::HelloReply>),
    Append(Request<pb::AppendRequest>, Reply<pb::AcceptedReply>),
    Pull(Request<pb::PullRequest>, Reply<pb::PullReply>),
}

/// One channel and current-thread runtime per bounded sweep. The runtime is
/// created, driven and dropped on its own thread, including when a synchronous
/// host invokes us from inside an existing Tokio runtime. No detached tasks,
/// unbounded command queue, credentials cache or automatic RPC retry.
pub(super) struct Relay<'a> {
    commands: Option<SyncSender<Command>>,
    worker: Option<JoinHandle<()>>,
    credentials: &'a Credentials,
}
impl<'a> Relay<'a> {
    pub fn connect(credentials: &'a Credentials) -> Result<Self> {
        let (commands, receiver) = mpsc::sync_channel(1);
        let (ready, connected) = mpsc::sync_channel(1);
        let endpoint = credentials.endpoint.as_str().to_owned();
        let worker = thread::Builder::new()
            .name("zorid-sync-rpc".into())
            .spawn(move || run(endpoint, receiver, ready))
            .map_err(|_| error("sync_transport"))?;
        let relay = Self {
            commands: Some(commands),
            worker: Some(worker),
            credentials,
        };
        connected.recv().map_err(|_| error("sync_transport"))??;
        let reply = relay.call(|reply| Command::Hello(request(rpc::hello_request()), reply))?;
        rpc::validate_hello_reply(&reply, &credentials.realm, &credentials.server_epoch)
            .map_err(|e| error(e.code()))?;
        Ok(relay)
    }
    fn call<T>(&self, command: impl FnOnce(Reply<T>) -> Command) -> Result<T> {
        let (reply, receiver) = mpsc::sync_channel(1);
        // Reject overload instead of waiting on an unbounded work queue. Each
        // call waits for its own bounded reply; only the worker drives the RPC.
        self.commands
            .as_ref()
            .ok_or_else(|| error("sync_transport"))?
            .try_send(command(reply))
            .map_err(|_| error("sync_transport"))?;
        receiver.recv().map_err(|_| error("sync_transport"))?
    }
    fn authorized<T>(&self, body: T) -> Result<Request<T>> {
        let mut request = request(body);
        let mut token: MetadataValue<_> = format!("Bearer {}", &*self.credentials.token)
            .parse()
            .map_err(|_| error("credentials_invalid"))?;
        token.set_sensitive(true);
        request.metadata_mut().insert("authorization", token);
        Ok(request)
    }
    pub fn push(&self, update: &UpdateId, wire: &[u8]) -> Result<()> {
        if wire.len() > MAX_WIRE_BYTES {
            return Err(error("sync_limit"));
        }
        let body = rpc::append_request(&self.credentials.vault, update, wire.to_vec())
            .map_err(|e| error(e.code()))?;
        let request = self.authorized(body)?;
        let reply = self.call(|reply| Command::Append(request, reply))?;
        rpc::validate_accepted_reply(
            reply,
            &self.credentials.vault,
            update,
            &self.credentials.server_epoch,
        )
        .map_err(|e| error(e.code()))?;
        Ok(())
    }
    pub fn pull(&self, cursor: &ReceiveCursor, through: Option<LogPosition>) -> Result<Page> {
        let cursor = Cursor::new(cursor.server_epoch.clone(), cursor.after);
        let body = rpc::pull_request(&self.credentials.vault, &cursor, through, rpc::MAX_ITEMS)
            .map_err(|e| error(e.code()))?;
        let request = self.authorized(body)?;
        let reply = self.call(|reply| Command::Pull(request, reply))?;
        rpc::validate_pull_reply(reply, &cursor, through).map_err(|e| error(e.code()))
    }
}
impl Drop for Relay<'_> {
    fn drop(&mut self) {
        // Closing the only sender releases a worker waiting between calls. An
        // active request is deadline bounded; join also ensures runtime/channel
        // destruction never occurs in the caller's async runtime.
        self.commands.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn request<T>(body: T) -> Request<T> {
    let mut request = Request::new(body);
    request.set_timeout(REQUEST_TIMEOUT);
    request
}
fn run(endpoint: String, commands: Receiver<Command>, ready: Reply<()>) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(_) => {
            let _ = ready.send(Err(error("sync_transport")));
            return;
        }
    };
    let endpoint = match Channel::from_shared(endpoint) {
        Ok(endpoint) => endpoint
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .buffer_size(1)
            .concurrency_limit(1)
            .http2_max_header_list_size(16 * 1024),
        Err(_) => {
            let _ = ready.send(Err(error("sync_transport")));
            return;
        }
    };
    // Direct literal-loopback HTTP/2 connection. Tonic does not use HTTP proxy
    // environment variables, follow redirects or retry unary requests. No
    // compression features/encodings are enabled on this generated client.
    let channel = match runtime
        .block_on(async { tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect()).await })
    {
        Ok(Ok(channel)) => channel,
        _ => {
            let _ = ready.send(Err(error("sync_transport")));
            return;
        }
    };
    let client = Client::new(channel);
    if ready.send(Ok(())).is_err() {
        return;
    }
    while let Ok(command) = commands.recv() {
        match command {
            Command::Hello(request, reply) => {
                let mut client = client
                    .clone()
                    .max_encoding_message_size(rpc::MAX_CONTROL_BYTES)
                    .max_decoding_message_size(rpc::MAX_CONTROL_BYTES);
                let result = runtime.block_on(async {
                    tokio::time::timeout(REQUEST_TIMEOUT, client.hello(request))
                        .await
                        .map_err(|_| error("sync_transport"))?
                        .map(|r| r.into_inner())
                        .map_err(status)
                });
                let _ = reply.send(result);
            }
            Command::Append(request, reply) => {
                let mut client = client
                    .clone()
                    .max_encoding_message_size(rpc::MAX_APPEND_MESSAGE)
                    .max_decoding_message_size(rpc::MAX_CONTROL_BYTES);
                let result = runtime.block_on(async {
                    tokio::time::timeout(REQUEST_TIMEOUT, client.append(request))
                        .await
                        .map_err(|_| error("sync_transport"))?
                        .map(|r| r.into_inner())
                        .map_err(status)
                });
                let _ = reply.send(result);
            }
            Command::Pull(request, reply) => {
                let mut client = client
                    .clone()
                    .max_encoding_message_size(rpc::MAX_CONTROL_BYTES)
                    .max_decoding_message_size(rpc::MAX_PULL_MESSAGE);
                let result = runtime.block_on(async {
                    tokio::time::timeout(REQUEST_TIMEOUT, client.pull(request))
                        .await
                        .map_err(|_| error("sync_transport"))?
                        .map(|r| r.into_inner())
                        .map_err(status)
                });
                let _ = reply.send(result);
            }
        }
    }
}
fn status(status: Status) -> super::Error {
    // Never format remote messages, bodies or metadata. Uncertain Append
    // outcomes retain the exact persisted wire in the existing caller ledger.
    if status.details().len() > rpc::MAX_CONTROL_BYTES {
        return error("sync_response_limit");
    }
    error(match status.code() {
        Code::Unauthenticated | Code::PermissionDenied => "sync_authorization_failed",
        Code::AlreadyExists | Code::Aborted => "sync_relay_conflict",
        Code::ResourceExhausted => "sync_limit",
        // Tonic rejects an oversized declared message before Prost decoding.
        Code::OutOfRange => "sync_response_limit",
        Code::FailedPrecondition => match rpc::decode_error_detail(status.details())
            .ok()
            .and_then(|detail| pb::ErrorCode::try_from(detail.code).ok())
        {
            Some(pb::ErrorCode::EpochMismatch) => "sync_epoch_mismatch",
            Some(pb::ErrorCode::UnsupportedProtocol) => "sync_unsupported_protocol",
            _ => "sync_invalid_response",
        },
        Code::InvalidArgument | Code::Unimplemented | Code::DataLoss => "sync_invalid_response",
        _ => "sync_transport",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_diagnostics_never_escape_and_uncertain_outcomes_remain_retryable() {
        for code in [
            Code::Cancelled,
            Code::DeadlineExceeded,
            Code::Unavailable,
            Code::Unknown,
        ] {
            let error = status(Status::new(code, "secret-sentinel"));
            assert_eq!(error.code(), "sync_transport");
            assert_eq!(error.to_string(), "sync_transport");
        }
        for (code, expected) in [
            (Code::Unauthenticated, "sync_authorization_failed"),
            (Code::PermissionDenied, "sync_authorization_failed"),
            (Code::AlreadyExists, "sync_relay_conflict"),
            (Code::ResourceExhausted, "sync_limit"),
            (Code::OutOfRange, "sync_response_limit"),
            (Code::FailedPrecondition, "sync_invalid_response"),
        ] {
            assert_eq!(
                status(Status::new(code, "secret-sentinel")).code(),
                expected
            );
        }
    }
}
