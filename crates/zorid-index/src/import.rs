//! Bounded convenience import for fixtures and small detached consumers.
//! Production hosts should use incremental GenerationBuilder pumps instead.
use crate::{
    Exclusion, Generation, GenerationBuilder, IndexError, IndexRecord, IndexSnapshotId, Manifest,
    MetadataRequest, PublicationFence, SourceSnapshotId,
};
use serde::{Deserialize, Serialize};
use zorid_core::{EntryId, EntryState, Revision};
use zorid_document::MAX_SOURCE_BYTES;

pub const MAX_IMPORT_ENTRIES: usize = 32;
pub const MAX_IMPORT_SOURCE_BYTES: usize = MAX_SOURCE_BYTES;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GenerationSource {
    Text {
        request: MetadataRequest,
        markdown: bool,
    },
    Excluded {
        #[serde(rename = "entryId")]
        entry_id: EntryId,
        #[serde(rename = "contentRevision")]
        content_revision: Revision,
        reason: Exclusion,
    },
}
impl Generation {
    /// Construct a small complete generation using exactly the ordinary parser,
    /// witness checks and builder budgets. This does not read or publish storage.
    /// The transport MUST bound bytes before deserializing its inputs; this
    /// method bounds supplied aggregate inputs before internal namespace/fact
    /// allocations. One source or explicit exclusion is required per file.
    pub fn from_sources(
        source: SourceSnapshotId,
        id: IndexSnapshotId,
        entries: Vec<EntryState>,
        sources: Vec<GenerationSource>,
    ) -> Result<Self, IndexError> {
        if entries.len() > MAX_IMPORT_ENTRIES || sources.len() > MAX_IMPORT_ENTRIES {
            return Err(IndexError::GenerationLimit);
        }
        let mut bytes = 0usize;
        for input in &sources {
            if let GenerationSource::Text { request, .. } = input {
                bytes = bytes
                    .checked_add(request.source.len())
                    .ok_or(IndexError::GenerationLimit)?;
                if bytes > MAX_IMPORT_SOURCE_BYTES {
                    return Err(IndexError::GenerationLimit);
                }
            }
        }
        let manifest = Manifest::new(source.clone(), entries)?;
        let mut seen = std::collections::BTreeSet::new();
        for input in &sources {
            let (entry_id, revision) = match input {
                GenerationSource::Text { request, .. } => {
                    (&request.entry_id, &request.content_revision)
                }
                GenerationSource::Excluded {
                    entry_id,
                    content_revision,
                    ..
                } => (entry_id, content_revision),
            };
            if !seen.insert(entry_id) {
                return Err(IndexError::InvalidRecord);
            }
            let witness = manifest.witness(entry_id)?;
            if &witness.entry().revision != revision {
                return Err(IndexError::StaleSource);
            }
        }
        if seen.len()
            != manifest
                .entries()
                .iter()
                .filter(|entry| entry.kind == zorid_core::EntryKind::File)
                .count()
        {
            return Err(IndexError::MissingSource);
        }
        let fence = PublicationFence::new(source, None, id)?;
        let mut builder = GenerationBuilder::new(manifest.clone(), fence)?;
        for input in sources {
            let record = match input {
                GenerationSource::Text { request, markdown } => {
                    let witness = manifest.witness(&request.entry_id)?;
                    IndexRecord::text(witness, &request, markdown)?
                }
                GenerationSource::Excluded {
                    entry_id,
                    content_revision,
                    reason,
                } => {
                    let witness = manifest.witness(&entry_id)?;
                    if witness.entry().revision != content_revision {
                        return Err(IndexError::StaleSource);
                    }
                    IndexRecord::excluded(witness, reason)
                }
            };
            // Pure resource check precedes insertion; retry only resets the
            // batch, never substitutes source or mutates authoritative heads.
            match builder.add(record.clone()) {
                Ok(()) => {}
                Err(IndexError::PumpLimit) => {
                    builder.begin_pump();
                    builder.add(record)?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(builder.finish()?.into_parts().1)
    }
}
