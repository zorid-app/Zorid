// Adapted from MDBASE; see ../UPSTREAM.md and ../LICENSE-MDBASE.
//! The files an Obsidian Bases evaluation can reach, with lookups built once per evaluation.

use std::collections::HashMap;
use std::sync::Arc;

use super::expression::BasesFile;

/// Exact immutable file metadata for targets selected by the shared index
/// resolver. This container deliberately performs no fallback link resolution.
#[derive(Debug, Default)]
pub(crate) struct BasesFiles {
    files: Vec<BasesFile>,
    exact_path: HashMap<String, usize>,
    exact_witness: HashMap<crate::EntryId, usize>,
}

impl FromIterator<BasesFile> for BasesFiles {
    fn from_iter<T: IntoIterator<Item = BasesFile>>(files: T) -> Self {
        Self::new(files.into_iter().collect())
    }
}

impl BasesFiles {
    pub(crate) fn new(files: Vec<BasesFile>) -> Self {
        let mut exact_path = HashMap::with_capacity(files.len());
        let mut exact_witness = HashMap::with_capacity(files.len());
        for (position, file) in files.iter().enumerate() {
            exact_path.entry(file.path.clone()).or_insert(position);
            if let Some(witness) = &file.witness {
                exact_witness
                    .entry(witness.entry_id.clone())
                    .or_insert(position);
            }
        }
        Self {
            files,
            exact_path,
            exact_witness,
        }
    }

    pub(crate) fn iter(&self) -> std::slice::Iter<'_, BasesFile> {
        self.files.iter()
    }

    /// The file at exactly this collection path.
    pub(crate) fn by_path(&self, path: &str) -> Option<&BasesFile> {
        self.at(self.exact_path.get(path).copied())
    }

    /// Exact captured identity; the revision check prevents stale Link values
    /// from acquiring a different file's metadata after a cross-value roundtrip.
    pub(crate) fn by_witness(&self, witness: &crate::RecordWitness) -> Option<&BasesFile> {
        self.at(self.exact_witness.get(&witness.entry_id).copied())
            .filter(|file| file.witness.as_ref() == Some(witness))
    }

    fn at(&self, position: Option<usize>) -> Option<&BasesFile> {
        position.and_then(|position| self.files.get(position))
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
            graph.resolve_property_links(&mut file, check, &mut |added| {
                bytes = bytes
                    .checked_add(added)
                    .filter(|bytes| *bytes <= MAX_CONTEXT_BYTES)
                    .ok_or_else(|| {
                        crate::ExpressionDiagnostic::new(
                            "budget",
                            "Resolved shared properties exceed context byte budget",
                        )
                    })?;
                admit(added)
            })?;
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

#[cfg(test)]
mod hydration_tests {
    use super::*;
    use crate::{DetachedRecord, ExpressionDiagnostic};

    #[test]
    fn memory_admission_and_cancellation_precede_file_conversion() {
        // This path would fail the runtime converter. A rejected copy must
        // return its admission failure before interpreting or copying the file.
        let record = DetachedRecord {
            path: "../outside.md".into(),
            ..Default::default()
        };
        let error = hydrate(
            &[record.clone()],
            None,
            None,
            None,
            &Default::default(),
            &mut |_| Ok(()),
            &mut |_| Err(ExpressionDiagnostic::new("budget", "test memory allowance")),
        )
        .unwrap_err();
        assert_eq!(error.code, "budget");
        let mut admissions = 0;
        let error = hydrate(
            &[record],
            None,
            None,
            None,
            &Default::default(),
            &mut |_| Err(ExpressionDiagnostic::new("cancelled", "test cancellation")),
            &mut |_| {
                admissions += 1;
                Ok(())
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert_eq!(admissions, 0);
    }

    #[test]
    fn file_container_never_substitutes_a_name_match_for_a_resolved_path() {
        let files = BasesFiles::new(vec![BasesFile {
            path: "Folder/Target.md".into(),
            ..Default::default()
        }]);
        assert!(files.by_path("Folder/Target.md").is_some());
        assert!(files.by_path("Target").is_none());
        assert!(files.by_path("Folder/Target").is_none());
    }
}
