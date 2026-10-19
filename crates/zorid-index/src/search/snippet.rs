//! Exact, bounded excerpts over caller-admitted retained fields. This module
//! never fetches source. The caller owns chunk/proof correspondence and accounts
//! for the returned DTO's serialized and retained allocations.
use super::proof::LocationProof;
use super::{
    SearchContentKind, SearchContext, SearchDocument, SearchError, SearchKeyMatch, SearchLocation,
    SearchLocator, SearchMatches, SearchMetadataInput, SearchSnippet, SearchSnippetHighlight,
    SearchSnippetOrigin, SearchSource,
};
use zorid_document::{DocumentMetadata, SourceRange};

const MAX_LOCATIONS: usize = 64;
const MAX_ASSOCIATED_LOCATIONS: usize = 1024;
const MAX_WINDOWS: usize = 1024;
const MAX_FIELD_BYTES: usize = 16 * 1024 * 1024;
const MAX_OWNED_BYTES: usize = 8 * 1024 * 1024;
const MAX_CONTEXT_RANGES: usize = 100_000;
const CONTEXT: usize = 100;
const MAX_SCALARS: usize = 512;
const STRIDE: usize = 512;
// A <=16MiB field has <=32770 sparse points: at most17 partition
// comparisons plus9 scan blocks per lookup, rounded up before any work.
const POINT_LOOKUP_WORK: usize = 32;
const RANGE_LOOKUP_WORK: usize = POINT_LOOKUP_WORK * 2;

