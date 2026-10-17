use zorid_core::{EntryId, Revision};
use zorid_document::{
    parse_markdown, parse_yaml_mapping, MetadataRequest, PropertyValue, YamlDiagnosticCode,
};

#[test]
fn standalone_yaml_and_frontmatter_share_ordered_values() {
    let yaml = "config: {Title: first, title: second}\nanchor: &shared [one, two]\ncopy: *shared\ndate: 2024-02-29\n";
    let standalone = parse_yaml_mapping(yaml).unwrap();
    let note = parse_markdown(&MetadataRequest {
        entry_id: EntryId::new("yaml-note").unwrap(),
        content_revision: Revision::new("yaml-revision").unwrap(),
        source: format!("---\n{yaml}---\n"),
    })
    .unwrap();
    assert_eq!(
        standalone,
        PropertyValue::Object(
            note.properties
                .into_iter()
                .map(|property| (property.key, property.value))
                .collect()
        )
    );
}
#[test]
fn standalone_yaml_handles_bom_and_preserves_nested_order() {
    let result = parse_yaml_mapping("\u{feff}config: {Title: first, title: second}\r\n").unwrap();
    let PropertyValue::Object(entries) = result.get("config").unwrap() else {
        panic!("expected object");
    };
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.0.as_str())
            .collect::<Vec<_>>(),
        ["Title", "title"]
    );
}
#[test]
fn yaml_only_empty_and_mapping_validation_are_explicit() {
    for yaml in ["", "# comment\r\n", " \n# comment\r", "\r\n\r"] {
        assert_eq!(
            parse_yaml_mapping(yaml).unwrap(),
            PropertyValue::Object(Vec::new())
        );
    }
    for yaml in ["null", "# comment\rnull\r", "[one, two]", "scalar"] {
        assert_eq!(
            parse_yaml_mapping(yaml).unwrap_err().code,
            YamlDiagnosticCode::Mapping
        );
    }
}
#[test]
fn yaml_only_duplicate_alias_and_resource_failures_have_stable_codes() {
    for (yaml, code) in [
        ("true: one\n\"true\": two", YamlDiagnosticCode::DuplicateKey),
        ("value: *missing", YamlDiagnosticCode::Alias),
        ("value: &self [*self]", YamlDiagnosticCode::Alias),
        ("value: !custom text", YamlDiagnosticCode::Tag),
    ] {
        let error = parse_yaml_mapping(yaml).unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.range.bytes, [0, yaml.len() as u32]);
    }
    let yaml = "x".repeat(1024 * 1024 + 1);
    let error = parse_yaml_mapping(&yaml).unwrap_err();
    assert_eq!(error.code, YamlDiagnosticCode::Resource);
    assert_eq!(error.range.bytes, [0, 0]);
    assert_eq!(error.range.utf16, [0, 0]);
}
