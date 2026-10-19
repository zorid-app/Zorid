//! Independent frozen semantic targets; raw Markdown is parsed for every case.
//! This executes pure Rust only, not retained-source/pin/platform admission.
use serde_json::{json, Value};
use zorid_core::{EntryId, Revision};
use zorid_document::{parse_markdown, DocumentMetadata, MetadataRequest};
use zorid_index::*;

fn metadata(source: &str) -> DocumentMetadata {
    parse_markdown(&MetadataRequest {
        entry_id: EntryId::new("search-entry").unwrap(),
        content_revision: Revision::new("search-revision").unwrap(),
        source: source.into(),
    })
    .unwrap()
}
fn compiled(query: &str) -> CompiledSearchQuery {
    CompiledSearchQuery::compile(query, SearchOptions::default(), SearchLimits::default()).unwrap()
}
fn run(query: &str, source: &str) -> SearchEvaluation {
    let m = metadata(source);
    compiled(query)
        .evaluate_checked(
            SearchDocument {
                path: "notes/Example.md",
                source: SearchSource::Text(source),
                metadata: SearchMetadataInput::Present(&m),
            },
            |_| Ok::<_, ()>(()),
        )
        .unwrap()
}
fn spans(result: SearchEvaluation) -> Option<Vec<[u32; 2]>> {
    match result {
        SearchEvaluation::NoMatch => None,
        SearchEvaluation::Match(m) => Some(m.content.iter().map(|r| r.range.utf16).collect()),
        SearchEvaluation::Unavailable(_) => panic!("unexpected unavailable"),
    }
}
/// Compare old reviewed field expectations while preserving the richer origin
/// DTO separately. This adapter only projects actual ranges; no expected value
/// is computed with the evaluator or injected metadata fixture.
fn legacy_shape(result: SearchEvaluation) -> Value {
    let m = match result {
        SearchEvaluation::NoMatch => return Value::Null,
        SearchEvaluation::Match(m) => m,
        SearchEvaluation::Unavailable(_) => panic!("unexpected unavailable"),
    };
    let mut out = serde_json::Map::new();
    let mut content: Vec<_> = m.content.iter().map(|r| r.range.utf16).collect();
    content.extend(
        m.tags
            .iter()
            .filter_map(|t| t.source_range.as_ref().map(|r| r.utf16)),
    );
    content.sort_unstable();
    content.dedup();
    if !content.is_empty() || !m.tags.is_empty() {
        out.insert("content".into(), json!(content));
    }
    if let Some(field) = m.filename {
        out.insert(
            "filename".into(),
            json!(field.ranges.iter().map(|r| r.utf16).collect::<Vec<_>>()),
        );
    }
    if let Some(field) = m.filepath {
        out.insert(
            "filepath".into(),
            json!(field.ranges.iter().map(|r| r.utf16).collect::<Vec<_>>()),
        );
    }
    let mut props = Vec::new();
    for p in m.properties {
        if let Some(value) = p.value {
            for range in value.ranges {
                let mut record = json!({"key":p.key,"pos":range.utf16});
                if !p.array_path.is_empty() {
                    record["subkey"] = json!(p.array_path);
                }
                props.push(record);
            }
        } else {
            props.push(json!({"key":p.key}));
        }
    }
    if !props.is_empty() {
        out.insert("properties".into(), json!(props));
    }
    Value::Object(out)
}
fn target_cases(corpus: &str, count: usize) {
    let corpus: Value = serde_json::from_str(corpus).unwrap();
    let cases = corpus["cases"].as_array().unwrap();
    assert_eq!(cases.len(), count);
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let source = case["document"]["text"].as_str().unwrap();
        let path = case["document"]["path"].as_str().unwrap();
        let m = metadata(source);
        let options = SearchOptions {
            case_sensitive: case["options"]["caseSensitive"].as_bool().unwrap_or(false),
        };
        let query = CompiledSearchQuery::compile(
            case["query"].as_str().unwrap(),
            options,
            SearchLimits::default(),
        );
        if matches!(
            case["target"]["kind"].as_str(),
            Some("unsupported" | "error")
        ) {
            let error = query
                .err()
                .unwrap_or_else(|| panic!("{id}: expected compile diagnostic"));
            assert_eq!(
                serde_json::to_value(error.code).unwrap(),
                case["target"]["category"],
                "{id}"
            );
            continue;
        }
        let q = query.unwrap_or_else(|e| panic!("{id}: {e}"));
        let result = q
            .evaluate_checked(
                SearchDocument {
                    path,
                    source: SearchSource::Text(source),
                    metadata: SearchMetadataInput::Present(&m),
                },
                |_| Ok::<_, ()>(()),
            )
            .unwrap_or_else(|e| panic!("{id}: {e:?}"));
        if let SearchEvaluation::Match(matches) = &result {
            for witness in case["rangeWitnesses"].as_array().into_iter().flatten() {
                assert!(
                    matches
                        .content
                        .iter()
                        .any(|r| json!(r.range.bytes) == witness["bytes"]
                            && json!(r.range.utf16) == witness["utf16"]),
                    "{id}: byte/UTF16 witness {witness}"
                );
                let b = witness["bytes"].as_array().unwrap();
                assert_eq!(
                    &source[b[0].as_u64().unwrap() as usize..b[1].as_u64().unwrap() as usize],
                    witness["text"].as_str().unwrap(),
                    "{id}"
                );
            }
        }
        assert_eq!(legacy_shape(result), case["target"]["value"], "{id}");
    }
}
#[test]
fn reviewed_nineteen_target_oracles_use_actual_parser_without_changing_old_literal_oracles() {
    target_cases(
        include_str!("../../../tests/fixtures/document-semantics/search/s1-language.json"),
        19,
    );
}
#[test]
fn pinned_unicode_scalar_simplefold_and_regex_diagnostics() {
    target_cases(
        include_str!("../../../tests/fixtures/document-semantics/search/s1-unicode-regex.json"),
        36,
    );
}
#[test]
fn boolean_precedence_tolerant_grammar_and_all_normalized_occurrences() {
    for (q, text, expected) in [
        ("alpha beta OR gamma", "gamma", Some(vec![[0, 5]])),
        ("alpha beta OR gamma", "alpha", None),
        ("alpha beta", "alpha\nbeta", Some(vec![[0, 5], [6, 10]])),
        (
            "(alpha OR beta) gamma",
            "beta gamma",
            Some(vec![[0, 4], [5, 10]]),
        ),
        ("cat OR at", "cat", Some(vec![[0, 3]])),
        ("😀 OR cat", "😀cat", Some(vec![[0, 5]])),
        ("a or b", "a b", None),
        ("a\tb", "a b", None),
        ("well-known", "well-known", Some(vec![[0, 10]])),
        ("\"two words", "two words", Some(vec![[0, 9]])),
        ("(alpha OR beta", "beta", Some(vec![[0, 4]])),
        ("alpha OR", "alpha", Some(vec![[0, 5]])),
        ("alpha ) absent", "alpha", Some(vec![[0, 5]])),
        ("file:", "anything", None),
    ] {
        assert_eq!(spans(run(q, text)), expected, "{q}");
    }
    assert_eq!(spans(run("-alpha", "beta")), Some(vec![]));
    assert_eq!(spans(run("", "body")), None);
}
#[test]
fn raw_blocks_tasks_and_heading_sections_have_real_parser_intervals() {
    let text = "alpha\nbeta\n\n- alpha\n- beta";
    assert_eq!(
        spans(run("block:(alpha beta)", text)),
        Some(vec![[0, 5], [6, 10]])
    );
    assert_eq!(spans(run("line:(alpha beta)", text)), None);
    let text = "- [ ] todo\n- [x] done\n- [-] custom\n- ordinary";
    assert_eq!(spans(run("task-todo:\"\"", text)), Some(vec![[0, 0]]));
    assert_eq!(
        spans(run("task-done:\"\"", text)),
        Some(vec![[11, 11], [22, 22]])
    );
    assert_eq!(spans(run("task:custom", text)), Some(vec![[28, 34]]));
    let text = "intro\n# Parent\nalpha\n## Child\nbeta\n### Deep\ngamma\n# Other\ndelta";
    assert_eq!(spans(run("section:(alpha beta)", text)), None);
    assert_eq!(
        spans(run("section:(alpha section:beta)", text)),
        Some(vec![[15, 20], [30, 34]])
    );
    assert_eq!(
        spans(run("section:(alpha section:(beta section:gamma))", text)),
        Some(vec![[15, 20], [30, 34], [44, 49]])
    );
    assert_eq!(spans(run("section:(beta section:delta)", text)), None);
    // Approved real-parser correction: no optional-heading-field distinction.
    assert_eq!(spans(run("section:alpha", "alpha")), Some(vec![[0, 5]]));
    assert_eq!(spans(run("section:section:alpha", "alpha")), None);
}
#[test]
fn typed_properties_tags_and_metadata_coordinates_are_not_source_offsets() {
    let text="---\nStatus: active\nStatus Detail: pending\ntruth: true\nfalsity: false\nempty: null\nblank: ''\nnumber: 12\nstring: '12'\nitems: [active, inactive]\nobject: {active: true}\n---\n";
    assert_eq!(
        legacy_shape(run("[status]", text)),
        json!({"properties":[{"key":"Status"},{"key":"Status Detail"}]})
    );
    assert_eq!(
        legacy_shape(run("match-case:[\"status\"]", text)),
        json!({"properties":[{"key":"Status"}]})
    );
    assert_eq!(run("match-case:[status]", text), SearchEvaluation::NoMatch);
    assert_eq!(
        legacy_shape(run("[truth:TRUE]", text)),
        json!({"properties":[{"key":"truth","pos":[0,4]}]})
    );
    assert!(matches!(
        run("[falsity:FALSE]", text),
        SearchEvaluation::Match(_)
    ));
    assert!(matches!(
        run("[empty:EMPTY]", text),
        SearchEvaluation::Match(_)
    ));
    assert_eq!(run("[blank:EMPTY]", text), SearchEvaluation::NoMatch);
    assert_eq!(run("[missing:EMPTY]", text), SearchEvaluation::NoMatch);
    assert!(matches!(
        run("[number:>9]", text),
        SearchEvaluation::Match(_)
    ));
    assert_eq!(run("[string:>9]", text), SearchEvaluation::NoMatch);
    assert_eq!(
        legacy_shape(run("[items:\"active\"]", text)),
        json!({"properties":[{"key":"items","subkey":[0],"pos":[0,6]}]})
    );
    assert_eq!(run("[Status:-absent]", text), SearchEvaluation::NoMatch);
    assert!(matches!(
        run("[Status:(active -absent)]", text),
        SearchEvaluation::Match(_)
    ));
    assert_eq!(run("[object:active]", text), SearchEvaluation::NoMatch);
    assert!(matches!(
        run("[object:<a]", text),
        SearchEvaluation::Match(_)
    ));
    let SearchEvaluation::Match(m) = run("[items:active]", text) else {
        panic!()
    };
    assert!(m.content.is_empty());
    assert_eq!(m.properties[0].value.as_ref().unwrap().text, "active");
    let tags = "---\nTags: [work/child, other]\n---\n#Work #work/sub #workshop";
    let SearchEvaluation::Match(m) = run("match-case:tag:WORK", tags) else {
        panic!()
    };
    assert!(m.content.is_empty());
    assert_eq!(
        m.tags.iter().filter(|t| t.source_range.is_some()).count(),
        2
    );
    assert_eq!(m.properties[0].key, "Tags");
    // Approved provenance correction: legacy TS invented [0,4] for null even
    // into unrelated/short source. A root EMPTY success has no source locations.
    assert_eq!(
        run("EMPTY", "x"),
        SearchEvaluation::Match(SearchMatches::default())
    );
}
#[test]
fn explicit_input_availability_and_attachment_names_never_require_body() {
    let q = compiled("file:photo OR path:media");
    assert_eq!(
        q.requirements(),
        SearchRequirements {
            content: false,
            metadata: false
        }
    );
    let result = q
        .evaluate_checked(
            SearchDocument {
                path: "media/photo.png",
                source: SearchSource::NotText,
                metadata: SearchMetadataInput::NotApplicable,
            },
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
    let SearchEvaluation::Match(m) = result else {
        panic!()
    };
    assert!(m.content.is_empty());
    assert_eq!(m.filename.unwrap().value, "photo.png");
    assert_eq!(m.filepath.unwrap().value, "media/photo.png");
    assert_eq!(
        compiled("content:photo")
            .evaluate_checked(
                SearchDocument {
                    path: "photo.png",
                    source: SearchSource::NotText,
                    metadata: SearchMetadataInput::NotApplicable
                },
                |_| Ok::<_, ()>(())
            )
            .unwrap(),
        SearchEvaluation::NoMatch
    );
    assert!(matches!(
        compiled("content:alpha")
            .evaluate_checked(
                SearchDocument {
                    path: "note.md",
                    source: SearchSource::Unavailable,
                    metadata: SearchMetadataInput::Unavailable
                },
                |_| Ok::<_, ()>(())
            )
            .unwrap(),
        SearchEvaluation::Unavailable(SearchRequirements {
            content: true,
            metadata: false
        })
    ));
    let text = "---\nstatus: active\n---\n";
    let m = metadata(text);
    assert!(matches!(
        compiled("[status:active]")
            .evaluate_checked(
                SearchDocument {
                    path: "note.md",
                    source: SearchSource::Unavailable,
                    metadata: SearchMetadataInput::Present(&m)
                },
                |_| Ok::<_, ()>(())
            )
            .unwrap(),
        SearchEvaluation::Match(_)
    ));
    assert_eq!(
        compiled("[status]").requirements(),
        SearchRequirements {
            content: false,
            metadata: true
        }
    );
    assert_eq!(
        compiled("tag:work").requirements(),
        SearchRequirements {
            content: false,
            metadata: true
        }
    );
}
#[test]
fn diagnostics_cancellation_limits_and_anchors_remain_explicit() {
    for (query, code) in [
        ("file:path:x", SearchDiagnosticCode::InvalidNesting),
        ("line:task:x", SearchDiagnosticCode::InvalidNesting),
        ("section:line:x", SearchDiagnosticCode::InvalidNesting),
        ("[a:[b]]", SearchDiagnosticCode::InvalidNesting),
        ("tag:\"topic\"", SearchDiagnosticCode::InvalidOperand),
        ("tag:/topic/", SearchDiagnosticCode::InvalidOperand),
        (">/3/", SearchDiagnosticCode::InvalidOperand),
    ] {
        let e =
            CompiledSearchQuery::compile(query, SearchOptions::default(), SearchLimits::default())
                .err()
                .unwrap();
        assert_eq!(e.code, code, "{query}");
        assert!(e.query_range.bytes[1] as usize <= query.len());
    }
    let q = compiled("alpha");
    let document = || SearchDocument {
        path: "Note.md",
        source: SearchSource::Text("alpha"),
        metadata: SearchMetadataInput::NotApplicable,
    };
    assert!(matches!(
        q.evaluate_checked(document(), |_| Err("cancel")),
        Err(SearchError::Host("cancel"))
    ));
    let mut limits = SearchLimits::default();
    limits.spans = 1;
    let q = CompiledSearchQuery::compile("a", SearchOptions::default(), limits).unwrap();
    assert!(matches!(
        q.evaluate_checked(
            SearchDocument {
                path: "Note.md",
                source: SearchSource::Text("a a"),
                metadata: SearchMetadataInput::NotApplicable
            },
            |_| Ok::<_, ()>(())
        ),
        Err(SearchError::Resource(_))
    ));
    let query = format!("{}a{}", "(".repeat(100), ")".repeat(100));
    assert_eq!(
        CompiledSearchQuery::compile(&query, SearchOptions::default(), SearchLimits::default())
            .err()
            .unwrap()
            .code,
        SearchDiagnosticCode::Resource
    );
    let SearchEvaluation::Match(m) = run("line:-alpha", "alpha\nbeta") else {
        panic!()
    };
    assert_eq!(m.content[0].kind, SearchContentKind::Anchor);
    assert_eq!(m.content[0].range.utf16, [6, 6]);
    assert_eq!(spans(run("/^/", "😀\na")), None);
    for _ in 0..3 {
        assert_eq!(
            spans(run("/alpha/", "alpha alpha")),
            Some(vec![[0, 5], [6, 11]])
        );
    }
}

#[test]
fn aggregate_regex_bounds_and_caller_tightening_fail_explicitly() {
    let mut limits = SearchLimits::default();
    limits.regex_bytes = 1;
    assert_eq!(
        CompiledSearchQuery::compile("/a/", SearchOptions::default(), limits)
            .err()
            .unwrap()
            .code,
        SearchDiagnosticCode::Resource
    );
    let mut limits = SearchLimits::default();
    limits.regex_variant_bytes = 1;
    // An exact literal can bypass the engine's NFA entirely; exercise a
    // genuine variable-length regex before asserting its component budget.
    assert_eq!(
        CompiledSearchQuery::compile("/[ab]+/", SearchOptions::default(), limits)
            .err()
            .unwrap()
            .code,
        SearchDiagnosticCode::Resource
    );
    let mut limits = SearchLimits::default();
    limits.tokens = 1;
    assert_eq!(
        CompiledSearchQuery::compile("a b", SearchOptions::default(), limits)
            .err()
            .unwrap()
            .code,
        SearchDiagnosticCode::Resource
    );
    let mut limits = SearchLimits::default();
    limits.work = 0;
    let q = CompiledSearchQuery::compile("a", SearchOptions::default(), limits).unwrap();
    assert!(matches!(
        q.evaluate_checked(
            SearchDocument {
                path: "Note.md",
                source: SearchSource::Text("a"),
                metadata: SearchMetadataInput::NotApplicable
            },
            |_| Ok::<_, ()>(())
        ),
        Err(SearchError::Resource(_))
    ));
    let mut limits = SearchLimits::default();
    limits.output_bytes = 1;
    let q = CompiledSearchQuery::compile("a", SearchOptions::default(), limits).unwrap();
    assert!(matches!(
        q.evaluate_checked(
            SearchDocument {
                path: "Note.md",
                source: SearchSource::Text("a"),
                metadata: SearchMetadataInput::NotApplicable
            },
            |_| Ok::<_, ()>(())
        ),
        Err(SearchError::Resource(_))
    ));
}

#[test]
fn numeric_comparison_uses_string_numeric_literal_not_rust_inf_or_u64_limits() {
    let source = "---\nnumber: 12\n---\n";
    // A leading minus is search negation unless the operand is quoted.
    // Preserve that grammar while testing StringNumericLiteral conversion.
    assert_eq!(
        CompiledSearchQuery::compile(
            "[number:>-inf]",
            SearchOptions::default(),
            SearchLimits::default()
        )
        .err()
        .unwrap()
        .code,
        SearchDiagnosticCode::InvalidOperand
    );
    for query in ["[number:<inf]", "[number:>\"-inf\"]", "[number:<Infinityx]"] {
        assert_eq!(run(query, source), SearchEvaluation::NoMatch, "{query}");
    }
    for query in [
        "[number:<0x10000000000000000]",
        "[number:<0b10000000000000000000000000000000000000000000000000000000000000000]",
        "[number:<Infinity]",
    ] {
        assert!(
            matches!(run(query, source), SearchEvaluation::Match(_)),
            "{query}"
        );
    }
    let query = format!("[number:<0x{}]", "f".repeat(300));
    assert!(matches!(run(&query, source), SearchEvaluation::Match(_)));
}
#[test]
fn extended_mode_comments_do_not_invent_unsupported_capabilities() {
    let query = "content:/(?x:a # (?=ignored) \\1\n)/";
    assert_eq!(spans(run(query, "a")), Some(vec![[0, 1]]));
    for query in [
        "content:/(?x:a # (?=ignored)\n[)/",
        "content:/(?x:a # \\k<ignored>\n[)/",
    ] {
        assert_eq!(
            CompiledSearchQuery::compile(query, SearchOptions::default(), SearchLimits::default())
                .err()
                .unwrap()
                .code,
            SearchDiagnosticCode::InvalidRegex
        );
    }
    assert_eq!(
        CompiledSearchQuery::compile(
            "content:/(?x:a # ignored\n(?=a))/",
            SearchOptions::default(),
            SearchLimits::default()
        )
        .err()
        .unwrap()
        .code,
        SearchDiagnosticCode::UnsupportedRegex
    );
    assert!(CompiledSearchQuery::compile(
        r"content:/[\\(][?=]/",
        SearchOptions::default(),
        SearchLimits::default()
    )
    .is_ok());
}

#[test]
fn escaped_delimiters_origin_diagnostics_and_named_only_paths() {
    assert_eq!(
        spans(run(r#""say \"hi\"""#, "say \"hi\"")),
        Some(vec![[0, 8]])
    );
    assert_eq!(spans(run(r#""a\\b""#, "a\\b")), Some(vec![[0, 3]]));
    let q = CompiledSearchQuery::compile(
        "😀 OR unknown:x",
        SearchOptions::default(),
        SearchLimits::default(),
    )
    .err()
    .unwrap();
    assert_eq!(q.query_range.bytes, [8, 15]);
    assert_eq!(q.query_range.utf16, [6, 13]);
    for (path, query, matched) in [
        ("media/photo.png", "photo", false),
        ("notes/Example.canvas", "Example", true),
        ("data.base", "secret", false),
        ("data.base", "content:secret", true),
    ] {
        let q = compiled(query);
        let result = q
            .evaluate_checked(
                SearchDocument {
                    path,
                    source: SearchSource::Text("secret"),
                    metadata: SearchMetadataInput::NotApplicable,
                },
                |_| Ok::<_, ()>(()),
            )
            .unwrap();
        assert_eq!(
            matches!(result, SearchEvaluation::Match(_)),
            matched,
            "{path}:{query}"
        );
    }
    assert_eq!(run("tag:##work", "#work"), SearchEvaluation::NoMatch);
    let m = metadata("---\nnumber: 12\n---\n");
    let q = compiled("[number:<\"\u{feff}13\"]");
    assert!(matches!(
        q.evaluate_checked(
            SearchDocument {
                path: "Note.md",
                source: SearchSource::Unavailable,
                metadata: SearchMetadataInput::Present(&m)
            },
            |_| Ok::<_, ()>(())
        )
        .unwrap(),
        SearchEvaluation::Match(_)
    ));
    let mut limits = SearchLimits::default();
    limits.nodes = 1;
    assert_eq!(
        CompiledSearchQuery::compile("file:", SearchOptions::default(), limits)
            .err()
            .unwrap()
            .code,
        SearchDiagnosticCode::Resource
    );
}

#[test]
fn extended_character_class_comments_preserve_malformed_diagnostics() {
    assert_eq!(
        spans(run("content:/(?x:[a # ] (?=ignored)\n b])/", "b")),
        Some(vec![[0, 1]])
    );
    let malformed = "content:/(?x:[a # ] (?=ignored)\n b] ()/";
    assert_eq!(
        CompiledSearchQuery::compile(malformed, SearchOptions::default(), SearchLimits::default())
            .err()
            .unwrap()
            .code,
        SearchDiagnosticCode::InvalidRegex
    );
    let unsupported = "content:/(?x:[a # (?=ignored)\n b](?=a))/";
    assert_eq!(
        CompiledSearchQuery::compile(
            unsupported,
            SearchOptions::default(),
            SearchLimits::default()
        )
        .err()
        .unwrap()
        .code,
        SearchDiagnosticCode::UnsupportedRegex
    );
}

#[test]
fn tag_property_provenance_names_actual_first_selected_case_variant() {
    let source = "---\nTags: [work]\ntags: [other]\n---\n";
    let m = metadata(source);
    let evaluate = |q: &str| {
        compiled(q)
            .evaluate_checked(
                SearchDocument {
                    path: "Note.md",
                    source: SearchSource::Unavailable,
                    metadata: SearchMetadataInput::Present(&m),
                },
                |_| Ok::<_, ()>(()),
            )
            .unwrap()
    };
    let SearchEvaluation::Match(found) = evaluate("tag:work") else {
        panic!("first selected property should match")
    };
    assert!(found.content.is_empty());
    assert!(found.tags.is_empty());
    assert_eq!(
        found.properties,
        vec![SearchPropertyMatch {
            key: "Tags".into(),
            array_path: vec![],
            value: None
        }]
    );
    assert_eq!(
        evaluate("tag:other"),
        SearchEvaluation::NoMatch,
        "preserve first selected value, not lowercase-key preference"
    );
}

#[test]
fn four_mebibyte_dense_literals_and_quotes_keep_all_ranges_within_work_budget() {
    // Independent arithmetic fixture:8192 records,512 bytes each, one six-byte
    // word per record. LF/space endpoints also satisfy quoted word boundaries.
    // The old remaining-haystack-per-hit bill exceeds2M after about32 calls,
    // although literal searches consume disjoint prefixes of this4MiB field.
    let record = format!("needle {}\n", "x".repeat(504));
    assert_eq!(record.len(), 512);
    let source = record.repeat(8192);
    assert_eq!(source.len(), 4 * 1024 * 1024);
    for query in ["content:needle", "content:\"needle\"", "content:/needle/"] {
        let q = compiled(query);
        let mut work = 0usize;
        let result = q
            .evaluate_checked(
                SearchDocument {
                    path: "Note.md",
                    source: SearchSource::Text(&source),
                    metadata: SearchMetadataInput::NotApplicable,
                },
                |units| {
                    work += units;
                    Ok::<_, ()>(())
                },
            )
            .unwrap();
        let SearchEvaluation::Match(found) = result else {
            panic!("{query}: expected full match")
        };
        assert_eq!(found.content.len(), 8192, "{query}");
        assert!(work <= 2_000_000, "{query}: observed work{work}");
        println!(
            "dense_literal query={query:?} source_bytes={} occurrences={} work_units={work}",
            source.len(),
            found.content.len()
        );
        assert!(serde_json::to_vec(&found).unwrap().len() <= 1024 * 1024);
        for (i, hit) in found.content.iter().enumerate() {
            let start = (i * 512) as u32;
            assert_eq!(hit.kind, SearchContentKind::Occurrence);
            assert_eq!(hit.range.bytes, [start, start + 6]);
            assert_eq!(hit.range.utf16, [start, start + 6]);
            assert_eq!(&source[start as usize..start as usize + 6], "needle");
        }
    }
}
