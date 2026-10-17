use crate::{EntryWitness, IndexError};
use std::collections::BTreeSet;
use zorid_document::{
    DocumentMetadata, PropertyValue, SourceRange, DIALECT_VERSION, MAX_SOURCE_BYTES,
    MAX_VALUE_NODES, MAX_YAML_DEPTH, SCHEMA_VERSION,
};

pub(crate) fn validate_metadata(
    metadata: &DocumentMetadata,
    witness: &EntryWitness,
    bytes: usize,
) -> Result<(), IndexError> {
    if metadata.entry_id != witness.entry().id
        || metadata.content_revision != witness.entry().revision
    {
        return Err(IndexError::StaleSource);
    }
    if metadata.schema_version != SCHEMA_VERSION || metadata.dialect_version != DIALECT_VERSION {
        return Err(IndexError::InvalidVersion);
    }
    let length = &metadata.source_length;
    if bytes > MAX_SOURCE_BYTES
        || length.bytes as usize != bytes
        || length.utf16 > length.bytes
        || u64::from(length.bytes) > 3 * u64::from(length.utf16)
    {
        return Err(IndexError::InvalidRecord);
    }
    let range = |r: &SourceRange| -> Result<(), IndexError> {
        if r.bytes[0] > r.bytes[1]
            || r.bytes[1] > length.bytes
            || r.utf16[0] > r.utf16[1]
            || r.utf16[1] > length.utf16
        {
            return Err(IndexError::InvalidRecord);
        }
        for i in 0..2 {
            if r.utf16[i] > r.bytes[i] || u64::from(r.bytes[i]) > 3 * u64::from(r.utf16[i]) {
                return Err(IndexError::InvalidRecord);
            }
        }
        Ok(())
    };
    let point = &metadata.frontmatter.body_start;
    range(&SourceRange {
        bytes: [point.byte, point.byte],
        utf16: [point.utf16, point.utf16],
    })?;
    if let Some(r) = &metadata.frontmatter.range {
        range(r)?;
    }
    let valid_key = |key: &str| {
        !key.trim().is_empty() && !key.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
    };
    let mut keys = BTreeSet::new();
    let mut pending = Vec::new();
    for property in &metadata.properties {
        if !valid_key(&property.key) || !keys.insert(&property.key) {
            return Err(IndexError::InvalidRecord);
        }
        range(&property.key_range)?;
        pending.push((&property.value, 0));
    }
    let mut nodes = 0;
    while let Some((value, depth)) = pending.pop() {
        nodes += 1;
        if nodes > MAX_VALUE_NODES || depth > MAX_YAML_DEPTH {
            return Err(IndexError::InvalidRecord);
        }
        match value {
            PropertyValue::Array(values) => pending.extend(values.iter().map(|v| (v, depth + 1))),
            PropertyValue::Object(entries) => {
                let mut keys = BTreeSet::new();
                for (key, value) in entries {
                    if !valid_key(key) || !keys.insert(key) {
                        return Err(IndexError::InvalidRecord);
                    }
                    pending.push((value, depth + 1));
                }
            }
            PropertyValue::Number(_) => value
                .validate_json_numbers()
                .map_err(|_| IndexError::InvalidRecord)?,
            _ => {}
        }
    }
    for record in &metadata.tag_occurrences {
        range(&record.range)?;
    }
    for heading in &metadata.headings {
        if !(1..=6).contains(&heading.level) || heading.line > length.bytes {
            return Err(IndexError::InvalidRecord);
        }
        range(&heading.range)?;
    }
    for link in &metadata.links {
        range(&link.range)?;
        range(&link.target_range)?;
        if let Some(r) = &link.definition_range {
            range(r)?;
        }
    }
    for task in &metadata.tasks {
        if task.line > length.bytes || task.status.encode_utf16().count() != 1 {
            return Err(IndexError::InvalidRecord);
        }
        range(&task.range)?;
        range(&task.status_range)?;
        range(&task.text_range)?;
    }
    for diagnostic in &metadata.diagnostics {
        range(&diagnostic.range)?;
    }
    Ok(())
}
