use crate::{IndexError, Manifest};
use percent_encoding::percent_decode_str;
use std::cmp::Ordering;
use unicode_normalization::UnicodeNormalization;
use zorid_core::{EntryId, EntryKind, EntryState};

/// Bump on normalization, priority, segment-boundary or tie-order changes.
pub const RESOLVER_VERSION: &str = "link-nfc-lower-segment-utf16-v1";
const MAX_TARGET_BYTES: usize = 4096;
pub fn normalize_link_key(value: &str) -> String {
    value.nfc().collect::<String>().to_lowercase()
}
fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}
fn name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}
fn external(target: &str) -> bool {
    if target.starts_with("//") {
        return true;
    }
    let Some((scheme, _)) = target.split_once(':') else {
        return false;
    };
    let mut b = scheme.bytes();
    b.next().is_some_and(|c| c.is_ascii_alphabetic())
        && b.all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'+' | b'.' | b'-'))
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|
        '\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn decode_or_literal(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit()
            {
                return value.into();
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    percent_decode_str(value)
        .decode_utf8()
        .map_or_else(|_| value.into(), |s| s.into_owned())
}
fn order(a: &EntryState, b: &EntryState) -> Ordering {
    a.path
        .as_str()
        .encode_utf16()
        .count()
        .cmp(&b.path.as_str().encode_utf16().count())
        .then(a.path.cmp(&b.path))
        .then(a.id.cmp(&b.id))
}
fn suffix_segment(path: &str, target: &str) -> bool {
    path == target
        || path
            .strip_suffix(target)
            .is_some_and(|prefix| prefix.ends_with('/'))
}
fn in_directory(path: &str, directory: &str) -> bool {
    directory.is_empty()
        || path
            .strip_prefix(directory)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
/// Borrowed namespace-only view: no body reads or second authority snapshot.
pub struct Resolver<'a> {
    manifest: &'a Manifest,
    files: Vec<(&'a EntryState, String)>,
}
impl<'a> Resolver<'a> {
    pub fn new(manifest: &'a Manifest) -> Self {
        Self {
            manifest,
            files: manifest
                .entries()
                .iter()
                .filter(|e| e.kind == EntryKind::File)
                .map(|e| (e, normalize_link_key(e.path.as_str())))
                .collect(),
        }
    }
    /// Semantic destination from the document parser: Markdown escapes/entities
    /// have already been normalized by that established parser; percent encoding
    /// remains. Wiki destination is its raw target plus raw fragment. Split the
    /// literal fragment before percent decoding, preserving encoded hash filenames.
    /// Never pass raw CommonMark source here or decode its escapes/entities again.
    pub fn candidates(
        &self,
        source_id: &EntryId,
        destination: &str,
    ) -> Result<Vec<&'a EntryState>, IndexError> {
        if destination.len() > MAX_TARGET_BYTES {
            return Err(IndexError::InvalidTarget);
        }
        let source = self
            .manifest
            .entry(source_id)
            .filter(|e| e.kind == EntryKind::File)
            .ok_or(IndexError::MissingSource)?;
        let raw = destination
            .split('#')
            .next()
            .unwrap_or("")
            .trim_matches(js_whitespace);
        let decoded = decode_or_literal(raw);
        if decoded.is_empty() {
            return Ok(vec![source]);
        }
        if external(&decoded) {
            return Ok(Vec::new());
        }
        let mut target = normalize_link_key(&decoded);
        let rooted = target.starts_with('/');
        let mut candidates: Vec<_> = if name(&target).contains('.') {
            self.files
                .iter()
                .filter(|(_, p)| name(p) == name(&target))
                .collect()
        } else {
            Vec::new()
        };
        if candidates.is_empty() {
            target.push_str(".md");
            candidates = self
                .files
                .iter()
                .filter(|(_, p)| name(p) == name(&target))
                .collect();
        }
        if candidates.is_empty() {
            return Ok(Vec::new());
        }
        let mut directory = normalize_link_key(parent(source.path.as_str()));
        if target.starts_with("./") || target.starts_with("../") {
            if target.starts_with("./../") {
                target = target[2..].into();
            }
            if target.starts_with("./") {
                target = target[2..].into();
            } else {
                while target.starts_with("../") {
                    target = target[3..].into();
                    directory = parent(&directory).into();
                }
            }
            target = if directory.is_empty() {
                target
            } else {
                format!("{directory}/{target}")
            };
            let mut exact: Vec<_> = candidates
                .iter()
                .filter(|(_, p)| p == &target)
                .map(|(e, _)| *e)
                .collect();
            if !exact.is_empty() {
                exact.sort_by(|a, b| order(a, b));
                return Ok(exact);
            }
        }
        if target.starts_with('/') {
            target = target[1..].into();
        }
        let mut exact: Vec<_> = candidates
            .iter()
            .filter(|(_, p)| p == &target)
            .map(|(e, _)| *e)
            .collect();
        if !exact.is_empty() {
            exact.sort_by(|a, b| order(a, b));
            return Ok(exact);
        }
        if rooted {
            return Ok(Vec::new());
        }
        candidates.retain(|(_, p)| suffix_segment(p, &target));
        candidates.sort_by(|(a, ap), (b, bp)| {
            in_directory(bp, &directory)
                .cmp(&in_directory(ap, &directory))
                .then(order(a, b))
        });
        Ok(candidates.into_iter().map(|(e, _)| *e).collect())
    }
}
