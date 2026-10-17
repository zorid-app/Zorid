//! Transport-major 2 protobuf semantics. These are ordinary validated data, not
//! authentication/authorization, relay durability, or local receive capabilities.
//! Callers enforce method/frame and in-flight limits BEFORE generated decoding.
//! Post-decode collection checks below do not bound decoder peak allocations.
use crate::{
    transport::{self, error, Item, Page, TransportError},
    Accepted, Cursor, LogPosition, RealmId, ServerEpoch, UpdateId, VaultId, MAX_WIRE_BYTES,
};
use std::collections::BTreeSet;
pub use zorid_proto::zorid::sync::rpc::v1 as pb;
use zorid_proto::Message;

pub type Error = TransportError;
pub type Result<T> = std::result::Result<T, Error>;
pub const TRANSPORT_MAJOR: u32 = 2;
pub const MAX_CONTROL_BYTES: usize = crate::MAX_CONTROL_BYTES;
pub const MAX_APPEND_MESSAGE: usize = MAX_WIRE_BYTES + MAX_CONTROL_BYTES;
pub const MAX_PULL_MESSAGE: usize = transport::MAX_PAGE_WIRE + 32 * 1024;
pub const MAX_ITEMS: usize = transport::MAX_ITEMS;
pub const MAX_INFLIGHT: usize = 8;
pub const MAX_FEATURES: usize = 16;
pub const MAX_FEATURE_BYTES: usize = 128;
pub const MAX_OPTIONAL_EXTENSIONS: usize = 16;
pub const MAX_EXTENSION_KEY_BYTES: usize = 128;
pub const MAX_EXTENSION_VALUE_BYTES: usize = 512;
pub const HELLO_PATH: &str = "/zorid.sync.rpc.v1.RelayService/Hello";
pub const APPEND_PATH: &str = "/zorid.sync.rpc.v1.RelayService/Append";
pub const PULL_PATH: &str = "/zorid.sync.rpc.v1.RelayService/Pull";

