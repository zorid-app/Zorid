//! Device-local retained note history. No write/restore, path selection or SQL
//! is exposed here: restoration uses the editor's ordinary durable-save path.
use super::{fault, native_fault, MAX_BODY};
use serde::Deserialize;
use serde_json::{json, Value};
use zorid_core::EntryId;
use zorid_native::{LocalRecoveryCursor, LocalRecoveryVersion, NativeVault};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_PAGE: usize = 100;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Cursor {
    captured_at_ms: i64,
    snapshot_id: String,
}

fn snapshot_id(value: &str) -> Result<i64, Value> {
    if value.is_empty()
        || value.len() > 19
        || value.starts_with('0')
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(fault("invalid_request"));
    }
    value
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| fault("invalid_request"))
}

fn history_fault(error: zorid_native::Error) -> Value {
    match error {
        zorid_native::Error::Unsupported(_) => fault("local_recovery_unavailable"),
        other => native_fault(other),
    }
}

fn metadata(version: &LocalRecoveryVersion) -> Result<Value, Value> {
    if version.id <= 0
        || !(0..=MAX_SAFE_INTEGER).contains(&version.captured_at_ms)
        || version.byte_length > MAX_BODY
    {
        return Err(fault("local_recovery_unavailable"));
    }
    Ok(json!({
        "snapshotId": version.id.to_string(),
        "entryId": version.entry_id,
        "path": version.historical_path,
        "capturedAtMs": version.captured_at_ms,
        "byteLength": version.byte_length,
    }))
}

pub(crate) fn list(
    vault: &NativeVault,
    entry: &EntryId,
    limit: usize,
    before: Option<Cursor>,
) -> Result<(Value, Vec<u8>), Value> {
    if limit == 0 || limit > MAX_PAGE {
        return Err(fault("invalid_request"));
    }
    let before = before
        .map(|cursor| {
            if !(0..=MAX_SAFE_INTEGER).contains(&cursor.captured_at_ms) {
                return Err(fault("invalid_request"));
            }
            Ok(LocalRecoveryCursor {
                captured_at_ms: cursor.captured_at_ms,
                id: snapshot_id(&cursor.snapshot_id)?,
            })
        })
        .transpose()?;
    let versions = vault
        .list_local_recovery(entry, before, limit)
        .map_err(history_fault)?;
    let next = if versions.len() == limit {
        versions.last().map(|version| {
            json!({
                "captured_at_ms": version.captured_at_ms,
                "snapshot_id": version.id.to_string(),
            })
        })
    } else {
        None
    };
    let versions = versions
        .iter()
        .map(metadata)
        .collect::<Result<Vec<_>, _>>()?;
    let mut result = json!({"versions": versions});
    if let Some(cursor) = next {
        result["nextCursor"] = cursor;
    }
    Ok((result, Vec::new()))
}

