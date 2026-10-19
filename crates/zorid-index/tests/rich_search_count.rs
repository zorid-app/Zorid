//! Independent occurrence/count targets. Highlight fixtures stay unchanged.
//! Pure evaluator evidence only; no retained-source or native admission claim.
use zorid_core::{EntryId, Revision};
use zorid_document::{parse_markdown, MetadataRequest};
use zorid_index::*;

fn compiled(query: &str) -> CompiledSearchQuery {
    CompiledSearchQuery::compile(query, SearchOptions::default(), SearchLimits::default()).unwrap()
}
fn evaluate(query: &str, source: &str) -> SearchMatches {
    let metadata = parse_markdown(&MetadataRequest {
        entry_id: EntryId::new("count-entry").unwrap(),
        content_revision: Revision::new("count-revision").unwrap(),
        source: source.into(),
    })
    .unwrap();
    let result = compiled(query)
        .evaluate_checked(
            SearchDocument {
                path: "notes/Example.md",
                source: SearchSource::Text(source),
                metadata: SearchMetadataInput::Present(&metadata),
            },
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
    let SearchEvaluation::Match(result) = result else {
        panic!("expected match: {query}")
    };
    result
}
fn locations(result: &SearchMatches) -> Vec<SearchLocation> {
    (0..result.locations_len())
        .map(|i| {
            let location = result.location(i).unwrap();
            assert_eq!(location.index, i as u32);
            location
        })
        .collect()
}
#[test]
fn touching_occurrences_keep_counts_beneath_legacy_touch_merged_highlights() {
    for query in ["content:aa", "content:aa OR content:aa"] {
        let result = evaluate(query, "aaaa");
        assert_eq!(result.content.len(), 1);
        assert_eq!(result.content[0].range.bytes, [0, 4]);
        assert_eq!(result.occurrence_count, 2);
        let location = result.location(0).unwrap();
        assert_eq!(result.locations_len(), 1);
        assert_eq!(location.occurrences, 2);
        assert_eq!(location.role, SearchLocationRole::Occurrence);
        assert!(
            matches!(location.locator, SearchLocator::Source { range, kind: SearchContentKind::Occurrence } if range.bytes == [0, 4])
        );
        assert_eq!(result.location(1), None);
    }
    // The third span bridges the two touching spans: one strict component.
    for query in ["content:aaa OR content:aa", "content:aa OR content:aaa"] {
        assert_eq!(evaluate(query, "aaaa").occurrence_count, 1);
    }
    assert_eq!(
        evaluate("content:aa OR content:aa", "aa").occurrence_count,
        1
    );
}
#[test]
fn only_successful_boolean_branches_and_scoped_source_results_contribute() {
    let result = evaluate("(content:aa content:missing) OR content:bb", "aabb");
    assert_eq!(result.occurrence_count, 1);
    assert_eq!(result.content[0].range.bytes, [2, 4]);
    let result = evaluate("line:(aa OR bb)", "aa\nbb");
    assert_eq!(result.occurrence_count, 2);
    assert_eq!(
        locations(&result)
            .iter()
            .map(|l| l.occurrences)
            .sum::<u32>(),
        2
    );
    let result = evaluate("section:(aa section:bb)", "# Parent\naa\n## Child\nbb");
    assert_eq!(result.occurrence_count, 2);
}
#[test]
fn source_filename_and_path_remain_distinct_coordinate_origins() {
    let SearchEvaluation::Match(result) = compiled("content:aa OR file:aa OR path:aa")
        .evaluate_checked(
            SearchDocument {
                path: "aa/aa.md",
                source: SearchSource::Text("aa"),
                metadata: SearchMetadataInput::NotApplicable,
            },
            |_| Ok::<_, ()>(()),
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(result.occurrence_count, 4);
    let locations = locations(&result);
    assert_eq!(locations.len(), 4);
    assert!(matches!(locations[0].locator, SearchLocator::Source { .. }));
    assert!(matches!(
        locations[1].locator,
        SearchLocator::Filename { .. }
    ));
    assert!(matches!(locations[2].locator, SearchLocator::Path { .. }));
    assert!(matches!(locations[3].locator, SearchLocator::Path { .. }));
}
#[test]
fn key_ranges_are_in_actual_key_and_positive_ranges_replace_exists_across_or() {
    let source = "---\nStatus Detail: pending\n---\n";
    let result = evaluate("[status]", source);
    assert_eq!(result.occurrence_count, 1);
    assert!(
        matches!(&result.properties[0].key_match, Some(SearchKeyMatch::Ranges { ranges }) if ranges.len() == 1 && ranges[0].bytes == [0,6])
    );
    let location = result.location(0).unwrap();
    assert!(
        matches!(location.locator, SearchLocator::PropertyKey { key, key_match: SearchKeyMatch::Ranges { ranges } } if key == "Status Detail" && ranges[0].utf16 == [0,6])
    );
    let source = "---\nStatusStatus: pending\n---\n";
    for query in [
        "[status] OR [-missing]",
        "[-missing] OR [status]",
        "[status] OR [status]",
    ] {
        let result = evaluate(query, source);
        assert_eq!(result.occurrence_count, 2, "{query}");
        assert_eq!(result.locations_len(), 1);
        let location = result.location(0).unwrap();
        assert_eq!(location.occurrences, 2);
        assert_eq!(location.role, SearchLocationRole::Occurrence);
        assert!(
            matches!(location.locator, SearchLocator::PropertyKey { key_match: SearchKeyMatch::Ranges { ranges }, .. } if ranges.len() == 1 && ranges[0].bytes == [0,12])
        );
    }
    let result = evaluate("[-missing] OR [-missing]", source);
    assert_eq!(result.occurrence_count, 1);
    let location = result.location(0).unwrap();
    assert_eq!(location.role, SearchLocationRole::Existence);
    assert_eq!(location.occurrences, 1);
    assert!(matches!(
        location.locator,
        SearchLocator::PropertyKey {
            key_match: SearchKeyMatch::Exists,
            ..
        }
    ));
    let result = evaluate("[status]", "---\n😀Status: pending\n---\n");
    assert!(
        matches!(result.location(0).unwrap().locator, SearchLocator::PropertyKey { key_match: SearchKeyMatch::Ranges { ranges }, .. } if ranges[0].bytes == [4,10] && ranges[0].utf16 == [2,8])
    );
}
#[test]
fn property_value_origins_include_actual_key_array_path_and_rendered_value() {
    let source = "---\nitems: [aaaa, aaaa]\nother: aaaa\n---\n";
    let result = evaluate("[items:aa] OR [items:aa] OR [other:aa]", source);
    assert_eq!(result.occurrence_count, 6);
    assert_eq!(result.locations_len(), 3);
    assert!(result.properties.iter().all(|p| p.key_match.is_none()));
    for (i, expected) in [
        (0, ("items", vec![0])),
        (1, ("items", vec![1])),
        (2, ("other", vec![])),
    ] {
        let location = result.location(i).unwrap();
        assert_eq!(location.occurrences, 2);
        assert!(
            matches!(location.locator, SearchLocator::PropertyValue { key, array_path, value_text, range } if key == expected.0 && array_path == expected.1 && value_text == "aaaa" && range.bytes == [0,4])
        );
    }
    assert_eq!(
        evaluate("[items:aaa] OR [items:aa]", source).occurrence_count,
        2
    );
}
#[test]
fn inline_tags_and_content_union_without_inventing_frontmatter_source_locations() {
    let result = evaluate("tag:work OR content:work", "#work #work");
    assert_eq!(result.occurrence_count, 2);
    let locations = locations(&result);
    assert_eq!(locations.len(), 2);
    assert!(
        matches!(&locations[0].locator, SearchLocator::Source { range, .. } if range.bytes == [0,5])
    );
    assert!(
        matches!(&locations[1].locator, SearchLocator::Source { range, .. } if range.bytes == [6,11])
    );
    let source = "😀 #work #work";
    let metadata = parse_markdown(&MetadataRequest {
        entry_id: EntryId::new("tag-entry").unwrap(),
        content_revision: Revision::new("tag-rev").unwrap(),
        source: source.into(),
    })
    .unwrap();
    let SearchEvaluation::Match(result) = compiled("tag:work OR tag:work")
        .evaluate_checked(
            SearchDocument {
                path: "Note.md",
                source: SearchSource::Unavailable,
                metadata: SearchMetadataInput::Present(&metadata),
            },
            |_| Ok::<_, ()>(()),
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(result.occurrence_count, 2);
    assert!(
        matches!(result.location(0).unwrap().locator, SearchLocator::Source { range, .. } if range.bytes == [5,10] && range.utf16 == [3,8])
    );
    let result = evaluate(
        "tag:work OR tag:work",
        "---\nTags: [work, work/child]\n---\n",
    );
    assert_eq!(result.occurrence_count, 1);
    assert_eq!(result.locations_len(), 1);
    assert!(
        matches!(result.location(0).unwrap().locator, SearchLocator::PropertyKey { key, key_match: SearchKeyMatch::Exists } if key == "Tags")
    );
}
#[test]
fn anchors_and_exclusion_only_success_have_no_occurrences() {
    let result = evaluate("line:-absent", "one\ntwo");
    assert_eq!(result.occurrence_count, 0);
    assert_eq!(result.locations_len(), 2);
    assert!(locations(&result)
        .iter()
        .all(|l| l.role == SearchLocationRole::Anchor && l.occurrences == 0));
    for query in ["content:-absent", "EMPTY"] {
        let result = evaluate(query, "one\ntwo");
        assert_eq!(result.occurrence_count, 0);
        assert_eq!(result.locations_len(), 0);
    }
}
#[test]
fn cancellation_and_work_limits_cover_every_success_path_checkpoint() {
    let query = compiled("content:aa OR content:aa");
    let document = || SearchDocument {
        path: "Note.md",
        source: SearchSource::Text("aaaa"),
        metadata: SearchMetadataInput::NotApplicable,
    };
    let mut checkpoints = 0usize;
    let mut units = 0usize;
    query
        .evaluate_checked(document(), |n| {
            checkpoints += 1;
            units += n;
            Ok::<_, ()>(())
        })
        .unwrap();
    for stop in 1..=checkpoints {
        let mut seen = 0;
        assert!(
            matches!(
                query.evaluate_checked(document(), |_| {
                    seen += 1;
                    if seen == stop {
                        Err("cancel")
                    } else {
                        Ok(())
                    }
                }),
                Err(SearchError::Host("cancel"))
            ),
            "checkpoint {stop}"
        );
    }
    for (maximum, succeeds) in [(units, true), (units - 1, false)] {
        let mut limits = SearchLimits::default();
        limits.work = maximum;
        let bounded = CompiledSearchQuery::compile(
            "content:aa OR content:aa",
            SearchOptions::default(),
            limits,
        )
        .unwrap();
        let result = bounded.evaluate_checked(document(), |_| Ok::<_, ()>(()));
        if succeeds {
            assert!(result.is_ok());
        } else {
            assert!(matches!(result, Err(SearchError::Resource(_))));
        }
    }
}
#[test]
fn retained_accounting_includes_spare_capacity_and_location_access_is_fallible() {
    let mut result = evaluate("[status]", "---\nStatus Detail: pending\n---\n");
    let before = result.retained_bytes();
    let old_capacity = result.properties.capacity();
    result.properties.reserve(100);
    assert_eq!(
        result.retained_bytes() - before,
        (result.properties.capacity() - old_capacity) * std::mem::size_of::<SearchPropertyMatch>()
    );
    let before = result.retained_bytes();
    let old_capacity = result.properties[0].key.capacity();
    result.properties[0].key.reserve(100);
    assert_eq!(
        result.retained_bytes() - before,
        result.properties[0].key.capacity() - old_capacity
    );
    result.properties.clear();
    assert_eq!(result.location(0), None);
    let mut result = evaluate("[status:aa]", "---\nstatus: aaaa\n---\n");
    result.properties[0].value = None;
    assert_eq!(result.location(0), None);
}

#[test]
fn body_free_tag_union_rejects_inconsistent_utf16_endpoint_order_and_deltas() {
    use zorid_document::{SourceRange, TagOccurrence};
    // Every individual range is ordered and within these retained source bounds.
    // Cross-range coordinate corruption must not become an inverted union.
    let mut metadata = parse_markdown(&MetadataRequest {
        entry_id: EntryId::new("corrupt-tag-entry").unwrap(),
        content_revision: Revision::new("corrupt-tag-revision").unwrap(),
        source: " ".repeat(64),
    })
    .unwrap();
    let query = compiled("tag:work");
    for ranges in [
        [
            SourceRange {
                bytes: [0, 5],
                utf16: [10, 15],
            },
            SourceRange {
                bytes: [4, 10],
                utf16: [0, 6],
            },
        ],
        [
            SourceRange {
                bytes: [10, 15],
                utf16: [5, 10],
            },
            SourceRange {
                bytes: [14, 20],
                utf16: [0, 6],
            },
        ],
        [
            SourceRange {
                bytes: [0, 5],
                utf16: [0, 5],
            },
            SourceRange {
                bytes: [6, 10],
                utf16: [8, 12],
            },
        ],
    ] {
        metadata.tag_occurrences = ranges
            .into_iter()
            .map(|range| TagOccurrence {
                name: "work".into(),
                range,
            })
            .collect();
        assert!(matches!(
            query.evaluate_checked(
                SearchDocument {
                    path: "Note.md",
                    source: SearchSource::Unavailable,
                    metadata: SearchMetadataInput::Present(&metadata),
                },
                |_| Ok::<_, ()>(())
            ),
            Err(SearchError::InvalidDocument(_))
        ));
    }
    metadata.tag_occurrences = [
        SourceRange {
            bytes: [0, 5],
            utf16: [0, 5],
        },
        SourceRange {
            bytes: [4, 10],
            utf16: [4, 10],
        },
    ]
    .into_iter()
    .map(|range| TagOccurrence {
        name: "work".into(),
        range,
    })
    .collect();
    let SearchEvaluation::Match(result) = query
        .evaluate_checked(
            SearchDocument {
                path: "Note.md",
                source: SearchSource::Unavailable,
                metadata: SearchMetadataInput::Present(&metadata),
            },
            |_| Ok::<_, ()>(()),
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(result.occurrence_count, 1);
    assert!(
        matches!(result.location(0).unwrap().locator, SearchLocator::Source { range, .. } if range.bytes == [0,10] && range.utf16 == [0,10])
    );
}

#[test]
fn empty_rendered_value_comparison_retains_typed_predicate_location_without_occurrence() {
    let source = "---\nempty: ''\n---\n";
    for query in [
        "[empty:<a]",
        "[empty:<a] OR [empty:<a]",
        "[empty:/^/] OR [empty:<a]",
    ] {
        let result = evaluate(query, source);
        assert_eq!(result.occurrence_count, 0, "{query}");
        assert!(result.content.is_empty());
        assert_eq!(result.locations_len(), 1);
        let value = result.properties[0].value.as_ref().unwrap();
        assert_eq!(value.text, "");
        assert_eq!(value.ranges[0].bytes, [0, 0]);
        let location = result.location(0).unwrap();
        assert_eq!(location.index, 0);
        assert_eq!(location.occurrences, 0);
        assert_eq!(location.role, SearchLocationRole::Predicate);
        assert!(
            matches!(location.locator, SearchLocator::PropertyValue { key, array_path, value_text, range }
            if key == "empty" && array_path.is_empty() && value_text.is_empty()
                && range.bytes == [0,0] && range.utf16 == [0,0])
        );
    }
    let metadata = parse_markdown(&MetadataRequest {
        entry_id: EntryId::new("empty-value-entry").unwrap(),
        content_revision: Revision::new("empty-value-revision").unwrap(),
        source: source.into(),
    })
    .unwrap();
    assert_eq!(
        compiled("[empty:/^/]")
            .evaluate_checked(
                SearchDocument {
                    path: "Note.md",
                    source: SearchSource::Unavailable,
                    metadata: SearchMetadataInput::Present(&metadata),
                },
                |_| Ok::<_, ()>(())
            )
            .unwrap(),
        SearchEvaluation::NoMatch
    );
}