#[derive(Debug)]
pub struct Append {
    pub vault_id: VaultId,
    pub update_id: UpdateId,
    pub exact_wire: Vec<u8>,
}
#[derive(Debug)]
pub struct Pull {
    pub vault_id: VaultId,
    pub cursor: Cursor,
    pub through: Option<LogPosition>,
    pub limit: usize,
}
fn invalid() -> Error {
    error("sync_invalid_response")
}
fn unsupported() -> Error {
    error("sync_unsupported_protocol")
}
fn position(value: u64) -> Result<LogPosition> {
    // The existing relay sequence is a positive SQLite INTEGER (cursor zero is
    // its initial position). Never cast a caller u64 into a negative i64.
    if value > i64::MAX as u64 {
        return Err(invalid());
    }
    Ok(LogPosition::new(value))
}
fn positive(value: Option<u64>) -> Result<LogPosition> {
    let value = value.filter(|v| *v > 0).ok_or_else(invalid)?;
    position(value)
}
fn control(value: Option<&pb::Control>) -> Result<()> {
    let value = value.ok_or_else(invalid)?;
    if value.encoded_len() > MAX_CONTROL_BYTES
        || value.required_features.len() > MAX_FEATURES
        || value.optional_extensions.len() > MAX_OPTIONAL_EXTENSIONS
    {
        return Err(error("sync_response_limit"));
    }
    let mut features = BTreeSet::new();
    for feature in &value.required_features {
        if feature.is_empty()
            || feature.len() > MAX_FEATURE_BYTES
            || !feature
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            || !features.insert(feature)
        {
            return Err(unsupported());
        }
    }
    // Transport 2 baseline needs no feature tokens. Unknown required meaning
    // always rejects, including a merged earlier nonempty feature list.
    if !features.is_empty() {
        return Err(unsupported());
    }
    let mut keys = BTreeSet::new();
    for extension in &value.optional_extensions {
        if extension.key.is_empty()
            || extension.key.len() > MAX_EXTENSION_KEY_BYTES
            || extension.value.len() > MAX_EXTENSION_VALUE_BYTES
            || !keys.insert(&extension.key)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn context(value: Option<&pb::RequestContext>) -> Result<()> {
    let value = value.ok_or_else(invalid)?;
    control(value.control.as_ref())?;
    if value.transport_major.ok_or_else(invalid)? != TRANSPORT_MAJOR {
        return Err(unsupported());
    }
    Ok(())
}
fn reply_context(major: Option<u32>, value: Option<&pb::Control>) -> Result<()> {
    control(value)?;
    if major.ok_or_else(invalid)? != TRANSPORT_MAJOR {
        return Err(unsupported());
    }
    Ok(())
}
fn empty_control() -> pb::Control {
    pb::Control::default()
}
fn request_context() -> pb::RequestContext {
    pb::RequestContext {
        transport_major: Some(TRANSPORT_MAJOR),
        control: Some(empty_control()),
    }
}
fn cursor_from(value: pb::Cursor) -> Result<Cursor> {
    control(value.control.as_ref())?;
    let epoch = ServerEpoch::new(value.server_epoch).map_err(|_| invalid())?;
    Ok(Cursor::new(
        epoch,
        position(value.after.ok_or_else(invalid)?)?,
    ))
}
fn cursor_to(value: &Cursor) -> pb::Cursor {
    pb::Cursor {
        server_epoch: value.server_epoch.as_str().into(),
        after: Some(value.after.get()),
        control: Some(empty_control()),
    }
}
fn decoded<T: Message + Default>(bytes: &[u8], max: usize) -> Result<T> {
    if bytes.len() > max {
        return Err(error("sync_response_limit"));
    }
    T::decode(bytes).map_err(|_| invalid())
}

pub fn hello_request() -> pb::HelloRequest {
    pb::HelloRequest {
        offered_transport_majors: vec![TRANSPORT_MAJOR],
        control: Some(empty_control()),
    }
}
pub fn validate_hello_request(value: &pb::HelloRequest) -> Result<()> {
    control(value.control.as_ref())?;
    if value.encoded_len() > MAX_CONTROL_BYTES {
        return Err(error("sync_response_limit"));
    }
    if value.offered_transport_majors.is_empty()
        || value.offered_transport_majors.len() > 16
        || !value.offered_transport_majors.contains(&TRANSPORT_MAJOR)
    {
        return Err(unsupported());
    }
    Ok(())
}
pub fn hello_reply(realm: &RealmId, epoch: &ServerEpoch) -> pb::HelloReply {
    pb::HelloReply {
        selected_transport_major: Some(TRANSPORT_MAJOR),
        realm_id: realm.as_str().into(),
        server_epoch: epoch.as_str().into(),
        envelope_versions: vec![1],
        suite: "xchacha20poly1305".into(),
        max_wire_bytes: Some(MAX_WIRE_BYTES as u64),
        max_page_wire_bytes: Some(transport::MAX_PAGE_WIRE as u64),
        max_page_items: Some(MAX_ITEMS as u32),
        control: Some(empty_control()),
    }
}
pub fn validate_hello_reply(
    value: &pb::HelloReply,
    realm: &RealmId,
    epoch: &ServerEpoch,
) -> Result<()> {
    reply_context(value.selected_transport_major, value.control.as_ref())?;
    if value.encoded_len() > MAX_CONTROL_BYTES {
        return Err(error("sync_response_limit"));
    }
    let actual_realm = RealmId::new(value.realm_id.clone()).map_err(|_| invalid())?;
    let actual_epoch = ServerEpoch::new(value.server_epoch.clone()).map_err(|_| invalid())?;
    transport::validate_hello_fields(
        &actual_realm,
        &actual_epoch,
        realm,
        epoch,
        &value.envelope_versions,
        &value.suite,
        value.max_wire_bytes.ok_or_else(invalid)?,
        value.max_page_wire_bytes.ok_or_else(invalid)?,
        u64::from(value.max_page_items.ok_or_else(invalid)?),
    )
}
pub fn decode_hello_reply(bytes: &[u8], realm: &RealmId, epoch: &ServerEpoch) -> Result<()> {
    validate_hello_reply(&decoded(bytes, MAX_CONTROL_BYTES)?, realm, epoch)
}

pub fn append_request(
    vault: &VaultId,
    update: &UpdateId,
    exact_wire: Vec<u8>,
) -> Result<pb::AppendRequest> {
    let value = pb::AppendRequest {
        context: Some(request_context()),
        vault_id: vault.as_str().into(),
        update_id: update.as_str().into(),
        exact_wire,
    };
    check_append(&value)?;
    Ok(value)
}
fn check_append(value: &pb::AppendRequest) -> Result<()> {
    context(value.context.as_ref())?;
    if value.exact_wire.is_empty()
        || value.exact_wire.len() > MAX_WIRE_BYTES
        || value.encoded_len() > MAX_APPEND_MESSAGE
    {
        return Err(error("sync_response_limit"));
    }
    Ok(())
}
pub fn validate_append_request(value: pb::AppendRequest) -> Result<Append> {
    check_append(&value)?;
    Ok(Append {
        vault_id: VaultId::new(value.vault_id).map_err(|_| invalid())?,
        update_id: UpdateId::new(value.update_id).map_err(|_| invalid())?,
        exact_wire: value.exact_wire,
    })
}
/// RelayStore-issued receipts have positive i64-backed sequences. This builder
/// preserves them; inbound RPC validation independently rejects out-of-range data.
pub fn accepted_reply(value: &Accepted) -> pb::AcceptedReply {
    pb::AcceptedReply {
        transport_major: Some(TRANSPORT_MAJOR),
        vault_id: value.vault_id().as_str().into(),
        update_id: value.update_id().as_str().into(),
        server_epoch: value.server_epoch().as_str().into(),
        sequence: Some(value.sequence().get()),
        control: Some(empty_control()),
    }
}
pub fn validate_accepted_reply(
    value: pb::AcceptedReply,
    vault: &VaultId,
    update: &UpdateId,
    epoch: &ServerEpoch,
) -> Result<Accepted> {
    reply_context(value.transport_major, value.control.as_ref())?;
    if value.encoded_len() > MAX_CONTROL_BYTES {
        return Err(error("sync_response_limit"));
    }
    let sequence = positive(value.sequence).map_err(|_| error("sync_invalid_ack"))?;
    let accepted = Accepted::new(
        VaultId::new(value.vault_id).map_err(|_| error("sync_invalid_ack"))?,
        UpdateId::new(value.update_id).map_err(|_| error("sync_invalid_ack"))?,
        ServerEpoch::new(value.server_epoch).map_err(|_| error("sync_invalid_ack"))?,
        sequence,
    )
    .map_err(|_| error("sync_invalid_ack"))?;
    transport::validate_accepted(accepted, vault, update, epoch)
}
pub fn decode_accepted_reply(
    bytes: &[u8],
    vault: &VaultId,
    update: &UpdateId,
    epoch: &ServerEpoch,
) -> Result<Accepted> {
    validate_accepted_reply(decoded(bytes, MAX_CONTROL_BYTES)?, vault, update, epoch)
}

pub fn pull_request(
    vault: &VaultId,
    cursor: &Cursor,
    through: Option<LogPosition>,
    limit: usize,
) -> Result<pb::PullRequest> {
    let value = pb::PullRequest {
        context: Some(request_context()),
        vault_id: vault.as_str().into(),
        cursor: Some(cursor_to(cursor)),
        through: through.map(LogPosition::get),
        limit: Some(u32::try_from(limit).map_err(|_| invalid())?),
    };
    check_pull(&value)?;
    Ok(value)
}
fn check_pull(value: &pb::PullRequest) -> Result<()> {
    context(value.context.as_ref())?;
    if value.encoded_len() > MAX_CONTROL_BYTES {
        return Err(error("sync_response_limit"));
    }
    let limit = value.limit.ok_or_else(invalid)?;
    if !(1..=MAX_ITEMS as u32).contains(&limit) {
        return Err(invalid());
    }
    let cursor = value.cursor.as_ref().ok_or_else(invalid)?;
    control(cursor.control.as_ref())?;
    let after = position(cursor.after.ok_or_else(invalid)?)?;
    if let Some(through) = value.through {
        if position(through)? < after {
            return Err(error("sync_invalid_page"));
        }
    }
    Ok(())
}
pub fn validate_pull_request(value: pb::PullRequest) -> Result<Pull> {
    check_pull(&value)?;
    Ok(Pull {
        vault_id: VaultId::new(value.vault_id).map_err(|_| invalid())?,
        cursor: cursor_from(value.cursor.ok_or_else(invalid)?)?,
        through: value.through.map(position).transpose()?,
        limit: value.limit.ok_or_else(invalid)? as usize,
    })
}
pub fn validate_pull_reply(
    value: pb::PullReply,
    cursor: &Cursor,
    through: Option<LogPosition>,
) -> Result<Page> {
    reply_context(value.transport_major, value.control.as_ref())?;
    if value.encoded_len() > MAX_PULL_MESSAGE {
        return Err(error("sync_response_limit"));
    }
    if value.items.len() > MAX_ITEMS {
        return Err(error("sync_invalid_page"));
    }
    let next = cursor_from(value.next.ok_or_else(invalid)?)?;
    let page_through = position(value.through.ok_or_else(invalid)?)?;
    let complete = value.complete.ok_or_else(invalid)?;
    let mut items = Vec::with_capacity(value.items.len());
    for item in value.items {
        if item.exact_wire.is_empty() {
            return Err(error("sync_invalid_envelope"));
        }
        items.push(Item {
            sequence: positive(item.sequence)?,
            wire: item.exact_wire,
        });
    }
    transport::validate_page(items, next, page_through, complete, cursor, through)
}
pub fn decode_pull_reply(
    bytes: &[u8],
    cursor: &Cursor,
    through: Option<LogPosition>,
) -> Result<Page> {
    validate_pull_reply(decoded(bytes, MAX_PULL_MESSAGE)?, cursor, through)
}
pub fn pull_reply(
    items: Vec<(LogPosition, Vec<u8>)>,
    next: &Cursor,
    through: LogPosition,
    complete: bool,
) -> Result<pb::PullReply> {
    if items.len() > MAX_ITEMS
        || items.iter().any(|(sequence, wire)| {
            sequence.get() == 0
                || sequence.get() > i64::MAX as u64
                || wire.is_empty()
                || wire.len() > MAX_WIRE_BYTES
        })
    {
        return Err(error("sync_invalid_page"));
    }
    position(next.after.get())?;
    position(through.get())?;
    let before = match items.first() {
        Some((sequence, _)) => sequence.get().checked_sub(1).ok_or_else(invalid)?,
        None => next.after.get(),
    };
    let cursor = Cursor::new(next.server_epoch.clone(), position(before)?);
    let items = items
        .into_iter()
        .map(|(sequence, wire)| Item { sequence, wire })
        .collect();
    let page = transport::validate_page(
        items,
        Cursor::new(next.server_epoch.clone(), next.after),
        through,
        complete,
        &cursor,
        Some(through),
    )?;
    let value = pb::PullReply {
        transport_major: Some(TRANSPORT_MAJOR),
        items: page
            .items
            .into_iter()
            .map(|item| pb::PullItem {
                sequence: Some(item.sequence.get()),
                exact_wire: item.wire,
            })
            .collect(),
        next: Some(cursor_to(next)),
        through: Some(through.get()),
        complete: Some(complete),
        control: Some(empty_control()),
    };
    if value.encoded_len() > MAX_PULL_MESSAGE {
        return Err(error("sync_response_limit"));
    }
    Ok(value)
}
pub fn decode_error_detail(bytes: &[u8]) -> Result<pb::ErrorDetail> {
    let value: pb::ErrorDetail = decoded(bytes, MAX_CONTROL_BYTES)?;
    match pb::ErrorCode::try_from(value.code) {
        Ok(pb::ErrorCode::Unspecified) | Err(_) => Err(invalid()),
        Ok(_) => Ok(value),
    }
}

#[cfg(test)]
#[path = "rpc_tests.rs"]
mod tests;