pub(crate) fn read(
    vault: &NativeVault,
    entry: &EntryId,
    id: &str,
) -> Result<(Value, Vec<u8>), Value> {
    let id = snapshot_id(id)?;
    let snapshot = vault
        .read_local_recovery(entry, id)
        .map_err(history_fault)?
        .ok_or_else(|| fault("not_found"))?;
    let metadata = metadata(&snapshot.info)?;
    Ok((json!({"version": metadata}), snapshot.content))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{local_recovery_path, now_ms, write_frame, EmbeddedHost};
    use zorid_recovery::{RecoveryScope, RecoveryStore, SnapshotInput, SnapshotProvenance};

    fn request(host: &mut EmbeddedHost, command: Value, body: &[u8]) -> (Value, Vec<u8>) {
        let request = json!({"version":1,"request_id":"1","command":command});
        serde_json::from_value::<crate::Request>(request.clone())
            .unwrap_or_else(|error| panic!("invalid test request {request}: {error}"));
        let mut frame = Vec::new();
        write_frame(&mut frame, &request, body).unwrap();
        let response = host
            .dispatch(&frame)
            .unwrap_or_else(|error| panic!("test request dispatch {request}: {error}"));
        // read_frame is intentionally a request-only decoder: it validates
        // Command before body admission and must reject response-shaped JSON.
        assert!(response.len() >= 8);
        let header_len = u32::from_be_bytes(response[..4].try_into().unwrap()) as usize;
        let body_len = u32::from_be_bytes(response[4..8].try_into().unwrap()) as usize;
        assert_eq!(response.len(), 8 + header_len + body_len);
        (
            serde_json::from_slice(&response[8..8 + header_len]).unwrap(),
            response[8 + header_len..].to_vec(),
        )
    }

    #[test]
    fn history_wire_pages_metadata_and_returns_only_entry_scoped_exact_content() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("Note.md"), b"current\r\n").unwrap();
        std::fs::write(root.path().join("Other.md"), b"other secret").unwrap();
        let mut host = EmbeddedHost::open_local_with_data_root(root.path(), data.path()).unwrap();
        let entry = host
            .vault
            .read_path(&zorid_core::VaultPath::new("Note.md").unwrap())
            .unwrap()
            .unwrap()
            .state
            .id;
        let other = host
            .vault
            .read_path(&zorid_core::VaultPath::new("Other.md").unwrap())
            .unwrap()
            .unwrap()
            .state
            .id;
        let authority = host.vault.identity().unwrap().local_store_id;
        let path = local_recovery_path(root.path(), data.path(), &authority).unwrap();
        let mut history = RecoveryStore::open(
            path,
            &RecoveryScope {
                vault_id: authority.as_str().into(),
                replica_id: "native-local".into(),
            },
            now_ms(),
        )
        .unwrap();
        let bytes = b"\xef\xbb\xbfrecoverable\r\n";
        for (offset, content) in [(1, b"earlier".as_slice()), (2, bytes.as_slice())] {
            history
                .capture(
                    SnapshotInput {
                        entry_id: entry.as_str(),
                        historical_path: "Earlier name.md",
                        content,
                        provenance: SnapshotProvenance::SaveFailure,
                    },
                    now_ms() + offset,
                )
                .unwrap();
        }
        let foreign_id = history.list(other.as_str(), None, 1).unwrap()[0].id;
        drop(history);
        let source_before = host.vault.read(&entry).unwrap().unwrap();
        let (first, body) = request(
            &mut host,
            json!({"method":"recovery_list","entry_id":entry,"limit":1}),
            &[],
        );
        assert_eq!(first["ok"], true);
        assert!(body.is_empty());
        let version = &first["result"]["versions"][0];
        assert!(version["snapshotId"].is_string());
        assert_eq!(version["entryId"], entry.as_str());
        assert_eq!(version["path"], "Earlier name.md");
        assert_eq!(version["byteLength"], bytes.len());
        let snapshot_id = version["snapshotId"].as_str().unwrap();
        let (read, body) = request(
            &mut host,
            json!({"method":"recovery_read","entry_id":entry,"snapshot_id":snapshot_id}),
            &[],
        );
        assert_eq!(read["ok"], true);
        assert_eq!(read["result"]["version"], *version);
        assert_eq!(body, bytes);
        let (second, body) = request(
            &mut host,
            json!({"method":"recovery_list","entry_id":entry,"limit":100,"before":first["result"]["nextCursor"]}),
            &[],
        );
        assert!(body.is_empty());
        assert_eq!(second["result"]["versions"].as_array().unwrap().len(), 2);
        assert!(second["result"].get("nextCursor").is_none());
        for id in [foreign_id.to_string(), i64::MAX.to_string()] {
            let (rejected, body) = request(
                &mut host,
                json!({"method":"recovery_read","entry_id":entry,"snapshot_id":id}),
                &[],
            );
            assert_eq!(rejected["error"]["code"], "not_found");
            assert!(body.is_empty());
            assert!(!rejected.to_string().contains("other secret"));
        }
        assert_eq!(host.vault.read(&entry).unwrap().unwrap(), source_before);
        assert_eq!(
            std::fs::read(root.path().join("Note.md")).unwrap(),
            b"current\r\n"
        );
    }

    #[test]
    fn history_wire_rejects_invalid_limits_ids_cursors_and_request_bodies() {
        let root = tempfile::tempdir().unwrap();
        let mut host = EmbeddedHost::open_local(root.path()).unwrap();
        for limit in [0, 101] {
            let (header, body) = request(
                &mut host,
                json!({"method":"recovery_list","entry_id":"note","limit":limit}),
                &[],
            );
            assert_eq!(header["error"]["code"], "invalid_request");
            assert!(body.is_empty());
        }
        for id in ["", "0", "01", "-1", "+1", "1.0", "9223372036854775808"] {
            let (header, body) = request(
                &mut host,
                json!({"method":"recovery_read","entry_id":"note","snapshot_id":id}),
                &[],
            );
            assert_eq!(header["error"]["code"], "invalid_request");
            assert!(body.is_empty());
        }
        for cursor in [
            json!({"captured_at_ms":-1,"snapshot_id":"1"}),
            json!({"captured_at_ms":MAX_SAFE_INTEGER + 1,"snapshot_id":"1"}),
            json!({"captured_at_ms":0,"snapshot_id":"01"}),
        ] {
            let (header, body) = request(
                &mut host,
                json!({"method":"recovery_list","entry_id":"note","limit":1,"before":cursor}),
                &[],
            );
            assert_eq!(header["error"]["code"], "invalid_request");
            assert!(body.is_empty());
        }
        for method in [
            json!({"method":"recovery_list","entry_id":"note","limit":1}),
            json!({"method":"recovery_read","entry_id":"note","snapshot_id":"1"}),
        ] {
            let (header, body) = request(&mut host, method.clone(), b"unexpected");
            assert_eq!(header["error"]["code"], "unexpected_body");
            assert!(body.is_empty());
            let (header, body) = request(&mut host, method, &[]);
            assert_eq!(header["error"]["code"], "local_recovery_unavailable");
            assert!(body.is_empty());
        }
    }
}
