use crate::{EntryWitness, IndexError};
use std::collections::{BTreeMap, BTreeSet};
use zorid_document::{
    DocumentMetadata, FrontmatterState, PropertyValue, SourceRange, DIALECT_VERSION,
    MAX_EXPANDED_YAML_BYTES, MAX_SOURCE_BYTES, MAX_VALUE_NODES, MAX_YAML_DEPTH, SCHEMA_VERSION,
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
        for (b, u) in [
            (r.bytes[1] - r.bytes[0], r.utf16[1] - r.utf16[0]),
            (length.bytes - r.bytes[1], length.utf16 - r.utf16[1]),
        ] {
            if u > b || u64::from(b) > 3 * u64::from(u) {
                return Err(IndexError::InvalidRecord);
            }
        }
        Ok(())
    };
    let width = |r: &SourceRange, value: &str| {
        r.bytes[1] - r.bytes[0] == value.len() as u32
            && r.utf16[1] - r.utf16[0] == value.encode_utf16().count() as u32
    };
    let contains = |outer: &SourceRange, inner: &SourceRange| {
        outer.bytes[0] <= inner.bytes[0]
            && inner.bytes[1] <= outer.bytes[1]
            && outer.utf16[0] <= inner.utf16[0]
            && inner.utf16[1] <= outer.utf16[1]
    };
    let point = &metadata.frontmatter.body_start;
    range(&SourceRange {
        bytes: [point.byte, point.byte],
        utf16: [point.utf16, point.utf16],
    })?;
    if let Some(r) = &metadata.frontmatter.range {
        range(r)?;
    }
    match metadata.frontmatter.state {
        FrontmatterState::Absent
            if metadata.frontmatter.range.is_none()
                && point.byte == 0
                && point.utf16 == 0
                && metadata.properties.is_empty() => {}
        FrontmatterState::Valid | FrontmatterState::Invalid
            if metadata
                .frontmatter
                .range
                .as_ref()
                .is_some_and(|r| point.byte == r.bytes[1] && point.utf16 == r.utf16[1])
                && (metadata.frontmatter.state == FrontmatterState::Valid
                    || metadata.properties.is_empty()) => {}
        FrontmatterState::Unclosed
            if metadata.frontmatter.range.is_some()
                && point.byte == 0
                && point.utf16 == 0
                && metadata.properties.is_empty() => {}
        _ => return Err(IndexError::InvalidRecord),
    }
    let valid_key = |key: &str| {
        !key.trim().is_empty() && !key.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
    };
    let mut keys = BTreeSet::new();
    let mut pending = Vec::new();
    let mut expanded_bytes = 0usize;
    for property in &metadata.properties {
        if !valid_key(&property.key) || !keys.insert(&property.key) {
            return Err(IndexError::InvalidRecord);
        }
        range(&property.key_range)?;
        if property.key_range.bytes[0] == property.key_range.bytes[1] {
            return Err(IndexError::InvalidRecord);
        }
        expanded_bytes = expanded_bytes.saturating_add(property.key.len());
        pending.push((&property.value, 1));
    }
    // YAML root mapping consumes one value node at depth zero. Original
    // non-string scalar spellings and alias provenance are not recoverable;
    // count only decoded strings/keys, a guaranteed subset of parser work.
    let mut nodes = 1;
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
                    expanded_bytes = expanded_bytes.saturating_add(key.len());
                    pending.push((value, depth + 1));
                }
            }
            PropertyValue::String(value) => {
                expanded_bytes = expanded_bytes.saturating_add(value.len())
            }
            PropertyValue::Number(_) => value
                .validate_json_numbers()
                .map_err(|_| IndexError::InvalidRecord)?,
            _ => {}
        }
        if expanded_bytes > MAX_EXPANDED_YAML_BYTES {
            return Err(IndexError::InvalidRecord);
        }
    }
    if expanded_bytes > MAX_EXPANDED_YAML_BYTES {
        return Err(IndexError::InvalidRecord);
    }
    for record in &metadata.tag_occurrences {
        range(&record.range)?;
        if !width(&record.range, &format!("#{}", record.name)) {
            return Err(IndexError::InvalidRecord);
        }
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
        if !width(&link.target_range, &link.target)
            || !contains(
                link.definition_range.as_ref().unwrap_or(&link.range),
                &link.target_range,
            )
        {
            return Err(IndexError::InvalidRecord);
        }
    }
    // New structural intervals are source ordered. Maximal blocks cannot
    // overlap; list items may nest but cannot cross one another.
    let key = |r: &SourceRange| (r.bytes[0], r.bytes[1], r.utf16[0], r.utf16[1]);
    let nonempty = |r: &SourceRange| r.bytes[0] < r.bytes[1] && r.utf16[0] < r.utf16[1];
    let after_body = |r: &SourceRange| r.bytes[0] >= point.byte && r.utf16[0] >= point.utf16;
    let mut previous_block: Option<&SourceRange> = None;
    for block in &metadata.blocks {
        range(&block.range)?;
        if !nonempty(&block.range)
            || !after_body(&block.range)
            || previous_block.is_some_and(|old| {
                old.bytes[1] > block.range.bytes[0] || old.utf16[1] > block.range.utf16[0]
            })
        {
            return Err(IndexError::InvalidRecord);
        }
        previous_block = Some(&block.range);
    }
    let mut items = BTreeMap::new();
    let mut stack: Vec<&SourceRange> = Vec::new();
    let mut previous_item: Option<&SourceRange> = None;
    for item in &metadata.list_items {
        range(&item.range)?;
        if !nonempty(&item.range)
            || !after_body(&item.range)
            || previous_item.is_some_and(|old| {
                old.bytes[0] >= item.range.bytes[0] || old.utf16[0] >= item.range.utf16[0]
            })
            || item.task_status.as_ref().is_some_and(|status| {
                status.encode_utf16().count() != 1 || status.contains(['\r', '\n'])
            })
        {
            return Err(IndexError::InvalidRecord);
        }
        while stack
            .last()
            .is_some_and(|old| old.bytes[1] <= item.range.bytes[0])
        {
            stack.pop();
        }
        if stack
            .last()
            .is_some_and(|outer| !contains(outer, &item.range))
        {
            return Err(IndexError::InvalidRecord);
        }
        stack.push(&item.range);
        items.insert(key(&item.range), item.task_status.as_deref());
        previous_item = Some(&item.range);
    }
    let mut task_items = BTreeSet::new();
    for task in &metadata.tasks {
        if task.line > length.bytes
            || task.status.encode_utf16().count() != 1
            || task.status.contains(['\r', '\n'])
            || task.checked != (task.status != " ")
            || task.completed != matches!(task.status.as_str(), "x" | "X")
        {
            return Err(IndexError::InvalidRecord);
        }
        range(&task.range)?;
        range(&task.status_range)?;
        range(&task.text_range)?;
        range(&task.item_range)?;
        if !contains(&task.item_range, &task.range)
            || !contains(&task.item_range, &task.text_range)
            || items.get(&key(&task.item_range)) != Some(&Some(task.status.as_str()))
            || !task_items.insert(key(&task.item_range))
            || !width(&task.status_range, &task.status)
            || !width(&task.text_range, &task.text)
            || task.range.bytes[1] - task.range.bytes[0] != task.status.len() as u32 + 2
            || task.range.utf16[1] - task.range.utf16[0] != 3
            || !contains(&task.range, &task.status_range)
            || task.status_range.bytes[0] != task.range.bytes[0] + 1
            || task.status_range.utf16[0] != task.range.utf16[0] + 1
            || task.text_range.bytes[0] < task.range.bytes[1]
            || task.text_range.utf16[0] < task.range.utf16[1]
        {
            return Err(IndexError::InvalidRecord);
        }
    }
    if items
        .iter()
        .any(|(range, status)| status.is_some() && !task_items.contains(range))
    {
        return Err(IndexError::InvalidRecord);
    }
    for diagnostic in &metadata.diagnostics {
        range(&diagnostic.range)?;
    }
    Ok(())
}
