// Adapted from MDBASE; see ../UPSTREAM.md and ../LICENSE-MDBASE.
//! The files an Obsidian Bases evaluation can reach, with lookups built once per evaluation.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

use super::expression::{
    ensure_markdown_extension, normalize_path, strip_markdown_extension, strip_subpath, BasesFile,
};

/// Every file a view evaluation may open through `file()`, `asFile()` or `this`.
///
/// Link targets that the resolution map does not name are found with Obsidian's fallback
/// rules: exact path, path with `.md`, path suffix, basename or name, then the same
/// case-insensitively. Each rule is a map from its key to the first file, in list order, that
/// satisfies it, so a lookup returns the file a scan in that order would, without the scan.
#[derive(Debug, Default)]
pub(crate) struct BasesFiles {
    files: Vec<BasesFile>,
    exact_path: HashMap<String, usize>,
    lookup: OnceLock<FileLookup>,
}

#[derive(Debug, Default)]
struct FileLookup {
    path: HashMap<String, usize>,
    normalized: HashMap<String, usize>,
    suffix: HashMap<String, usize>,
    basename: HashMap<String, usize>,
    stem: HashMap<String, usize>,
    lower_normalized: HashMap<String, usize>,
    lower_name: HashMap<String, usize>,
    lower_basename: HashMap<String, usize>,
}

impl FromIterator<BasesFile> for BasesFiles {
    fn from_iter<T: IntoIterator<Item = BasesFile>>(files: T) -> Self {
        Self::new(files.into_iter().collect())
    }
}

impl BasesFiles {
    pub(crate) fn new(files: Vec<BasesFile>) -> Self {
        let exact_path = files
            .iter()
            .enumerate()
            .map(|(index, file)| (file.path.clone(), index))
            .collect();
        Self {
            files,
            exact_path,
            lookup: OnceLock::new(),
        }
    }

    pub(crate) fn iter(&self) -> std::slice::Iter<'_, BasesFile> {
        self.files.iter()
    }

    /// The file at exactly this collection path.
    pub(crate) fn by_path(&self, path: &str) -> Option<&BasesFile> {
        self.at(self.exact_path.get(path).copied())
    }

    /// The file a link target names under Obsidian's fallback rules, in their priority order.
    pub(crate) fn find(&self, target: &str) -> Option<&BasesFile> {
        let lookup = self.lookup();
        let target = strip_subpath(target);
        let markdown = ensure_markdown_extension(&target);
        let lower_target = target.to_lowercase();
        let lower_markdown = markdown.to_lowercase();
        let lower_basename = strip_markdown_extension(&target).to_lowercase();
        let first =
            |candidates: &[Option<&usize>]| candidates.iter().flatten().map(|at| **at).min();
        let found = first(&[lookup.normalized.get(&normalize_path(&target))])
            .or_else(|| first(&[lookup.normalized.get(&normalize_path(&markdown))]))
            .or_else(|| first(&[lookup.suffix.get(&markdown)]))
            .or_else(|| first(&[lookup.basename.get(&target), lookup.stem.get(&target)]))
            .or_else(|| first(&[lookup.lower_normalized.get(&lower_target)]))
            .or_else(|| first(&[lookup.lower_normalized.get(&lower_markdown)]))
            .or_else(|| {
                first(&[
                    lookup.lower_name.get(&lower_target),
                    lookup.lower_name.get(&lower_markdown),
                ])
            })
            .or_else(|| first(&[lookup.lower_basename.get(&lower_basename)]));
        self.at(found)
    }

    fn at(&self, position: Option<usize>) -> Option<&BasesFile> {
        position.and_then(|position| self.files.get(position))
    }

    fn lookup(&self) -> &FileLookup {
        self.lookup.get_or_init(|| {
            let mut lookup = FileLookup::default();
            for (position, file) in self.files.iter().enumerate() {
                let keep = |map: &mut HashMap<String, usize>, key: String| {
                    map.entry(key).or_insert(position);
                };
                let normalized = normalize_path(&file.path);
                keep(&mut lookup.path, file.path.clone());
                // `path.ends_with("/{target}")` holds exactly when the target is the path after
                // one of its slashes.
                for (slash, _) in normalized.match_indices('/') {
                    keep(&mut lookup.suffix, normalized[slash + 1..].to_string());
                }
                keep(&mut lookup.lower_normalized, normalized.to_lowercase());
                keep(&mut lookup.normalized, normalized);
                keep(&mut lookup.basename, file.basename.clone());
                keep(&mut lookup.stem, strip_markdown_extension(&file.name));
                keep(&mut lookup.lower_name, file.name.to_lowercase());
                keep(&mut lookup.lower_basename, file.basename.to_lowercase());
            }
            lookup
        })
    }
}

/// Build a timezone-specific immutable file context once, then share it among
/// every row session. Admission precedes metadata/graph/overlay copies.
pub(crate) fn hydrate(
    records: &[crate::DetachedRecord],
    relationships: Option<&crate::graph::PreparedRelationships<'_>>,
    unavailable: Option<&std::collections::HashSet<crate::EntryId>>,
    properties: Option<&crate::relations::PropertyRelationValues>,
    timezone: &super::expression::BasesTimezone,
    check: &mut impl FnMut(usize) -> Result<(), crate::ExpressionDiagnostic>,
    admit: &mut impl FnMut(usize) -> Result<(), crate::ExpressionDiagnostic>,
) -> Result<Arc<BasesFiles>, crate::ExpressionDiagnostic> {
    const MAX_CONTEXT_BYTES: usize = crate::MAX_BASE_REQUEST_BYTES;
    let mut bytes = std::mem::size_of::<BasesFiles>();
    let mut files = Vec::new();
    for record in records {
        check(1)?;
        let source_bytes = crate::encoded_size(record, MAX_CONTEXT_BYTES)?;
        let overlay_bytes = record
            .witness
            .as_ref()
            .and_then(|witness| {
                properties.and_then(|properties| properties.rows().get(&witness.entry_id))
            })
            .map(|row| crate::encoded_size(&row.values, MAX_CONTEXT_BYTES))
            .transpose()?
            .unwrap_or(0);
        let graph_bytes = relationships
            .map(|graph| graph.attachment_bytes(record.witness.as_ref(), check))
            .transpose()?
            .unwrap_or(0);
        let estimate = source_bytes
            .saturating_add(overlay_bytes)
            .saturating_mul(24)
            .saturating_add(graph_bytes.saturating_mul(4))
            .saturating_add(2048);
        check(
            1usize
                .saturating_add(source_bytes / 16)
                .saturating_add(overlay_bytes / 16)
                .saturating_add(graph_bytes / 64),
        )?;
        bytes = bytes
            .checked_add(estimate)
            .filter(|bytes| *bytes <= MAX_CONTEXT_BYTES)
            .ok_or_else(|| {
                crate::ExpressionDiagnostic::new(
                    "budget",
                    "Shared file context exceeds its bounded memory allowance",
                )
            })?;
        admit(estimate)?;
        let mut file = crate::runtime_file(record, timezone)?;
        if let Some(graph) = relationships {
            graph.attach(&mut file);
        }
        if let Some(properties) = properties {
            properties.attach(&mut file, timezone)?;
        }
        file.metadata_unavailable |= record
            .witness
            .as_ref()
            .is_some_and(|witness| unavailable.is_some_and(|ids| ids.contains(&witness.entry_id)));
        files.push(file);
    }
    check(files.len())?;
    Ok(Arc::new(BasesFiles::new(files)))
}
