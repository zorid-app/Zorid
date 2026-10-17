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
fn destination_path(destination: &str) -> Result<String, IndexError> {
    if destination.len() > MAX_TARGET_BYTES {
        return Err(IndexError::InvalidTarget);
    }
    let raw = destination
        .split('#')
        .next()
        .unwrap_or("")
        .trim_matches(js_whitespace);
    Ok(decode_or_literal(raw))
}
/// Classify the parser's semantic full destination using exactly the resolver's
/// fragment/trim/strict-percent pipeline and target resource limit. Markdown
/// escapes/entities must already be normalized upstream, just as candidates().
pub fn is_external_destination(destination: &str) -> Result<bool, IndexError> {
    Ok(external(&destination_path(destination)?))
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
        Self::new_checked(manifest, &mut |_| Ok::<(), IndexError>(()))
            .expect("infallible checkpoint")
    }
    /// Charge/cancel before allocating each namespace projection. The callback
    /// owns its error classification; this engine has no clock/cancellation IO.
    pub fn new_checked<E>(
        manifest: &'a Manifest,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Self, E> {
        check(0)?;
        let mut files = Vec::new();
        for entry in manifest.entries() {
            check(1)?;
            if entry.kind == EntryKind::File {
                files.push((entry, normalize_link_key(entry.path.as_str())));
            }
        }
        Ok(Self { manifest, files })
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
        self.candidates_checked(source_id, destination, &mut |_| Ok::<(), IndexError>(()))
    }
    /// Same resolver with explicit work/cancellation checkpoints. Namespace
    /// lookup and sorting reserve conservative work before their bounded work;
    /// filtering charges each candidate as visited. No alternative semantics.
    pub fn candidates_checked<E: From<IndexError>>(
        &self,
        source_id: &EntryId,
        destination: &str,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Vec<&'a EntryState>, E> {
        check(0)?;
        let decoded = destination_path(destination).map_err(E::from)?;
        check(self.manifest.entries().len())?;
        let source = self
            .manifest
            .entry(source_id)
            .filter(|e| e.kind == EntryKind::File)
            .ok_or_else(|| E::from(IndexError::MissingSource))?;
        if decoded.is_empty() {
            return Ok(vec![source]);
        }
        if external(&decoded) {
            return Ok(Vec::new());
        }
        let mut target = normalize_link_key(&decoded);
        let rooted = target.starts_with('/');
        let mut candidates = Vec::new();
        if name(&target).contains('.') {
            for pair in &self.files {
                check(1)?;
                if name(&pair.1) == name(&target) {
                    candidates.push(pair);
                }
            }
        }
        if candidates.is_empty() {
            target.push_str(".md");
            for pair in &self.files {
                check(1)?;
                if name(&pair.1) == name(&target) {
                    candidates.push(pair);
                }
            }
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
            let mut exact = Vec::new();
            for (entry, path) in &candidates {
                check(1)?;
                if path.as_str() == target.as_str() {
                    exact.push(*entry);
                }
            }
            if !exact.is_empty() {
                check(sort_work(exact.len()))?;
                exact.sort_by(|a, b| order(a, b));
                check(0)?;
                return Ok(exact);
            }
        }
        if target.starts_with('/') {
            target = target[1..].into();
        }
        let mut exact = Vec::new();
        for (entry, path) in &candidates {
            check(1)?;
            if path.as_str() == target.as_str() {
                exact.push(*entry);
            }
        }
        if !exact.is_empty() {
            check(sort_work(exact.len()))?;
            exact.sort_by(|a, b| order(a, b));
            check(0)?;
            return Ok(exact);
        }
        if rooted {
            return Ok(Vec::new());
        }
        let mut selected = Vec::new();
        for pair in candidates {
            check(1)?;
            if suffix_segment(&pair.1, &target) {
                selected.push(pair);
            }
        }
        check(sort_work(selected.len()))?;
        selected.sort_by(|(a, ap), (b, bp)| {
            in_directory(bp, &directory)
                .cmp(&in_directory(ap, &directory))
                .then(order(a, b))
        });
        check(0)?;
        Ok(selected.into_iter().map(|(entry, _)| *entry).collect())
    }
}
fn sort_work(n: usize) -> usize {
    if n < 2 {
        return 0;
    }
    n.saturating_mul((usize::BITS - (n - 1).leading_zeros()) as usize + 1)
        .saturating_mul(4)
}
