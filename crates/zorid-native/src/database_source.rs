//! Lossless, deliberately conservative composition of managed frontmatter.
//! The document parser validates YAML; only collection-owned block-map pairs
//! are replaced. Unsupported forms stay intact and return actionable pending work.
use crate::{Error, Result};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use zorid_document::{parse_markdown_facts, FrontmatterState};

fn changed() -> Error {
    Error::Busy("Collection properties changed outside Zorid; resolve the saved frontmatter before retrying")
}

pub(super) fn properties(source: &str) -> Result<BTreeMap<String, Value>> {
    let facts = parse_markdown_facts(source)
        .map_err(|_| Error::Unsupported("collection frontmatter exceeds parser limits"))?;
    if !matches!(
        facts.frontmatter.state,
        FrontmatterState::Absent | FrontmatterState::Valid
    ) {
        return Err(Error::Unsupported(
            "repair invalid frontmatter before publishing collection properties",
        ));
    }
    facts
        .properties
        .iter()
        .map(|property| {
            serde_json::to_value(&property.value)
                .map(|value| (property.key.clone(), value))
                .map_err(|_| Error::Unsupported("unsupported collection frontmatter value"))
        })
        .collect()
}

/// Require every managed value to be either the last published baseline or the
/// current projection. A mixed document is safe: no unrelated content is touched.
/// Renamed/deleted properties are still owned through `previous`.
pub(super) fn compose(
    source: &str,
    desired: &BTreeMap<String, Value>,
    previous: &BTreeMap<String, Value>,
    previous_keys: &[String],
) -> Result<String> {
    let facts = parse_markdown_facts(source)
        .map_err(|_| Error::Unsupported("collection frontmatter exceeds parser limits"))?;
    if !matches!(
        facts.frontmatter.state,
        FrontmatterState::Absent | FrontmatterState::Valid
    ) {
        return Err(Error::Unsupported(
            "repair invalid frontmatter before publishing collection properties",
        ));
    }
    let current = properties(source)?;
    let owned: BTreeSet<&str> = desired
        .keys()
        .chain(previous.keys())
        .chain(previous_keys)
        .map(String::as_str)
        .collect();
    for key in &owned {
        let actual = current.get(*key);
        if actual != desired.get(*key) && actual != previous.get(*key) {
            return Err(changed());
        }
    }
    let newline = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let generated = desired
        .iter()
        .map(|(key, value)| {
            // JSON strings, scalars and flow sequences are valid YAML 1.2. This
            // representation never changes string dates or string-like numbers.
            format!(
                "{}: {}{}",
                serde_json::to_string(key).unwrap(),
                value,
                newline
            )
        })
        .collect::<String>();
    if facts.frontmatter.state == FrontmatterState::Absent {
        let (bom, body) = source
            .strip_prefix('\u{feff}')
            .map_or(("", source), |body| ("\u{feff}", body));
        let output = format!("{bom}---{newline}{generated}---{newline}{body}");
        let actual = properties(&output)?;
        if &actual != desired {
            return Err(Error::Unsupported(
                "generated collection frontmatter failed validation",
            ));
        }
        return Ok(output);
    }
    let body_start = facts.frontmatter.body_start.byte as usize;
    let closing_start = source[..body_start]
        .trim_end_matches(['\r', '\n'])
        .rfind('\n')
        .map_or(0, |offset| offset + 1);
    let yaml_start = source
        .find('\n')
        .map(|offset| offset + 1)
        .ok_or(Error::Unsupported("frontmatter opening needs a newline"))?;
    let mut spans = Vec::new();
    for (index, property) in facts.properties.iter().enumerate() {
        if !owned.contains(property.key.as_str()) {
            continue;
        }
        let key_start = property.key_range.bytes[0] as usize;
        let line_start = source[..key_start]
            .rfind('\n')
            .map_or(0, |offset| offset + 1);
        // Flow root mappings and explicit/indented keys are preserved rather
        // than reformatted under uncertain ownership.
        if line_start < yaml_start || !source[line_start..key_start].is_empty() {
            return Err(Error::Unsupported(
                "collection properties require ordinary block-map frontmatter",
            ));
        }
        let next = facts
            .properties
            .get(index + 1)
            .map_or(closing_start, |next| {
                source[..next.key_range.bytes[0] as usize]
                    .rfind('\n')
                    .map_or(0, |offset| offset + 1)
            });
        if next <= line_start || next > closing_start {
            return Err(Error::Unsupported(
                "collection properties require ordinary block-map frontmatter",
            ));
        }
        let mut end = next;
        // Keep trailing comments/blank lines byte-for-byte. They may document
        // the next unowned property, and are never generated state.
        let block = &source[line_start..next];
        for line in block.split_inclusive('\n').rev() {
            if line.trim().is_empty() || line.trim_start().starts_with('#') {
                end -= line.len();
            } else {
                break;
            }
        }
        spans.push((line_start, end));
    }
    let mut result = source.to_owned();
    // Insert once before the closing delimiter. Existing unknown YAML, its
    // comments, opening/closing markers and Markdown body remain exact bytes.
    result.insert_str(closing_start, &generated);
    for (start, end) in spans.into_iter().rev() {
        result.replace_range(start..end, "");
    }
    let actual = properties(&result)?;
    if desired
        .iter()
        .any(|(key, value)| actual.get(key) != Some(value))
        || current
            .iter()
            .any(|(key, value)| !owned.contains(key.as_str()) && actual.get(key) != Some(value))
        || actual
            .keys()
            .any(|key| !desired.contains_key(key) && owned.contains(key.as_str()))
    {
        return Err(Error::Unsupported(
            "collection projection would change unrelated YAML",
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn map(value: Value) -> BTreeMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn preserves_body_unknown_properties_comments_and_crlf() {
        let source = "\u{feff}--- # existing\r\nstatus: Old\r\n# Keep unknown\r\nother: &other [one, two]\r\nalias: *other\r\n... # end\r\n\r\n# Body 🐈\r\n";
        let previous = map(json!({"status":"Old"}));
        let desired = map(json!({"_id":"entry","_type":"Work","Progress":"Started"}));
        let output = compose(source, &desired, &previous, &["status".into()]).unwrap();
        assert!(output.starts_with("\u{feff}--- # existing\r\n# Keep unknown\r\nother: &other [one, two]\r\nalias: *other\r\n"));
        assert!(output.ends_with("... # end\r\n\r\n# Body 🐈\r\n"));
        assert_eq!(
            properties(&output).unwrap().get("Progress"),
            Some(&json!("Started"))
        );
    }
    #[test]
    fn refuses_external_changes_and_wrong_identity() {
        let previous = map(json!({"_id":"entry","status":"Old"}));
        let desired = map(json!({"_id":"entry","status":"New"}));
        assert!(compose(
            "---\n_id: other\nstatus: Old\n---\nBody",
            &desired,
            &previous,
            &[]
        )
        .is_err());
        assert!(compose(
            "---\n_id: entry\nstatus: External\n---\nBody",
            &desired,
            &previous,
            &[]
        )
        .is_err());
    }
    #[test]
    fn idempotent_target_and_multiline_list_are_supported() {
        let desired = map(json!({"_id":"entry","labels":["A","B"]}));
        let source = "---\n_id: entry\nlabels:\n - A\n - B\nunknown: keep\n---\nbody\n";
        let result = compose(source, &desired, &desired, &[]).unwrap();
        assert!(result.ends_with("---\nbody\n"));
        assert_eq!(
            properties(&result).unwrap().get("unknown"),
            Some(&json!("keep"))
        );
    }
    #[test]
    fn rejects_flow_and_invalid_yaml_without_a_rewrite() {
        let desired = map(json!({"_id":"entry"}));
        assert!(compose(
            "---\n{_id: entry, extra: keep}\n---\nBody",
            &desired,
            &desired,
            &[]
        )
        .is_err());
        assert!(compose(
            "---\na: 1\na: 2\n---\nBody",
            &desired,
            &BTreeMap::new(),
            &[]
        )
        .is_err());
    }

    #[test]
    fn owned_anchor_cannot_change_an_unowned_alias() {
        let desired = map(json!({"status":"New"}));
        let previous = map(json!({"status":"Old"}));
        assert!(compose(
            "---\nstatus: &status Old\nunknown: *status\n---\nBody",
            &desired,
            &previous,
            &[]
        )
        .is_err());
    }

    #[test]
    fn empty_frontmatter_unicode_and_eof_delimiter_are_preserved() {
        let desired = map(json!({"_id":"entry","進捗":"Started"}));
        let result = compose("---\n# Keep\n---", &desired, &BTreeMap::new(), &[]).unwrap();
        assert!(result.starts_with("---\n# Keep\n"));
        assert!(result.ends_with("---"));
        assert_eq!(properties(&result).unwrap(), desired);
    }

    #[test]
    fn replay_after_publication_and_duplicate_identity_are_safe() {
        let desired = map(json!({"_id":"new-entry","Status":"New"}));
        let previous = map(json!({"_id":"old-entry","Status":"Old"}));
        let duplicate = compose(
            "---\n_id: old-entry\nStatus: Old\n---\nBody",
            &desired,
            &previous,
            &[],
        )
        .unwrap();
        assert_eq!(properties(&duplicate).unwrap(), desired);
        assert_eq!(
            compose(&duplicate, &desired, &previous, &[]).unwrap(),
            duplicate
        );
        assert!(compose("---\nStatus: Old\n---\nBody", &desired, &previous, &[]).is_err());
    }
}
