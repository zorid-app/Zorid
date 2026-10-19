//! Count/location proof retained before highlight touch merging. Strings stay in
//! the result's original field/property table; proofs never repeat value bodies.
use super::*;
use std::collections::BTreeMap;
use std::mem::size_of;
use zorid_document::SourceRange;
type Span = (usize, usize);
#[derive(Debug, PartialEq, Eq)]
pub(super) struct PropertyProof {
    pub property: usize,
    pub spans: Vec<Span>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum LocationProof {
    Source {
        range: SourceRange,
        kind: SearchContentKind,
        count: u32,
    },
    Filename {
        range: SourceRange,
        count: u32,
    },
    Path {
        range: SourceRange,
        count: u32,
    },
    Key {
        property: usize,
        key_match: SearchKeyMatch,
        count: u32,
    },
    Value {
        property: usize,
        range: SourceRange,
        count: u32,
    },
}
impl LocationProof {
    fn count(&self) -> u32 {
        match self {
            Self::Source { count, .. }
            | Self::Filename { count, .. }
            | Self::Path { count, .. }
            | Self::Key { count, .. }
            | Self::Value { count, .. } => *count,
        }
    }
    pub(super) fn heap_bytes(&self) -> usize {
        match self {
            Self::Key {
                key_match: SearchKeyMatch::Ranges { ranges },
                ..
            } => ranges.capacity() * size_of::<SourceRange>(),
            _ => 0,
        }
    }
    pub(super) fn location(&self, index: u32, result: &SearchMatches) -> Option<SearchLocation> {
        let (locator, role) = match self {
            Self::Source { range, kind, .. } => (
                SearchLocator::Source {
                    range: range.clone(),
                    kind: kind.clone(),
                },
                if *kind == SearchContentKind::Anchor {
                    SearchLocationRole::Anchor
                } else {
                    SearchLocationRole::Occurrence
                },
            ),
            Self::Filename { range, .. } => (
                SearchLocator::Filename {
                    range: range.clone(),
                },
                SearchLocationRole::Occurrence,
            ),
            Self::Path { range, .. } => (
                SearchLocator::Path {
                    range: range.clone(),
                },
                SearchLocationRole::Occurrence,
            ),
            Self::Key {
                property,
                key_match,
                ..
            } => (
                SearchLocator::PropertyKey {
                    key: result.properties.get(*property)?.key.clone(),
                    key_match: key_match.clone(),
                },
                if matches!(key_match, SearchKeyMatch::Exists) {
                    SearchLocationRole::Existence
                } else {
                    SearchLocationRole::Occurrence
                },
            ),
            Self::Value {
                property,
                range,
                count,
            } => {
                let p = result.properties.get(*property)?;
                let value = p.value.as_ref()?;
                (
                    SearchLocator::PropertyValue {
                        key: p.key.clone(),
                        array_path: p.array_path.clone(),
                        value_text: value.text.clone(),
                        range: range.clone(),
                    },
                    if *count == 0 {
                        SearchLocationRole::Predicate
                    } else {
                        SearchLocationRole::Occurrence
                    },
                )
            }
        };
        Some(SearchLocation {
            index,
            locator,
            role,
            occurrences: self.count(),
        })
    }
}
fn sort_units(n: usize) -> usize {
    n.saturating_mul(if n < 2 {
        0
    } else {
        usize::BITS as usize - (n - 1).leading_zeros() as usize
    })
}
fn counted<E>(
    mut spans: Vec<Span>,
    check: &mut impl FnMut(usize) -> Result<(), SearchError<E>>,
) -> Result<Vec<(Span, u32)>, SearchError<E>> {
    check(sort_units(spans.len()).saturating_add(spans.len()))?;
    spans.sort_unstable();
    let mut strict: Vec<Span> = Vec::new();
    for span in spans {
        if span.0 == span.1 {
            continue;
        }
        if let Some(last) = strict.last_mut() {
            if span.0 < last.1 {
                last.1 = last.1.max(span.1);
                continue;
            }
        }
        strict.push(span);
    }
    check(strict.len())?;
    let mut result: Vec<(Span, u32)> = Vec::new();
    for span in strict {
        if let Some((last, count)) = result.last_mut() {
            if span.0 <= last.1 {
                last.1 = last.1.max(span.1);
                *count += 1;
                continue;
            }
        }
        result.push((span, 1));
    }
    Ok(result)
}
fn ranges<E>(
    text: &str,
    spans: &[(Span, u32)],
    check: &mut impl FnMut(usize) -> Result<(), SearchError<E>>,
) -> Result<Vec<(SourceRange, u32)>, SearchError<E>> {
    if spans.is_empty() {
        return Ok(Vec::new());
    }
    check((1 + text.len() / 64).saturating_add(spans.len().saturating_mul(3)))?;
    let positions: Vec<_> = spans.iter().map(|(s, _)| *s).collect();
    let ranges = super::evaluate::coordinates(text, &positions)?;
    Ok(ranges
        .into_iter()
        .zip(spans.iter().map(|(_, n)| *n))
        .collect())
}
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct GroupKey<'a> {
    key: &'a str,
    array: &'a [u32],
    value: Option<&'a str>,
}
struct Group {
    property: usize,
    spans: Vec<Span>,
}
pub(super) fn build<E>(
    result: &SearchMatches,
    source: Option<&str>,
    source_spans: Vec<Span>,
    filename: Vec<Span>,
    path: Vec<Span>,
    properties: Vec<PropertyProof>,
    check: &mut impl FnMut(usize) -> Result<(), SearchError<E>>,
) -> Result<(Vec<LocationProof>, u32), SearchError<E>> {
    let mut proof = Vec::new();
    let mut source_spans = source_spans;
    check(result.tags.len())?;
    let tag_ranges: Vec<_> = result
        .tags
        .iter()
        .filter_map(|t| t.source_range.as_ref())
        .collect();
    check(tag_ranges.len())?;
    source_spans.extend(
        tag_ranges
            .iter()
            .map(|r| (r.bytes[0] as usize, r.bytes[1] as usize)),
    );
    let merged = counted(source_spans, check)?;
    let source_ranges = if let Some(text) = source {
        ranges(text, &merged, check)?
    } else {
        // A body-free inline-tag result has parser-proved original coordinates.
        // Only endpoint lookup is needed; never invent offsets in a tag value.
        check(sort_units(tag_ranges.len().saturating_mul(2)).saturating_mul(2))?;
        let mut endpoints = BTreeMap::new();
        for range in tag_ranges {
            for (b, u) in range.bytes.into_iter().zip(range.utf16) {
                if endpoints.insert(b, u).is_some_and(|old| old != u) {
                    return Err(SearchError::InvalidDocument("Inconsistent tag coordinates"));
                }
            }
        }
        // Parser facts can be used without the body, but their byte/UTF16
        // endpoints must still describe one monotonic coordinate space. Start
        // at the known source origin so even the first endpoint is constrained.
        check(endpoints.len())?;
        let mut previous = (0u32, 0u32);
        for (&byte, &utf16) in &endpoints {
            if utf16 < previous.1 || utf16 - previous.1 > byte - previous.0 {
                return Err(SearchError::InvalidDocument("Inconsistent tag coordinates"));
            }
            previous = (byte, utf16);
        }
        check(merged.len())?;
        let mut out = Vec::new();
        for ((start, end), count) in merged {
            let start = u32::try_from(start)
                .map_err(|_| SearchError::InvalidDocument("Tag coordinate overflow"))?;
            let end = u32::try_from(end)
                .map_err(|_| SearchError::InvalidDocument("Tag coordinate overflow"))?;
            let a = *endpoints
                .get(&start)
                .ok_or(SearchError::InvalidDocument("Missing tag coordinate"))?;
            let b = *endpoints
                .get(&end)
                .ok_or(SearchError::InvalidDocument("Missing tag coordinate"))?;
            if a > b {
                return Err(SearchError::InvalidDocument("Inverted tag coordinates"));
            }
            out.push((
                SourceRange {
                    bytes: [start, end],
                    utf16: [a, b],
                },
                count,
            ));
        }
        out
    };
    check(source_ranges.len())?;
    for (range, count) in source_ranges {
        proof.push(LocationProof::Source {
            range,
            kind: SearchContentKind::Occurrence,
            count,
        });
    }
    check(result.content.len())?;
    for hit in &result.content {
        if hit.kind == SearchContentKind::Anchor {
            check(1)?;
            proof.push(LocationProof::Source {
                range: hit.range.clone(),
                kind: SearchContentKind::Anchor,
                count: 0,
            });
        }
    }
    for (spans, text, is_name) in [
        (
            filename,
            result.filename.as_ref().map(|f| f.value.as_str()),
            true,
        ),
        (
            path,
            result.filepath.as_ref().map(|f| f.value.as_str()),
            false,
        ),
    ] {
        if let Some(text) = text {
            let merged = counted(spans, check)?;
            let ranges = ranges(text, &merged, check)?;
            check(ranges.len())?;
            for (range, count) in ranges {
                proof.push(if is_name {
                    LocationProof::Filename { range, count }
                } else {
                    LocationProof::Path { range, count }
                });
            }
        }
    }
    // Borrowed group keys reference the one retained property table. B-tree
    // comparison is prepaid conservatively for complete key/value byte visits.
    check(properties.len())?;
    let mut lookup: BTreeMap<GroupKey<'_>, usize> = BTreeMap::new();
    let mut groups: Vec<Group> = Vec::new();
    for item in properties {
        let p = result
            .properties
            .get(item.property)
            .ok_or(SearchError::InvalidDocument("Invalid property proof"))?;
        let value = p.value.as_ref().map(|v| v.text.as_str());
        // A lookup followed by an insertion can each visit multiple keys per
        // B-tree node. Prepay a generous comparison bound for both traversals,
        // including long common prefixes; no uncharged string comparisons.
        let height = 16 * (usize::BITS as usize - (lookup.len() + 1).leading_zeros() as usize + 1);
        let bytes = p
            .key
            .len()
            .saturating_add(value.map_or(0, str::len))
            .saturating_add(p.array_path.len() * 4);
        check(
            height
                .saturating_mul(1 + bytes / 64)
                .saturating_add(item.spans.len()),
        )?;
        let key = GroupKey {
            key: &p.key,
            array: &p.array_path,
            value,
        };
        let group = if let Some(&i) = lookup.get(&key) {
            i
        } else {
            let i = groups.len();
            lookup.insert(key, i);
            groups.push(Group {
                property: item.property,
                spans: Vec::new(),
            });
            i
        };
        groups[group].spans.extend(item.spans);
    }
    for group in groups {
        let p = &result.properties[group.property];
        // A successful typed comparison can locate the empty rendered value.
        // Keep that field provenance without inventing an occurrence or anchor.
        let empty_value_predicate = if p.value.as_ref().is_some_and(|value| value.text.is_empty()) {
            check(group.spans.len())?;
            group.spans.iter().any(|&span| span == (0, 0))
        } else {
            false
        };
        let merged = counted(group.spans, check)?;
        if let Some(value) = &p.value {
            if merged.is_empty() && empty_value_predicate {
                check(1)?;
                proof.push(LocationProof::Value {
                    property: group.property,
                    range: SourceRange {
                        bytes: [0, 0],
                        utf16: [0, 0],
                    },
                    count: 0,
                });
            }
            let ranges = ranges(&value.text, &merged, check)?;
            check(ranges.len())?;
            for (range, count) in ranges {
                proof.push(LocationProof::Value {
                    property: group.property,
                    range,
                    count,
                });
            }
        } else if merged.is_empty() {
            check(1)?;
            proof.push(LocationProof::Key {
                property: group.property,
                key_match: SearchKeyMatch::Exists,
                count: 1,
            });
        } else {
            let ranges = ranges(&p.key, &merged, check)?;
            check(ranges.len())?;
            let count = ranges.iter().map(|(_, n)| *n).sum();
            proof.push(LocationProof::Key {
                property: group.property,
                key_match: SearchKeyMatch::Ranges {
                    ranges: ranges.into_iter().map(|(r, _)| r).collect(),
                },
                count,
            });
        }
    }
    check(proof.len())?;
    let count = proof
        .iter()
        .try_fold(0u32, |sum, p| sum.checked_add(p.count()))
        .ok_or(SearchError::Resource("Search occurrence count overflow"))?;
    Ok((proof, count))
}
