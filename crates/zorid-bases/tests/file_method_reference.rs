//! Literal File-method oracles from the focused shipped-reference audit.
//! Shipped app.js SHA958ce57; REA parent
//! ev_adec5b213173bf4c29f475efced01626cf2cec1cebcf1e031b84e3bcb6ca1f7e.
//! Five inert source slices and hashes are retained in
//! /private/tmp/zorid-bases-file-method-reference-20261022/provenance.json.
//! Static evidence, not a claim of application runtime execution.
use zorid_bases::{evaluate_expression, BaseValue, DetachedRecord, EvaluationOptions};

fn boolean(path: &str, tags: &[&str], expression: &str) -> bool {
    let record = DetachedRecord {
        path: path.into(),
        tags: tags.iter().map(|tag| (*tag).into()).collect(),
        ..Default::default()
    };
    let result = evaluate_expression(expression, &record, &EvaluationOptions::default())
        .unwrap_or_else(|error| panic!("{path}: {expression}: {error}"));
    match result.value {
        BaseValue::Boolean { value } => value,
        other => panic!("{path}: {expression}: expected boolean, got {other:?}"),
    }
}

#[test]
fn root_folder_queries_include_root_and_nested_files() {
    for path in ["Note.md", "Books/Note.md", "Books/Deep/Note.md"] {
        for expression in ["file.inFolder('')", "file.inFolder('/')"] {
            assert!(boolean(path, &[], expression), "{path}: {expression}");
        }
    }
}

#[test]
fn folder_membership_is_case_sensitive_and_respects_segment_boundaries() {
    for (path, folder, expected) in [
        ("Books/Note.md", "Books", true),
        ("Books/Deep/Note.md", "Books", true),
        ("Bookshelf/Note.md", "Books", false),
        ("Books/Note.md", "books", false),
        ("Note.md", "Books", false),
    ] {
        let expression = format!("file.inFolder({})", serde_json::to_string(folder).unwrap());
        assert_eq!(
            boolean(path, &[], &expression),
            expected,
            "{path}: {expression}"
        );
    }
}

#[test]
fn file_tag_queries_add_only_one_missing_hash_and_keep_tag_boundaries() {
    let tags = ["#Work/Project", "#Personal"];
    for (expression, expected) in [
        ("file.hasTag('work')", true),
        ("file.hasTag('#WORK')", true),
        ("file.hasTag('work/project')", true),
        ("file.hasTag('work/pro')", false),
        ("file.hasTag('wor')", false),
        ("file.hasTag('##work')", false),
        ("file.hasTag('###work/project')", false),
        ("file.hasTag('missing', '#Personal')", true),
        ("file.hasTag('##personal', 'missing')", false),
        ("file.hasTag('')", false),
    ] {
        assert_eq!(
            boolean("Notes/Note.md", &tags, expression),
            expected,
            "{expression}"
        );
    }
}

#[test]
fn folder_queries_apply_only_the_shipped_separator_space_and_nfc_normalizers() {
    for (path, folder, expected) in [
        ("Books/Deep/Note.md", "/Books//Deep///", true),
        ("Books/Deep/Note.md", "\\Books\\\\Deep\\", true),
        ("Books/Deep/Note.md", "///\\\\///", true),
        ("Book Shelf/Note.md", "Book\u{00a0}Shelf", true),
        ("Book Shelf/Note.md", "Book\u{202f}Shelf", true),
        ("Book Shelf/Note.md", "/Book\u{00a0}Shelf/", true),
        ("Café/Note.md", "Cafe\u{0301}", true),
        // Captured paths retain their own spelling: normalize the query only.
        ("Cafe\u{0301}/Note.md", "Cafe\u{0301}", false),
        ("Books/Note.md", " Books ", false),
        ("Books/Note.md", "\tBooks\t", false),
        ("Book Shelf/Note.md", "Book  Shelf", false),
        ("Books/Deep/Note.md", "Books/./Deep", false),
        ("Books/Deep/Note.md", "Books/Other/../Deep", false),
        ("Books/Note.md", "Books/Note.md", false),
        ("Books/Note.md", "Books/Note", false),
    ] {
        let expression = format!("file.inFolder({})", serde_json::to_string(folder).unwrap());
        assert_eq!(
            boolean(path, &[], &expression),
            expected,
            "{path}: {expression}"
        );
    }
}

#[test]
fn tag_query_whitespace_and_repeated_hashes_are_literal_without_changing_other_tag_methods() {
    for (tags, expression, expected) in [
        (vec!["#Work"], "file.hasTag(' work')", false),
        (vec!["#Work"], "file.hasTag('work ')", false),
        (vec!["##Work"], "file.hasTag('##work')", true),
        (vec!["##Work"], "file.hasTag('#work')", false),
        (vec!["#ΟΣ/Child"], "file.hasTag('ος')", true),
        (vec!["#Work"], "file.tags.contains('##work')", false),
        (vec!["#Work/Project"], "file.tags.contains('work')", true),
        (vec!["#Work"], "file.hasTag()", false),
    ] {
        assert_eq!(
            boolean("Notes/Note.md", &tags, expression),
            expected,
            "{tags:?}: {expression}"
        );
    }
}

#[test]
fn folder_normalization_and_tag_comparisons_remain_work_bounded_and_cancellable() {
    let record = DetachedRecord {
        path: "Books/Note.md".into(),
        tags: vec!["#Work".into()],
        ..Default::default()
    };
    let expression = format!(
        "file.inFolder({})",
        serde_json::to_string(&"a".repeat(8_192)).unwrap()
    );
    let mut options = EvaluationOptions::default();
    options.max_steps = 64;
    assert_eq!(
        evaluate_expression(&expression, &record, &options)
            .unwrap_err()
            .code,
        "budget"
    );
    let expression = format!(
        "file.hasTag({})",
        serde_json::to_string(&"x".repeat(8_192)).unwrap()
    );
    assert_eq!(
        evaluate_expression(&expression, &record, &options)
            .unwrap_err()
            .code,
        "budget"
    );
    let cancellation = zorid_bases::OperationCancellation::default();
    cancellation.cancel();
    options.cancellation = Some(cancellation);
    assert_eq!(
        evaluate_expression("file.inFolder('/')", &record, &options)
            .unwrap_err()
            .code,
        "cancelled"
    );
    assert_eq!(
        evaluate_expression("file.hasTag('work')", &record, &options)
            .unwrap_err()
            .code,
        "cancelled"
    );
}

#[test]
fn file_methods_use_string_subclass_data_instead_of_rendered_markup_or_alias() {
    for expression in [
        "file.inFolder(link('Books'))",
        "file.inFolder(link('Books', 'Different display'))",
        "file.inFolder(html('Books'))",
    ] {
        assert!(boolean("Books/Note.md", &[], expression), "{expression}");
    }
    for expression in [
        "file.hasTag(link('work'))",
        "file.hasTag(link('work', 'Different display'))",
        "file.hasTag(html('work'))",
        "file.hasTag(file.tags[0])",
    ] {
        assert!(
            boolean("Books/Note.md", &["#Work"], expression),
            "{expression}"
        );
    }
}
