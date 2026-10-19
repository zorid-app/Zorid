use serde::Deserialize;
use zorid_core::{EntryId, Revision};
use zorid_document::{
    parse_markdown, parse_markdown_facts, DiagnosticCode, DocumentMetadata, ExtractionError,
    FrontmatterState, MetadataRequest, ParseFacts, DIALECT_VERSION, MAX_FRONTMATTER_BYTES,
    MAX_SOURCE_BYTES, SCHEMA_VERSION,
};

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    request: MetadataRequest,
    expected: DocumentMetadata,
}

#[test]
fn facts_bind_to_each_identity_without_changing_the_accepted_corpus() {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../../tests/fixtures/document-semantics/markdown/corpus.json"
    ))
    .unwrap();
    let other_entry = EntryId::new("rebound-note").unwrap();
    let other_revision = Revision::new("rebound-revision").unwrap();
    for case in corpus.cases {
        let facts = parse_markdown_facts(&case.request.source).unwrap();
        assert_eq!(facts.schema_version, SCHEMA_VERSION, "{}", case.id);
        assert_eq!(facts.dialect_version, DIALECT_VERSION, "{}", case.id);
        let bound = facts.clone().bind(
            case.request.entry_id.clone(),
            case.request.content_revision.clone(),
        );
        assert_eq!(bound, case.expected, "{} original identity", case.id);
        assert_eq!(parse_markdown(&case.request).unwrap(), bound, "{}", case.id);

        let mut rebound_expected = case.expected;
        rebound_expected.entry_id = other_entry.clone();
        rebound_expected.content_revision = other_revision.clone();
        assert_eq!(
            facts.bind(other_entry.clone(), other_revision.clone()),
            rebound_expected,
            "{} changed identity",
            case.id
        );
    }
}

#[test]
fn serialized_facts_preserve_ordered_fields_and_reject_identity_fields() {
    let source = "---\nconfig: {Title: first, title: second}\n---\n[[Target]]";
    let facts = parse_markdown_facts(source).unwrap();
    let encoded = serde_json::to_string(&facts).unwrap();
    let decoded: ParseFacts = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, facts);
    let value = serde_json::to_value(&facts).unwrap();
    let fields = value.as_object().unwrap();
    assert_eq!(fields.len(), 12);
    for identity in ["entryId", "contentRevision", "path", "localStoreId"] {
        assert!(!fields.contains_key(identity));
        let mut invalid = value.clone();
        invalid[identity] = "must-not-enter-facts".into();
        assert!(serde_json::from_value::<ParseFacts>(invalid).is_err());
    }
    let bound = decoded.bind(
        EntryId::new("decoded-note").unwrap(),
        Revision::new("decoded-revision").unwrap(),
    );
    assert_eq!(
        bound,
        parse_markdown(&MetadataRequest {
            entry_id: bound.entry_id.clone(),
            content_revision: bound.content_revision.clone(),
            source: source.into(),
        })
        .unwrap()
    );
}

#[test]
fn unicode_bytes_utf16_and_crlf_offsets_are_preserved_before_and_after_binding() {
    let prefix = format!("{}\r\n", "😀e\u{301}".repeat(200));
    let source = format!("{prefix}[[目標#節]]\r\n- [é] tarea");
    let facts = parse_markdown_facts(&source).unwrap();
    assert_eq!(facts.source_length.bytes, source.len() as u32);
    assert_eq!(
        facts.source_length.utf16,
        source.encode_utf16().count() as u32
    );
    let start = prefix.len() + 2;
    assert_eq!(
        facts.links[0].target_range.bytes,
        [start as u32, (start + "目標".len()) as u32]
    );
    let utf16_start = prefix.encode_utf16().count() + 2;
    assert_eq!(
        facts.links[0].target_range.utf16,
        [utf16_start as u32, (utf16_start + 2) as u32]
    );
    assert_eq!(facts.tasks[0].line, 2);
    let status = &facts.tasks[0].status_range;
    assert_eq!(
        &source[status.bytes[0] as usize..status.bytes[1] as usize],
        "é"
    );
    let request = MetadataRequest {
        entry_id: EntryId::new("unicode-note").unwrap(),
        content_revision: Revision::new("unicode-revision").unwrap(),
        source,
    };
    assert_eq!(
        facts.bind(request.entry_id.clone(), request.content_revision.clone()),
        parse_markdown(&request).unwrap()
    );
}

#[test]
fn invalid_yaml_is_successful_facts_with_body_and_exact_diagnostics() {
    let source = "---\ntitle: [one\n---\n# Visible 😀\r\n- [x] done\r\n[[Target]]";
    let facts = parse_markdown_facts(source).unwrap();
    assert_eq!(facts.frontmatter.state, FrontmatterState::Invalid);
    assert_eq!(facts.diagnostics.len(), 1);
    assert_eq!(facts.diagnostics[0].code, DiagnosticCode::FrontmatterSyntax);
    assert_eq!(
        facts.diagnostics[0].range,
        facts.frontmatter.range.clone().unwrap()
    );
    assert!(facts.properties.is_empty());
    assert_eq!(facts.headings[0].text, "Visible 😀");
    assert_eq!(facts.links[0].target, "Target");
    assert!(facts.tasks[0].completed);
    let request = MetadataRequest {
        entry_id: EntryId::new("invalid-yaml-note").unwrap(),
        content_revision: Revision::new("invalid-yaml-revision").unwrap(),
        source: source.into(),
    };
    assert_eq!(
        facts.bind(request.entry_id.clone(), request.content_revision.clone()),
        parse_markdown(&request).unwrap()
    );
}

#[test]
fn facts_preserve_source_and_frontmatter_resource_boundaries() {
    let oversized = "😀".repeat(MAX_SOURCE_BYTES / 4 + 1);
    assert_eq!(
        parse_markdown_facts(&oversized),
        Err(ExtractionError::SourceTooLarge {
            maximum_bytes: MAX_SOURCE_BYTES,
        })
    );
    let source = format!(
        "---\nvalue: {}\n---\nVisible #body [[Target]]",
        "x".repeat(MAX_FRONTMATTER_BYTES)
    );
    let facts = parse_markdown_facts(&source).unwrap();
    assert_eq!(facts.frontmatter.state, FrontmatterState::Invalid);
    assert_eq!(
        facts.diagnostics[0].code,
        DiagnosticCode::FrontmatterResource
    );
    assert!(facts.properties.is_empty());
    assert_eq!(facts.tags, ["body"]);
    assert_eq!(facts.links[0].target, "Target");
    let request = MetadataRequest {
        entry_id: EntryId::new("bounded-note").unwrap(),
        content_revision: Revision::new("bounded-revision").unwrap(),
        source,
    };
    assert_eq!(
        facts.bind(request.entry_id.clone(), request.content_revision.clone()),
        parse_markdown(&request).unwrap()
    );
}
