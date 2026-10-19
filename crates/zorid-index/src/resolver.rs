use crate::{IndexError, Manifest};
use percent_encoding::percent_decode_str;
use std::cmp::Ordering;
use std::collections::HashMap;
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
struct PreparedFile<'a> {
    entry: &'a EntryState,
    path: String,
    directory: String,
    utf16_path_length: usize,
}
fn order(a: &PreparedFile<'_>, b: &PreparedFile<'_>) -> Ordering {
    a.utf16_path_length
        .cmp(&b.utf16_path_length)
        .then(a.entry.path.cmp(&b.entry.path))
        .then(a.entry.id.cmp(&b.entry.id))
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
    files: Vec<PreparedFile<'a>>,
    sources: HashMap<&'a EntryId, usize>,
    basenames: HashMap<String, Vec<usize>>,
}
impl<'a> Resolver<'a> {
    pub fn new(manifest: &'a Manifest) -> Self {
        Self::new_checked(manifest, &mut |_| Ok::<(), IndexError>(()))
            .expect("infallible checkpoint")
    }
    /// Prepare namespace projections and lookup tables once. Work is charged
    /// before projection, table allocation, hashing and bucket sorting. Hash maps
    /// are never enumerated for candidate order; each bucket has the established
    /// UTF16-length/raw-path/ID order, independent of hash seed or input order.
    pub fn new_checked<E>(
        manifest: &'a Manifest,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Self, E> {
        check(0)?;
        let mut files = Vec::new();
        for entry in manifest.entries() {
            check(1)?;
            if entry.kind == EntryKind::File {
                let raw = entry.path.as_str();
                // One bounded full-path projection (normalization and UTF16
                // length) plus the separate, exact source-parent projection.
                check(raw.len().saturating_add(parent(raw).len()))?;
                files.push(PreparedFile {
                    entry,
                    path: normalize_link_key(raw),
                    directory: normalize_link_key(parent(raw)),
                    utf16_path_length: raw.encode_utf16().count(),
                });
            }
        }
        // Reserve only after every projection has been admitted. Enough table
        // capacity avoids hidden rehashing of all earlier keys on later inserts.
        check(files.len().saturating_mul(2))?;
        let mut sources = HashMap::with_capacity(files.len());
        let mut basenames: HashMap<String, Vec<usize>> = HashMap::with_capacity(files.len());
        for (index, file) in files.iter().enumerate() {
            let basename = name(&file.path);
            check(
                1usize
                    .saturating_add(file.entry.id.as_str().len())
                    .saturating_add(basename.len()),
            )?;
            sources.insert(&file.entry.id, index);
            basenames
                .entry(basename.to_owned())
                .or_default()
                .push(index);
        }
        for bucket in basenames.values_mut() {
            check(1)?;
            if bucket.len() < 2 {
                continue;
            }
            let mut comparison_bytes = 1usize;
            for &index in bucket.iter() {
                check(1)?;
                let entry = files[index].entry;
                comparison_bytes = comparison_bytes.max(
                    entry
                        .path
                        .as_str()
                        .len()
                        .saturating_add(entry.id.as_str().len()),
                );
            }
            // Length is precomputed; raw paths and IDs still need a bounded
            // string comparison on ties. Large collision buckets pay for it.
            check(sort_work(bucket.len()).saturating_mul(comparison_bytes))?;
            bucket.sort_by(|&a, &b| order(&files[a], &files[b]));
        }
        check(0)?;
        Ok(Self {
            files,
            sources,
            basenames,
        })
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
    /// Same resolver with explicit work/cancellation checkpoints. Only actual
    /// source/key lookups and the selected basename bucket are visited. Filtering
    /// retains prepared order; directory preference is a stable partition, so no
    /// per-destination sort or namespace scan remains.
    pub fn candidates_checked<E: From<IndexError>>(
        &self,
        source_id: &EntryId,
        destination: &str,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Vec<&'a EntryState>, E> {
        check(0)?;
        // Constant-time malformed-input rejection precedes any charged decoding
        // or source lookup, preserving the existing InvalidTarget precedence.
        if destination.len() > MAX_TARGET_BYTES {
            return Err(E::from(IndexError::InvalidTarget));
        }
        // Reserve bounded fragment/trim/strict-percent decoding work.
        check(destination.len())?;
        let decoded = destination_path(destination).map_err(E::from)?;
        check(1usize.saturating_add(source_id.as_str().len()))?;
        let source = self
            .sources
            .get(source_id)
            .map(|&index| &self.files[index])
            .ok_or_else(|| E::from(IndexError::MissingSource))?;
        if decoded.is_empty() {
            return Ok(vec![source.entry]);
        }
        if external(&decoded) {
            return Ok(Vec::new());
        }
        check(decoded.len())?;
        let mut target = normalize_link_key(&decoded);
        let rooted = target.starts_with('/');
        let mut candidates = None;
        if name(&target).contains('.') {
            check(1usize.saturating_add(name(&target).len()))?;
            candidates = self.basenames.get(name(&target));
        }
        if candidates.is_none() {
            check(3)?;
            target.push_str(".md");
            check(1usize.saturating_add(name(&target).len()))?;
            candidates = self.basenames.get(name(&target));
        }
        let Some(candidates) = candidates else {
            return Ok(Vec::new());
        };
        check(source.directory.len())?;
        let mut directory = source.directory.clone();
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
            for &index in candidates {
                check(1)?;
                let file = &self.files[index];
                if file.path == target {
                    exact.push(file.entry);
                }
            }
            if !exact.is_empty() {
                check(0)?;
                return Ok(exact);
            }
        }
        if target.starts_with('/') {
            target = target[1..].into();
        }
        let mut exact = Vec::new();
        for &index in candidates {
            check(1)?;
            let file = &self.files[index];
            if file.path == target {
                exact.push(file.entry);
            }
        }
        if !exact.is_empty() {
            check(0)?;
            return Ok(exact);
        }
        if rooted {
            return Ok(Vec::new());
        }
        let mut preferred = Vec::new();
        let mut other = Vec::new();
        for &index in candidates {
            check(1)?;
            let file = &self.files[index];
            if suffix_segment(&file.path, &target) {
                if in_directory(&file.path, &directory) {
                    preferred.push(file.entry);
                } else {
                    other.push(file.entry);
                }
            }
        }
        check(other.len())?;
        preferred.extend(other);
        check(0)?;
        Ok(preferred)
    }
}
fn sort_work(n: usize) -> usize {
    if n < 2 {
        return 0;
    }
    n.saturating_mul((usize::BITS - (n - 1).leading_zeros()) as usize + 1)
        .saturating_mul(4)
}