// Conservatively account allocations across this invocation, including scratch
// that has already been dropped. Admission precedes allocation; actual capacity
// is checked immediately afterward. Initial caller-owned locators are excluded.
struct OwnedBudget {
    used: usize,
    limit: usize,
}
impl OwnedBudget {
    fn admit<E>(&mut self, bytes: usize) -> Result<(), SearchError<E>> {
        self.used = self
            .used
            .checked_add(bytes)
            .ok_or(SearchError::Resource("Snippet allocation size overflow"))?;
        if self.used > self.limit {
            return Err(SearchError::Resource("Snippet owned byte limit"));
        }
        Ok(())
    }
    fn vector<E, T>(&mut self, capacity: usize) -> Result<Vec<T>, SearchError<E>> {
        let bytes = capacity
            .checked_mul(std::mem::size_of::<T>())
            .ok_or(SearchError::Resource("Snippet vector size overflow"))?;
        self.admit(bytes)?;
        let result = Vec::with_capacity(capacity);
        if result.capacity() > capacity {
            self.admit((result.capacity() - capacity) * std::mem::size_of::<T>())?;
        }
        Ok(result)
    }
    fn push<E, T>(
        &mut self,
        vector: &mut Vec<T>,
        value: T,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<(), SearchError<E>> {
        if vector.len() == vector.capacity() {
            let target = vector.capacity().saturating_mul(2).max(4);
            // Account the entire replacement allocation before any realloc can
            // temporarily coexist with its predecessor.
            self.admit(
                target
                    .checked_mul(std::mem::size_of::<T>())
                    .ok_or(SearchError::Resource("Snippet vector growth overflow"))?,
            )?;
            charge(check, vector.len() + 1)?;
            vector.reserve_exact(target - vector.len());
            if vector.capacity() > target {
                self.admit((vector.capacity() - target) * std::mem::size_of::<T>())?;
            }
        }
        vector.push(value);
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct Point {
    byte: usize,
    utf16: u32,
    scalar: usize,
}
struct Coordinates<'a> {
    text: &'a str,
    points: Vec<Point>,
}
impl<'a> Coordinates<'a> {
    fn new<E>(
        text: &'a str,
        check: &mut impl FnMut(usize) -> Result<(), E>,
        owned: &mut OwnedBudget,
    ) -> Result<Self, SearchError<E>> {
        // Charge before scanning or allocating the sparse map. Its retained
        // allocation is <= (bytes / 512 + 2) * size_of::<Point>().
        charge(check, text.len().div_ceil(64) + 1)?;
        let mut points = owned.vector(text.len() / STRIDE + 2)?;
        let mut p = Point {
            byte: 0,
            utf16: 0,
            scalar: 0,
        };
        points.push(p);
        let mut next = STRIDE;
        let mut cancellation_at = 64 * 1024;
        for (byte, ch) in text.char_indices() {
            if byte >= cancellation_at {
                charge(check, 0)?;
                cancellation_at = byte + 64 * 1024;
            }
            if byte >= next {
                points.push(Point { byte, ..p });
                next = byte + STRIDE;
            }
            p.byte = byte + ch.len_utf8();
            p.utf16 += ch.len_utf16() as u32;
            p.scalar += 1;
        }
        if points.last().unwrap().byte != text.len() {
            points.push(p);
        }
        Ok(Self { text, points })
    }
    fn point(&self, byte: usize) -> Option<Point> {
        if byte > self.text.len() || !self.text.is_char_boundary(byte) {
            return None;
        }
        let index = self
            .points
            .partition_point(|p| p.byte <= byte)
            .saturating_sub(1);
        let mut p = self.points[index];
        for ch in self.text[p.byte..byte].chars() {
            p.utf16 += ch.len_utf16() as u32;
            p.scalar += 1;
        }
        p.byte = byte;
        Some(p)
    }
    fn range<E>(&self, range: &SourceRange) -> Result<(Point, Point), SearchError<E>> {
        let a = self.point(range.bytes[0] as usize);
        let b = self.point(range.bytes[1] as usize);
        match (a, b) {
            (Some(a), Some(b)) if a.byte <= b.byte && [a.utf16, b.utf16] == range.utf16 => {
                Ok((a, b))
            }
            _ => Err(SearchError::InvalidDocument(
                "Snippet range does not name exact field coordinates",
            )),
        }
    }
    fn origin_range(&self, start: usize, end: usize) -> SourceRange {
        SourceRange {
            bytes: [start as u32, end as u32],
            utf16: [
                self.point(start).unwrap().utf16,
                self.point(end).unwrap().utf16,
            ],
        }
    }
}

struct Group<'a> {
    origin: SearchSnippetOrigin,
    property: Option<usize>,
    text: &'a str,
    key: Option<&'a str>,
    array_path: Option<&'a [u32]>,
    locations: Vec<&'a SearchLocation>,
}

/// The initial vector is reused; extra locators accompany intersecting excerpts
/// and do not advance the caller's contiguous-location continuation.
#[derive(Debug)]
pub struct SnippetChunk {
    pub locations: Vec<SearchLocation>,
    pub snippets: Vec<SearchSnippet>,
}
impl SnippetChunk {
    /// Owned allocations including spare vector/string capacities.
    pub fn retained_bytes(&self) -> usize {
        use std::mem::size_of;
        size_of::<Self>()
            + self.locations.capacity() * size_of::<SearchLocation>()
            + self
                .locations
                .iter()
                .map(location_heap_bytes)
                .sum::<usize>()
            + self.snippets.capacity() * size_of::<SearchSnippet>()
            + self
                .snippets
                .iter()
                .map(|s| {
                    s.text.capacity()
                        + s.key.as_ref().map_or(0, String::capacity)
                        + s.array_path
                            .as_ref()
                            .map_or(0, |p| p.capacity() * size_of::<u32>())
                        + s.highlights.capacity() * size_of::<SearchSnippetHighlight>()
                        + s.highlights
                            .iter()
                            .map(|h| h.location_indices.capacity() * size_of::<u32>())
                            .sum::<usize>()
                })
                .sum::<usize>()
    }
}
fn location_heap_bytes(l: &SearchLocation) -> usize {
    use std::mem::size_of;
    match &l.locator {
        SearchLocator::PropertyKey { key, key_match } => {
            key.capacity()
                + match key_match {
                    SearchKeyMatch::Ranges { ranges } => {
                        ranges.capacity() * size_of::<SourceRange>()
                    }
                    SearchKeyMatch::Exists => 0,
                }
        }
        SearchLocator::PropertyValue {
            key,
            array_path,
            value_text,
            ..
        } => key.capacity() + array_path.capacity() * size_of::<u32>() + value_text.capacity(),
        _ => 0,
    }
}
#[derive(Clone, Copy)]
struct Window {
    start: usize,
    end: usize,
    primary: u32,
}

/// `locations` must be the caller's bounded chunk projection of `matches`.
/// Stable ordinals are checked here; the caller constructs payloads with
/// `SearchMatches::location` rather than accepting externally authored locators.
/// Unavailable source produces no source excerpt, without changing match counts.
/// `owned_byte_limit` admits new allocations, including coordinate/normalization
/// scratch, before allocation (hard maximum8MiB). The consumed initial locator
/// vector is already caller-accounted. Scratch admission is conservative across
/// this invocation, even after an earlier field has been dropped.
pub fn snippets_checked<E>(
    matches: &SearchMatches,
    mut locations: Vec<SearchLocation>,
    document: SearchDocument<'_>,
    context: SearchContext,
    owned_byte_limit: usize,
    mut check: impl FnMut(usize) -> Result<(), E>,
) -> Result<SnippetChunk, SearchError<E>> {
    charge(
        &mut check,
        locations
            .len()
            .saturating_mul(locations.len())
            .saturating_add(1),
    )?;
    if locations.len() > MAX_LOCATIONS {
        return Err(SearchError::Resource("Snippet chunk location limit"));
    }
    let mut owned = OwnedBudget {
        used: 0,
        limit: owned_byte_limit.min(MAX_OWNED_BYTES),
    };
    let mut groups: Vec<Group<'_>> = Vec::new();
    for (position, location) in locations.iter().enumerate() {
        if location.index as usize >= matches.locations_len()
            || locations[..position]
                .iter()
                .any(|p| p.index == location.index)
        {
            return Err(SearchError::InvalidDocument(
                "Invalid snippet location ordinal",
            ));
        }
        let (origin, text, key, array_path) = match &location.locator {
            SearchLocator::Source { .. } => match document.source {
                SearchSource::Text(text) => (SearchSnippetOrigin::Source, text, None, None),
                _ => continue,
            },
            SearchLocator::Filename { .. } => (
                SearchSnippetOrigin::Filename,
                matches
                    .filename
                    .as_ref()
                    .ok_or(SearchError::InvalidDocument("Missing filename match field"))?
                    .value
                    .as_str(),
                None,
                None,
            ),
            SearchLocator::Path { .. } => (
                SearchSnippetOrigin::Path,
                matches
                    .filepath
                    .as_ref()
                    .ok_or(SearchError::InvalidDocument("Missing path match field"))?
                    .value
                    .as_str(),
                None,
                None,
            ),
            SearchLocator::PropertyKey { key, .. } => (
                SearchSnippetOrigin::PropertyKey,
                key.as_str(),
                Some(key.as_str()),
                None,
            ),
            SearchLocator::PropertyValue {
                key,
                array_path,
                value_text,
                ..
            } => (
                SearchSnippetOrigin::PropertyValue,
                value_text.as_str(),
                Some(key.as_str()),
                Some(array_path.as_slice()),
            ),
        };
        // The sealed proof builder canonicalizes exact key/array/text origins.
        // Its property-table identity avoids comparing a giant value per hit.
        let property = match &matches.locations[location.index as usize] {
            LocationProof::Key { property, .. } | LocationProof::Value { property, .. } => {
                Some(*property)
            }
            _ => None,
        };
        charge(&mut check, groups.len() + 1)?;
        let found = groups
            .iter()
            .position(|g| g.origin == origin && g.property == property);
        if let Some(i) = found {
            groups[i].locations.push(location);
        } else {
            // Source and each exact field have independent bounds. Aggregate
            // scans/copies remain admitted by caller work and owned budgets.
            if text.len() > MAX_FIELD_BYTES {
                return Err(SearchError::Resource("Snippet field byte limit"));
            }
            let mut references = owned.vector(locations.len())?;
            references.push(location);
            let group = Group {
                origin,
                property,
                text,
                key,
                array_path,
                locations: references,
            };
            owned.push(&mut groups, group, &mut check)?;
        }
    }
    let mut result = Vec::new();
    if groups.is_empty() {
        sort_locations(&mut locations, &mut check)?;
        return Ok(SnippetChunk {
            locations,
            snippets: result,
        });
    }
    charge(&mut check, matches.locations.len() + 1)?;
    let mut needed: Vec<bool> = owned.vector(matches.locations.len())?;
    needed.resize(matches.locations.len(), false);
    let mut needed_count = 0usize;
    for group in groups {
        let coordinates = Coordinates::new(group.text, &mut check, &mut owned)?;
        let window_count = group
            .locations
            .iter()
            .try_fold(0usize, |n, l| n.checked_add(ranges(l).len().max(1)))
            .ok_or(SearchError::Resource("Snippet window size overflow"))?;
        if window_count > MAX_WINDOWS {
            return Err(SearchError::Resource("Snippet window limit"));
        }
        let mut windows = owned.vector(window_count)?;
        for location in &group.locations {
            charge(&mut check, POINT_LOOKUP_WORK)?;
            let ranges = ranges(location);
            if ranges.len() > MAX_LOCATIONS * MAX_SCALARS {
                return Err(SearchError::Resource("Snippet key range limit"));
            }
            if windows.len() >= MAX_WINDOWS {
                return Err(SearchError::Resource("Snippet window limit"));
            }
            if ranges.is_empty() {
                charge(&mut check, MAX_SCALARS * 2)?;
                // Presence proof: literal key, no invented highlighted range.
                windows.push(window(
                    &coordinates,
                    0,
                    group.text.len(),
                    (0, group.text.len()),
                    false,
                    location.index,
                ));
            }
            for range in ranges {
                charge(&mut check, RANGE_LOOKUP_WORK)?;
                let (a, b) = coordinates.range(range)?;
                let bounds = if group.origin == SearchSnippetOrigin::Source
                    && context == SearchContext::Section
                {
                    section_bounds(document.metadata, a.byte, b.byte, &coordinates, &mut check)?
                } else {
                    (0, group.text.len())
                };
                charge(&mut check, MAX_SCALARS * 2)?;
                if windows.len() >= MAX_WINDOWS {
                    return Err(SearchError::Resource("Snippet window limit"));
                }
                windows.push(window(
                    &coordinates,
                    a.byte,
                    b.byte,
                    bounds,
                    context == SearchContext::Line,
                    location.index,
                ));
            }
        }
        // At most one bounded range set per chunk locator; charge comparisons
        // before sorting. No document-sized character table or source copies.
        charge(
            &mut check,
            windows
                .len()
                .saturating_mul(windows.len().max(1).ilog2() as usize + 1),
        )?;
        windows.sort_unstable_by_key(|w| (w.start, w.end, w.primary));
        let mut merged: Vec<Window> = owned.vector(window_count)?;
        for w in windows {
            if let Some(last) = merged.last_mut() {
                if w.start <= last.end {
                    let end = last.end.max(w.end);
                    charge(&mut check, RANGE_LOOKUP_WORK)?;
                    let scalars = coordinates.point(end).unwrap().scalar
                        - coordinates.point(last.start).unwrap().scalar;
                    if scalars <= MAX_SCALARS {
                        last.end = end;
                        continue;
                    }
                }
            }
            merged.push(w);
        }
        // Borrow proofs, never materialize property value strings while scanning.
        charge(&mut check, matches.locations.len().saturating_mul(2))?;
        let associated_capacity = matches
            .locations
            .iter()
            .filter(|p| same_origin(p, &group))
            .count()
            .min(MAX_ASSOCIATED_LOCATIONS);
        let mut associated = owned.vector(associated_capacity)?;
        for (index, proof) in matches.locations.iter().enumerate() {
            if !same_origin(proof, &group) {
                continue;
            }
            let (ranges, anchor) = proof_ranges(proof);
            charge(
                &mut check,
                ranges.len().saturating_mul(merged.len()).saturating_add(1),
            )?;
            if ranges
                .iter()
                .any(|r| merged.iter().any(|w| intersects(r, w)))
            {
                // Validate every associated proof before it supplies highlights.
                charge(&mut check, ranges.len().saturating_mul(RANGE_LOOKUP_WORK))?;
                for range in ranges {
                    coordinates.range::<E>(range)?;
                }
                if !needed[index] {
                    needed[index] = true;
                    needed_count += 1;
                }
                if needed_count > MAX_ASSOCIATED_LOCATIONS {
                    return Err(SearchError::Resource("Snippet associated location limit"));
                }
                associated.push(Association {
                    index: index as u32,
                    ranges,
                    anchor,
                });
            }
        }
        for w in merged {
            let range_count = associated.iter().map(|a| a.ranges.len()).sum::<usize>();
            // Endpoint partitioning below is quadratic in admitted intersecting
            // spans; precharge it before endpoint allocation/sorting/work.
            charge(&mut check, range_count)?;
            let active_spans = associated
                .iter()
                .filter(|a| !a.anchor)
                .map(|a| a.ranges.iter().filter(|r| intersects(r, &w)).count())
                .sum::<usize>();
            charge(
                &mut check,
                range_count
                    .saturating_mul(RANGE_LOOKUP_WORK)
                    .saturating_add(
                        active_spans
                            .saturating_mul(active_spans)
                            .saturating_mul(4 + 2 * (active_spans.max(1).ilog2() as usize + 1)),
                    )
                    .saturating_add(MAX_SCALARS),
            )?;
            let copy = w.end - w.start
                + group.key.map_or(0, str::len)
                + group
                    .array_path
                    .map_or(0, |p| p.len() * std::mem::size_of::<u32>());
            admit_copy(&mut owned, copy, &mut check)?;
            // Original excerpt range has two lookups; highlight base has one.
            charge(&mut check, POINT_LOOKUP_WORK * 3)?;
            let origin_range = coordinates.origin_range(w.start, w.end);
            let highlights = highlights(
                &associated,
                &coordinates,
                w.start,
                w.end,
                active_spans,
                &mut owned,
                &mut check,
            )?;
            let snippet = SearchSnippet {
                origin: group.origin,
                key: group.key.map(str::to_owned),
                array_path: group.array_path.map(<[u32]>::to_vec),
                text: group.text[w.start..w.end].to_owned(),
                origin_range,
                primary_location_index: w.primary,
                highlights,
                clipped_before: w.start > 0,
                clipped_after: w.end < group.text.len(),
            };
            let actual_copy = snippet.text.capacity()
                + snippet.key.as_ref().map_or(0, String::capacity)
                + snippet
                    .array_path
                    .as_ref()
                    .map_or(0, |p| p.capacity() * std::mem::size_of::<u32>());
            owned.admit(actual_copy.saturating_sub(copy))?;
            owned.push(&mut result, snippet, &mut check)?;
        }
    }
    // All borrows into the initial vector have ended before augmentation.
    charge(&mut check, needed.len())?;
    for (index, included) in needed.into_iter().enumerate() {
        if !included {
            continue;
        }
        charge(&mut check, locations.len())?;
        if locations.iter().any(|l| l.index as usize == index) {
            continue;
        }
        if locations.len() >= MAX_ASSOCIATED_LOCATIONS {
            return Err(SearchError::Resource("Snippet associated location limit"));
        }
        admit_copy(
            &mut owned,
            materialized_bytes(&matches.locations[index], matches),
            &mut check,
        )?;
        let expected_copy = materialized_bytes(&matches.locations[index], matches);
        let location = matches.location(index).ok_or(SearchError::InvalidDocument(
            "Missing associated snippet proof",
        ))?;
        owned.admit(location_heap_bytes(&location).saturating_sub(expected_copy))?;
        owned.push(&mut locations, location, &mut check)?;
    }
    sort_locations(&mut locations, &mut check)?;
    Ok(SnippetChunk {
        locations,
        snippets: result,
    })
}

fn sort_locations<E>(
    locations: &mut [SearchLocation],
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(), SearchError<E>> {
    let depth = if locations.len() <= 1 {
        0
    } else {
        usize::BITS as usize - (locations.len() - 1).leading_zeros() as usize
    };
    charge(check, locations.len().saturating_mul(depth))?;
    // Indices are stable file ordinals; augmentation can append an earlier
    // proof, so wire order must be restored independently of array positions.
    locations.sort_unstable_by_key(|location| location.index);
    Ok(())
}

fn admit_copy<E>(
    owned: &mut OwnedBudget,
    bytes: usize,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(), SearchError<E>> {
    owned.admit(bytes)?;
    charge(check, bytes.div_ceil(64) + 1)
}
fn charge<E>(
    check: &mut impl FnMut(usize) -> Result<(), E>,
    units: usize,
) -> Result<(), SearchError<E>> {
    check(units).map_err(SearchError::Host)
}
fn ranges(location: &SearchLocation) -> &[SourceRange] {
    match &location.locator {
        SearchLocator::Source { range, .. }
        | SearchLocator::Filename { range }
        | SearchLocator::Path { range }
        | SearchLocator::PropertyValue { range, .. } => std::slice::from_ref(range),
        SearchLocator::PropertyKey {
            key_match: SearchKeyMatch::Ranges { ranges },
            ..
        } => ranges,
        SearchLocator::PropertyKey {
            key_match: SearchKeyMatch::Exists,
            ..
        } => &[],
    }
}
fn window(
    c: &Coordinates<'_>,
    start: usize,
    end: usize,
    bounds: (usize, usize),
    line: bool,
    primary: u32,
) -> Window {
    let text = c.text;
    let mut a = start;
    for ch in text[bounds.0..start].chars().rev().take(CONTEXT) {
        if line && matches!(ch, '\r' | '\n') {
            break;
        }
        a -= ch.len_utf8();
    }
    let mut b = end;
    for ch in text[end..bounds.1].chars().take(CONTEXT) {
        if line && matches!(ch, '\r' | '\n') {
            break;
        }
        b += ch.len_utf8();
    }
    // Section context fills a bounded window within the exact parser container.
    // Short containers are retained whole; long ones remain occurrence-local.
    if !line && c.point(bounds.1).unwrap().scalar - c.point(bounds.0).unwrap().scalar <= MAX_SCALARS
    {
        a = bounds.0;
        b = bounds.1;
    }
    if c.point(b).unwrap().scalar - c.point(a).unwrap().scalar > MAX_SCALARS {
        b = a + text[a..b]
            .chars()
            .take(MAX_SCALARS)
            .map(char::len_utf8)
            .sum::<usize>();
    }
    Window {
        start: a,
        end: b,
        primary,
    }
}
fn section_bounds<E>(
    metadata: SearchMetadataInput<'_>,
    start: usize,
    end: usize,
    coordinates: &Coordinates<'_>,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<(usize, usize), SearchError<E>> {
    let SearchMetadataInput::Present(metadata) = metadata else {
        return Ok((0, coordinates.text.len()));
    };
    let DocumentMetadata {
        blocks, list_items, ..
    } = metadata;
    let count = blocks
        .len()
        .checked_add(list_items.len())
        .ok_or(SearchError::Resource("Snippet context size overflow"))?;
    if count > MAX_CONTEXT_RANGES {
        return Err(SearchError::Resource("Snippet context range limit"));
    }
    charge(check, count.saturating_add(RANGE_LOOKUP_WORK))?;
    // A full list item takes priority over any overlapping non-list block.
    let containing = |r: &&SourceRange| r.bytes[0] as usize <= start && end <= r.bytes[1] as usize;
    let size = |r: &&SourceRange| r.bytes[1].saturating_sub(r.bytes[0]);
    let chosen = list_items
        .iter()
        .map(|i| &i.range)
        .filter(containing)
        .min_by_key(size)
        .or_else(|| {
            blocks
                .iter()
                .map(|b| &b.range)
                .filter(containing)
                .min_by_key(size)
        });
    if let Some(range) = chosen {
        let (a, b) = coordinates.range::<E>(range)?;
        return Ok((a.byte, b.byte));
    }
    Ok((0, coordinates.text.len()))
}
struct Association<'a> {
    index: u32,
    ranges: &'a [SourceRange],
    anchor: bool,
}
fn intersects(range: &SourceRange, w: &Window) -> bool {
    let (a, b) = (range.bytes[0] as usize, range.bytes[1] as usize);
    (a < w.end && w.start < b) || (a == b && w.start <= a && a <= w.end)
}
fn proof_ranges(proof: &LocationProof) -> (&[SourceRange], bool) {
    match proof {
        LocationProof::Source { range, kind, .. } => (
            std::slice::from_ref(range),
            *kind == SearchContentKind::Anchor,
        ),
        LocationProof::Filename { range, .. }
        | LocationProof::Path { range, .. }
        | LocationProof::Value { range, .. } => (std::slice::from_ref(range), false),
        LocationProof::Key {
            key_match: SearchKeyMatch::Ranges { ranges },
            ..
        } => (ranges, false),
        LocationProof::Key {
            key_match: SearchKeyMatch::Exists,
            ..
        } => (&[], false),
    }
}
fn same_origin(proof: &LocationProof, group: &Group<'_>) -> bool {
    match proof {
        LocationProof::Source { .. } => group.origin == SearchSnippetOrigin::Source,
        LocationProof::Filename { .. } => group.origin == SearchSnippetOrigin::Filename,
        LocationProof::Path { .. } => group.origin == SearchSnippetOrigin::Path,
        LocationProof::Key { property, .. } => {
            group.origin == SearchSnippetOrigin::PropertyKey && group.property == Some(*property)
        }
        LocationProof::Value { property, .. } => {
            group.origin == SearchSnippetOrigin::PropertyValue && group.property == Some(*property)
        }
    }
}
fn materialized_bytes(proof: &LocationProof, matches: &SearchMatches) -> usize {
    match proof {
        LocationProof::Key {
            property,
            key_match,
            ..
        } => {
            matches.properties[*property].key.len()
                + match key_match {
                    SearchKeyMatch::Ranges { ranges } => {
                        ranges.len() * std::mem::size_of::<SourceRange>()
                    }
                    SearchKeyMatch::Exists => 0,
                }
        }
        LocationProof::Value { property, .. } => {
            let p = &matches.properties[*property];
            p.key.len()
                + p.array_path.len() * std::mem::size_of::<u32>()
                + p.value.as_ref().map_or(0, |v| v.text.len())
        }
        _ => 0,
    }
}
fn highlights<E>(
    locations: &[Association<'_>],
    coordinates: &Coordinates<'_>,
    start: usize,
    end: usize,
    active_spans: usize,
    owned: &mut OwnedBudget,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<Vec<SearchSnippetHighlight>, SearchError<E>> {
    let base = coordinates.point(start).unwrap().utf16;
    let mut spans = owned.vector(active_spans)?;
    for location in locations {
        if location.anchor {
            continue;
        }
        for range in location.ranges {
            let a = (range.bytes[0] as usize).max(start);
            let b = (range.bytes[1] as usize).min(end);
            if a < b {
                spans.push((
                    coordinates.point(a).unwrap().utf16 - base,
                    coordinates.point(b).unwrap().utf16 - base,
                    location.index,
                ));
            }
        }
    }
    let mut endpoints: Vec<u32> = owned.vector(spans.len() * 2)?;
    endpoints.extend(spans.iter().flat_map(|(a, b, _)| [*a, *b]));
    endpoints.sort_unstable();
    endpoints.dedup();
    let mut result: Vec<SearchSnippetHighlight> = owned.vector(endpoints.len())?;
    for pair in endpoints.windows(2) {
        charge(check, spans.len() + 1)?;
        let mut indices: Vec<u32> = owned.vector(spans.len())?;
        indices.extend(
            spans
                .iter()
                .filter(|(a, b, _)| *a <= pair[0] && pair[1] <= *b)
                .map(|(_, _, i)| *i),
        );
        if indices.is_empty() {
            continue;
        }
        indices.sort_unstable();
        indices.dedup();
        if let Some(last) = result.last_mut() {
            if last.utf16[1] == pair[0] && last.location_indices == indices {
                last.utf16[1] = pair[1];
                continue;
            }
        }
        result.push(SearchSnippetHighlight {
            utf16: [pair[0], pair[1]],
            location_indices: indices,
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search::{SearchFieldMatches, SearchPropertyMatch, SearchPropertyValueMatch};
    use zorid_core::{EntryId, Revision};
    use zorid_document::{parse_markdown, BlockKind, ListItem, MarkdownBlock, MetadataRequest};

    fn range(text: &str, start: usize, end: usize) -> SourceRange {
        SourceRange {
            bytes: [start as u32, end as u32],
            utf16: [
                text[..start].encode_utf16().count() as u32,
                text[..end].encode_utf16().count() as u32,
            ],
        }
    }
    fn occurrence(text: &str, start: usize, end: usize) -> LocationProof {
        LocationProof::Source {
            range: range(text, start, end),
            kind: SearchContentKind::Occurrence,
            count: 1,
        }
    }
    fn matched(proofs: Vec<LocationProof>) -> SearchMatches {
        SearchMatches {
            locations: proofs,
            ..SearchMatches::default()
        }
    }
    fn project(
        matches: &SearchMatches,
        initial: &[usize],
        source: SearchSource<'_>,
        context: SearchContext,
    ) -> SnippetChunk {
        snippets_checked(
            matches,
            initial
                .iter()
                .map(|i| matches.location(*i).unwrap())
                .collect(),
            SearchDocument {
                path: "notes/Example.md",
                source,
                metadata: SearchMetadataInput::NotApplicable,
            },
            context,
            MAX_OWNED_BYTES,
            |_| Ok::<_, ()>(()),
        )
        .unwrap()
    }
    fn assert_retained(text: &str, snippet: &SearchSnippet) {
        let r = &snippet.origin_range;
        assert_eq!(snippet.text, text[r.bytes[0] as usize..r.bytes[1] as usize]);
        assert_eq!(*r, range(text, r.bytes[0] as usize, r.bytes[1] as usize));
        assert!(snippet.text.chars().count() <= MAX_SCALARS);
        assert!(snippet
            .highlights
            .windows(2)
            .all(|p| p[0].utf16[1] <= p[1].utf16[0]));
    }
    #[test]
    fn original_bom_crlf_astral_coordinates_and_chunk_intersections() {
        let text = "\u{feff}前😀alpha\r\nβ😀hit hit\r\nsuffix";
        let first = text.find("hit").unwrap();
        let second = first + 4;
        let matches = matched(vec![
            occurrence(text, first, first + 3),
            occurrence(text, second, second + 3),
        ]);
        let output = project(
            &matches,
            &[0],
            SearchSource::Text(text),
            SearchContext::Line,
        );
        assert_eq!(output.locations.len(), 2);
        assert_eq!(output.snippets.len(), 1);
        let s = &output.snippets[0];
        assert_eq!(s.text, "β😀hit hit");
        assert_eq!(s.primary_location_index, 0);
        assert_eq!(s.highlights[0].utf16, [3, 6]);
        assert_eq!(s.highlights[0].location_indices, [0]);
        assert_eq!(s.highlights[1].utf16, [7, 10]);
        assert_eq!(s.highlights[1].location_indices, [1]);
        assert_retained(text, s);
        let bom_match = matched(vec![occurrence(
            text,
            text.find("alpha").unwrap(),
            text.find("alpha").unwrap() + 5,
        )]);
        let bom = project(
            &bom_match,
            &[0],
            SearchSource::Text(text),
            SearchContext::Line,
        );
        assert!(bom.snippets[0].text.starts_with('\u{feff}'));
        assert_retained(text, &bom.snippets[0]);
    }
    #[test]
    fn overlapping_associations_split_and_anchor_never_highlights() {
        let text = "abcdef";
        let matches = matched(vec![
            occurrence(text, 1, 4),
            occurrence(text, 3, 5),
            LocationProof::Source {
                range: range(text, 2, 2),
                kind: SearchContentKind::Anchor,
                count: 0,
            },
        ]);
        let output = project(
            &matches,
            &[0],
            SearchSource::Text(text),
            SearchContext::Line,
        );
        assert_eq!(output.locations.len(), 3);
        let h = &output.snippets[0].highlights;
        assert_eq!(
            h.iter()
                .map(|h| (h.utf16, h.location_indices.clone()))
                .collect::<Vec<_>>(),
            vec![([1, 3], vec![0]), ([3, 4], vec![0, 1]), ([4, 5], vec![1])]
        );
        let anchor = project(
            &matches,
            &[2],
            SearchSource::Text(text),
            SearchContext::Line,
        );
        assert_eq!(anchor.snippets[0].primary_location_index, 2);
        assert!(anchor.snippets[0]
            .highlights
            .iter()
            .all(|h| !h.location_indices.contains(&2)));
    }
    #[test]
    fn anchor_only_and_unavailable_source() {
        let text = "😀anchor";
        let matches = matched(vec![LocationProof::Source {
            range: range(text, 4, 4),
            kind: SearchContentKind::Anchor,
            count: 0,
        }]);
        let output = project(
            &matches,
            &[0],
            SearchSource::Text(text),
            SearchContext::Line,
        );
        assert!(output.snippets[0].highlights.is_empty());
        assert_eq!(output.snippets[0].primary_location_index, 0);
        let unavailable = project(
            &matches,
            &[0],
            SearchSource::Unavailable,
            SearchContext::Section,
        );
        assert_eq!(unavailable.locations.len(), 1);
        assert!(unavailable.snippets.is_empty());
        assert!(
            project(&matches, &[0], SearchSource::NotText, SearchContext::Line)
                .snippets
                .is_empty()
        );
    }
    #[test]
    fn literal_key_presence_and_partial_key_range() {
        let key = "Status Detail";
        for key_match in [
            SearchKeyMatch::Exists,
            SearchKeyMatch::Ranges {
                ranges: vec![range(key, 0, 6)],
            },
        ] {
            let exists = matches!(key_match, SearchKeyMatch::Exists);
            let mut matches = matched(vec![LocationProof::Key {
                property: 0,
                key_match: key_match.clone(),
                count: 1,
            }]);
            matches.properties.push(SearchPropertyMatch {
                key: key.into(),
                key_match: Some(key_match),
                array_path: vec![],
                value: None,
            });
            let output = project(
                &matches,
                &[0],
                SearchSource::Unavailable,
                SearchContext::Line,
            );
            let s = &output.snippets[0];
            assert_eq!(s.text, key);
            assert_eq!(s.primary_location_index, 0);
            if exists {
                assert!(s.highlights.is_empty());
            } else {
                assert_eq!(s.highlights[0].utf16, [0, 6]);
            }
            assert_retained(key, s);
        }
    }
    #[test]
    fn identical_property_text_in_distinct_array_origins_stays_distinct() {
        let text = "😀todo";
        let r = range(text, 4, text.len());
        let mut matches = matched(vec![
            LocationProof::Value {
                property: 0,
                range: r.clone(),
                count: 1,
            },
            LocationProof::Value {
                property: 1,
                range: r.clone(),
                count: 1,
            },
        ]);
        matches.properties = (0..2)
            .map(|i| SearchPropertyMatch {
                key: "status".into(),
                key_match: None,
                array_path: vec![i],
                value: Some(SearchPropertyValueMatch {
                    text: text.into(),
                    ranges: vec![r.clone()],
                }),
            })
            .collect();
        let first = project(&matches, &[0], SearchSource::NotText, SearchContext::Line);
        assert_eq!(first.locations.len(), 1);
        assert_eq!(first.snippets[0].array_path, Some(vec![0]));
        let both = project(
            &matches,
            &[0, 1],
            SearchSource::NotText,
            SearchContext::Line,
        );
        assert_eq!(both.snippets.len(), 2);
        for (index, s) in both.snippets.iter().enumerate() {
            assert_eq!(s.array_path, Some(vec![index as u32]));
            assert_eq!(s.highlights[0].utf16, [2, 6]);
            assert_eq!(s.highlights[0].location_indices, [index as u32]);
            assert_retained(text, s);
        }
    }
    #[test]
    fn filename_and_path_are_distinct_exact_fields_without_source() {
        let name = "😀Example.md";
        let path = "folder/😀Example.md";
        let mut matches = matched(vec![
            LocationProof::Filename {
                range: range(name, 4, 11),
                count: 1,
            },
            LocationProof::Path {
                range: range(path, 0, 6),
                count: 1,
            },
        ]);
        matches.filename = Some(SearchFieldMatches {
            value: name.into(),
            ranges: vec![range(name, 4, 11)],
        });
        matches.filepath = Some(SearchFieldMatches {
            value: path.into(),
            ranges: vec![range(path, 0, 6)],
        });
        let output = project(
            &matches,
            &[0, 1],
            SearchSource::NotText,
            SearchContext::Line,
        );
        assert_eq!(output.snippets.len(), 2);
        assert_eq!(output.snippets[0].origin, SearchSnippetOrigin::Filename);
        assert_eq!(output.snippets[1].origin, SearchSnippetOrigin::Path);
        assert_retained(name, &output.snippets[0]);
        assert_retained(path, &output.snippets[1]);
    }
    #[test]
    fn long_match_clips_excerpt_but_preserves_original_locator() {
        let text = "😀".repeat(700);
        let matches = matched(vec![occurrence(&text, 0, text.len())]);
        let output = project(
            &matches,
            &[0],
            SearchSource::Text(&text),
            SearchContext::Line,
        );
        let s = &output.snippets[0];
        assert_eq!(s.text.chars().count(), 512);
        assert!(!s.clipped_before);
        assert!(s.clipped_after);
        assert_eq!(s.highlights[0].utf16, [0, 1024]);
        assert_eq!(output.locations[0], matches.location(0).unwrap());
        assert_retained(&text, s);
    }
    #[test]
    fn section_prefers_full_list_item_before_smaller_non_list_block() {
        let text = "- parent hit\n  continuation\n  - child hit\n\noutside";
        let start = text.find("hit").unwrap();
        let end = text.find("\n\n").unwrap();
        let mut metadata = parse_markdown(&MetadataRequest {
            entry_id: EntryId::new("snippet-entry").unwrap(),
            content_revision: Revision::new("snippet-revision").unwrap(),
            source: text.into(),
        })
        .unwrap();
        metadata.blocks = vec![MarkdownBlock {
            kind: BlockKind::Paragraph,
            range: range(text, start, start + 3),
        }];
        metadata.list_items = vec![ListItem {
            range: range(text, 0, end),
            task_status: None,
        }];
        let matches = matched(vec![occurrence(text, start, start + 3)]);
        let output = snippets_checked(
            &matches,
            vec![matches.location(0).unwrap()],
            SearchDocument {
                path: "x.md",
                source: SearchSource::Text(text),
                metadata: SearchMetadataInput::Present(&metadata),
            },
            SearchContext::Section,
            MAX_OWNED_BYTES,
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
        assert_eq!(output.snippets[0].text, text[..end]);
        assert_retained(text, &output.snippets[0]);
    }
    #[test]
    fn malformed_utf16_and_duplicate_ordinals_are_rejected() {
        let text = "😀hit";
        let matches = matched(vec![occurrence(text, 4, 7)]);
        let mut bad = matches.location(0).unwrap();
        let SearchLocator::Source { range, .. } = &mut bad.locator else {
            unreachable!()
        };
        range.utf16[0] = 1;
        let document = || SearchDocument {
            path: "x.md",
            source: SearchSource::Text(text),
            metadata: SearchMetadataInput::NotApplicable,
        };
        assert!(matches!(
            snippets_checked(
                &matches,
                vec![bad],
                document(),
                SearchContext::Line,
                MAX_OWNED_BYTES,
                |_| Ok::<_, ()>(())
            ),
            Err(SearchError::InvalidDocument(_))
        ));
        assert!(matches!(
            snippets_checked(
                &matches,
                vec![matches.location(0).unwrap(); 2],
                document(),
                SearchContext::Line,
                MAX_OWNED_BYTES,
                |_| Ok::<_, ()>(())
            ),
            Err(SearchError::InvalidDocument(_))
        ));
    }
    #[test]
    fn cancellation_precedes_source_scanning_and_source_scan_cost_is_once() {
        let text = format!("{}hit hit", "x".repeat(1024 * 1024));
        let start = text.len() - 7;
        let matches = matched(vec![
            occurrence(&text, start, start + 3),
            occurrence(&text, start + 4, start + 7),
        ]);
        let document = || SearchDocument {
            path: "x.md",
            source: SearchSource::Text(&text),
            metadata: SearchMetadataInput::NotApplicable,
        };
        let stopped = snippets_checked(
            &matches,
            vec![matches.location(0).unwrap()],
            document(),
            SearchContext::Line,
            MAX_OWNED_BYTES,
            |_| Err("cancelled"),
        );
        assert!(matches!(stopped, Err(SearchError::Host("cancelled"))));
        let mut units = 0;
        let output = snippets_checked(
            &matches,
            vec![matches.location(0).unwrap(), matches.location(1).unwrap()],
            document(),
            SearchContext::Line,
            MAX_OWNED_BYTES,
            |n| {
                units += n;
                Ok::<_, ()>(())
            },
        )
        .unwrap();
        assert_eq!(output.snippets.len(), 1);
        assert!(units < text.len() / 16 + 10_000, "{units}");
        assert!(output.retained_bytes() > output.snippets[0].text.len());
    }

    #[test]
    fn line_context_counts_scalars_instead_of_bytes_or_utf16_units() {
        let text = format!("{}hit{}", "😀".repeat(150), "😀".repeat(150));
        let start = 150 * 4;
        let matches = matched(vec![occurrence(&text, start, start + 3)]);
        let output = project(
            &matches,
            &[0],
            SearchSource::Text(&text),
            SearchContext::Line,
        );
        let s = &output.snippets[0];
        assert_eq!(s.text.chars().count(), 203);
        assert_eq!(s.highlights[0].utf16, [200, 203]);
        assert!(s.clipped_before && s.clipped_after);
        assert_retained(&text, s);
    }
    #[test]
    fn pathological_association_or_initial_chunk_size_is_explicit_resource_error() {
        let text = "hit";
        let matches = matched((0..1025).map(|_| occurrence(text, 0, 3)).collect());
        let document = || SearchDocument {
            path: "x.md",
            source: SearchSource::Text(text),
            metadata: SearchMetadataInput::NotApplicable,
        };
        let too_many_associations = snippets_checked(
            &matches,
            vec![matches.location(0).unwrap()],
            document(),
            SearchContext::Line,
            MAX_OWNED_BYTES,
            |_| Ok::<_, ()>(()),
        );
        assert!(matches!(
            too_many_associations,
            Err(SearchError::Resource(_))
        ));
        let initial = (0..65).map(|i| matches.location(i).unwrap()).collect();
        assert!(matches!(
            snippets_checked(
                &matches,
                initial,
                document(),
                SearchContext::Line,
                MAX_OWNED_BYTES,
                |_| Ok::<_, ()>(())
            ),
            Err(SearchError::Resource(_))
        ));
    }

    #[test]
    fn owned_limit_precedes_map_allocation_and_no_source_needs_no_allocation() {
        let text = format!("{}hit", "x".repeat(1024 * 1024));
        let start = text.len() - 3;
        let matches = matched(vec![occurrence(&text, start, start + 3)]);
        let mut scan_fences = 0;
        let output = snippets_checked(
            &matches,
            vec![matches.location(0).unwrap()],
            SearchDocument {
                path: "x.md",
                source: SearchSource::Text(&text),
                metadata: SearchMetadataInput::NotApplicable,
            },
            SearchContext::Line,
            32 * 1024,
            |n| {
                if n == 0 {
                    scan_fences += 1;
                }
                Ok::<_, ()>(())
            },
        );
        assert!(matches!(output, Err(SearchError::Resource(_))));
        assert_eq!(scan_fences, 0);
        let unavailable = snippets_checked(
            &matches,
            vec![matches.location(0).unwrap()],
            SearchDocument {
                path: "x.md",
                source: SearchSource::Unavailable,
                metadata: SearchMetadataInput::NotApplicable,
            },
            SearchContext::Line,
            0,
            |_| Ok::<_, ()>(()),
        )
        .unwrap();
        assert!(unavailable.snippets.is_empty());
        assert_eq!(unavailable.locations.len(), 1);
    }

    #[test]
    fn maximum_source_and_independent_filename_fit_caller_work_and_owned_bounds() {
        let text = format!("{}hit", "x".repeat(MAX_FIELD_BYTES - 3));
        let start = text.len() - 3;
        let name = "hit.md";
        let mut matches = matched(vec![
            occurrence(&text, start, text.len()),
            LocationProof::Filename {
                range: range(name, 0, 3),
                count: 1,
            },
        ]);
        matches.filename = Some(SearchFieldMatches {
            value: name.into(),
            ranges: vec![range(name, 0, 3)],
        });
        let mut units = 0usize;
        let output = snippets_checked(
            &matches,
            vec![matches.location(0).unwrap(), matches.location(1).unwrap()],
            SearchDocument {
                path: "notes/hit.md",
                source: SearchSource::Text(&text),
                metadata: SearchMetadataInput::NotApplicable,
            },
            SearchContext::Line,
            3 * 1024 * 1024,
            |n| {
                units = units.checked_add(n).ok_or("work overflow")?;
                if units > 2_000_000 {
                    Err("work limit")
                } else {
                    Ok(())
                }
            },
        )
        .unwrap();
        assert_eq!(text.len(), MAX_FIELD_BYTES);
        assert_eq!(output.snippets.len(), 2);
        assert_eq!(output.snippets[0].origin, SearchSnippetOrigin::Source);
        assert_eq!(output.snippets[1].origin, SearchSnippetOrigin::Filename);
        assert_retained(&text, &output.snippets[0]);
        assert_retained(name, &output.snippets[1]);
        assert!(units <= 2_000_000);
        assert!(output.retained_bytes() < 3 * 1024 * 1024);
    }

    #[test]
    fn later_chunk_augmentation_returns_ascending_unique_stable_indices() {
        let text = "hit ".repeat(66);
        let matches = matched(
            (0..66)
                .map(|i| occurrence(&text, i * 4, i * 4 + 3))
                .collect(),
        );
        let output = project(
            &matches,
            &[64, 65],
            SearchSource::Text(&text),
            SearchContext::Line,
        );
        let indices: Vec<_> = output
            .locations
            .iter()
            .map(|location| location.index)
            .collect();
        assert_eq!(indices, (39..66).collect::<Vec<_>>());
        assert!(output
            .locations
            .windows(2)
            .all(|pair| pair[0].index < pair[1].index));
        assert_eq!(output.snippets.len(), 1);
        assert_eq!(output.snippets[0].primary_location_index, 64);
        for snippet in &output.snippets {
            assert!(indices.contains(&snippet.primary_location_index));
            assert!(snippet.highlights.iter().all(|highlight| highlight
                .location_indices
                .iter()
                .all(|index| indices.contains(index))));
            assert_retained(&text, snippet);
        }
        for location in &output.locations {
            assert_eq!(
                *location,
                matches.location(location.index as usize).unwrap()
            );
        }
    }
}
