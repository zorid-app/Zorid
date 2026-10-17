use zorid_core::{EntryId, Revision};
use zorid_document::{
    parse_markdown, DiagnosticCode, ExtractionError, FrontmatterState, MetadataRequest,
    MAX_SOURCE_BYTES,
};

fn request(source: String) -> MetadataRequest {
    MetadataRequest {
        entry_id: EntryId::new("bounds-note").unwrap(),
        content_revision: Revision::new("revision-1").unwrap(),
        source,
    }
}
#[test]
fn oversized_input_has_a_typed_error_without_partial_metadata() {
    let input = request("x".repeat(MAX_SOURCE_BYTES + 1));
    assert_eq!(
        parse_markdown(&input),
        Err(ExtractionError::SourceTooLarge {
            maximum_bytes: MAX_SOURCE_BYTES
        })
    );
}
#[test]
fn framed_yaml_resource_failure_keeps_body_extractable() {
    let source = format!(
        "---\nvalue: {}\n---\nVisible #body [[Target]]",
        "x".repeat(1024 * 1024)
    );
    let result = parse_markdown(&request(source)).unwrap();
    assert_eq!(result.frontmatter.state, FrontmatterState::Invalid);
    assert_eq!(
        result.diagnostics[0].code,
        DiagnosticCode::FrontmatterResource
    );
    assert!(result.properties.is_empty());
    assert_eq!(result.tags, ["body"]);
    assert_eq!(result.links[0].target, "Target");
}
#[test]
fn yaml_value_depth_is_bounded_before_stack_growth() {
    for (array_depth, valid) in [(63, true), (64, false), (10_000, false)] {
        let source = format!(
            "---\nvalue: {}0{}\n---\n# Body",
            "[".repeat(array_depth),
            "]".repeat(array_depth)
        );
        let result = parse_markdown(&request(source)).unwrap();
        assert_eq!(
            result.diagnostics.is_empty(),
            valid,
            "array depth {array_depth}"
        );
        assert_eq!(result.headings[0].text, "Body");
        if !valid {
            assert_eq!(
                result.diagnostics[0].code,
                DiagnosticCode::FrontmatterResource,
                "array depth {array_depth}"
            );
        }
    }
}
#[test]
fn expanded_value_node_budget_does_not_truncate_a_yaml_map() {
    let source = format!(
        "---\nvalue: [{}]\n---\nVisible #body",
        vec!["0"; 100_001].join(",")
    );
    let result = parse_markdown(&request(source)).unwrap();
    assert!(result.properties.is_empty());
    assert_eq!(
        result.diagnostics[0].code,
        DiagnosticCode::FrontmatterResource
    );
    assert_eq!(result.tags, ["body"]);
}
#[test]
fn sparse_position_checkpoints_preserve_long_unicode_and_crlf_offsets() {
    let prefix = format!("{}\r\n", "😀e\u{301}".repeat(200));
    let source = format!("{prefix}[[目標#節]]\r\n- [é] tarea");
    let result = parse_markdown(&request(source.clone())).unwrap();
    let link = &result.links[0];
    let start = prefix.len() + 2;
    assert_eq!(
        link.target_range.bytes,
        [start as u32, (start + "目標".len()) as u32]
    );
    assert_eq!(
        link.target_range.utf16,
        [
            (prefix.encode_utf16().count() + 2) as u32,
            (prefix.encode_utf16().count() + 4) as u32
        ]
    );
    assert_eq!(result.tasks[0].line, 2);
    let task = &result.tasks[0];
    assert_eq!(
        &source[task.status_range.bytes[0] as usize..task.status_range.bytes[1] as usize],
        "é"
    );
}
#[test]
fn request_json_reuses_core_identity_validation() {
    for value in [
        r#"{"entryId":"bad:id","contentRevision":"rev-1","source":""}"#,
        r#"{"entryId":"good-id","contentRevision":"bad:revision","source":""}"#,
    ] {
        assert!(serde_json::from_str::<MetadataRequest>(value).is_err());
    }
}

#[test]
fn aliases_are_bounded_by_aggregate_decoded_bytes_before_cloning() {
    // About 20 KiB of input, but over 8 MiB of decoded alias materialization.
    // No giant allocation is necessary to exercise the amplification boundary.
    let source = format!(
        "---\nanchor: &shared \"{}\"\ncopies: [{}]\n---\nVisible #body",
        "x".repeat(16 * 1024),
        vec!["*shared"; 600].join(",")
    );
    let result = parse_markdown(&request(source)).unwrap();
    assert!(result.properties.is_empty());
    assert_eq!(
        result.diagnostics[0].code,
        DiagnosticCode::FrontmatterResource
    );
    assert_eq!(result.tags, ["body"]);
}

#[test]
fn initial_bom_does_not_add_markdown_indentation_or_logical_lines() {
    for spaces in 0..=3 {
        let source = format!("\u{feff}{}# Heading\n[[A]]", " ".repeat(spaces));
        let result = parse_markdown(&request(source.clone())).unwrap();
        assert_eq!(result.headings[0].text, "Heading", "indent {spaces}");
        assert_eq!(result.headings[0].line, 0);
        assert_eq!(result.headings[0].range.bytes[0], (3 + spaces) as u32);
        assert_eq!(result.headings[0].range.utf16[0], (1 + spaces) as u32);
        assert_eq!(result.links[0].target, "A");
    }
}
