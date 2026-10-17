//! Deliberately unindexed committed-content search, with bounded content reads/output.
use super::{Failure, Result};
use serde_json::{json, Value};
use zorid_core::EntryKind;
use zorid_native::NativeVault;

pub fn run(vault: &NativeVault, query: &str, limit: usize, max_bytes: u64) -> Result<Value> {
    if query.is_empty() || query.len() > 4096 || query.contains(['\r', '\n']) {
        return Err(Failure::new(
            "invalid_query",
            "Search needs a nonempty single-line literal of at most 4096 UTF-8 bytes",
            2,
        ));
    }
    let mut matches = Vec::new();
    let mut searched = 0_u64;
    let mut skipped_binary = 0_u64;
    let mut skipped_changed = 0_u64;
    let mut scanned_bytes = 0_u64;
    let mut truncated = false;
    // Enumeration is a point-in-time identity set. Each subsequent read is its
    // own coherent committed revision, not a claim of one cross-file snapshot.
    let snapshot = vault.list_snapshot()?;
    let mut rows = snapshot.entries;
    rows.sort_by(|a, b| a.state.path.cmp(&b.state.path));
    for listed in rows.iter().filter(|row| row.state.kind == EntryKind::File) {
        if matches.len() >= limit || listed.presentation.size_bytes > max_bytes - scanned_bytes {
            truncated = true;
            break;
        }
        let Some(current) = vault.read_presented(&listed.state.id)? else {
            skipped_changed += 1;
            continue;
        };
        if current.state.kind != EntryKind::File || current.state.deleted {
            skipped_changed += 1;
            continue;
        }
        let Some(bytes) = current.content else {
            skipped_changed += 1;
            continue;
        };
        if bytes.len() as u64 > max_bytes - scanned_bytes {
            truncated = true;
            break;
        }
        scanned_bytes += bytes.len() as u64;
        let Ok(text) = std::str::from_utf8(&bytes) else {
            skipped_binary += 1;
            continue;
        };
        if text.contains('\0') {
            skipped_binary += 1;
            continue;
        }
        searched += 1;
        for (index, line) in text.lines().enumerate() {
            if let Some(offset) = line.find(query) {
                if matches.len() >= limit {
                    truncated = true;
                    break;
                }
                // Output is at most 512 Unicode scalar values per matching line.
                let start = line[..offset]
                    .char_indices()
                    .rev()
                    .nth(80)
                    .map(|(byte, _)| byte)
                    .unwrap_or(0);
                let snippet: String = line[start..].chars().take(512).collect();
                matches.push(
                    json!({"entry_id":current.state.id,"path":current.state.path,
                    "revision":current.state.revision,"line":index+1,"match_byte_offset":offset,
                    "snippet":snippet,"snippet_truncated":start>0||snippet.len()<line.len()}),
                );
            }
        }
        if truncated {
            break;
        }
    }
    Ok(
        json!({"matches":matches,"searched_files":searched,"skipped_binary":skipped_binary,
        "skipped_changed":skipped_changed,"scanned_bytes":scanned_bytes,"truncated":truncated,
        "complete":!truncated&&skipped_changed==0,"max_total_bytes":max_bytes,"limit":limit,
        "consistency":"committed_per_entry","synced":false}),
    )
}
