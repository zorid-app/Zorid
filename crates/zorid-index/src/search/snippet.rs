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

// Conservatively account allocations across one projection, including persistent
// projector capacities and scratch that has already been dropped. Admission precedes allocation; actual capacity
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

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum OriginKey {
    Source,
    Filename,
    Path,
    PropertyKey(usize),
    PropertyValue(usize),
}
impl OriginKey {
    fn of(proof: &LocationProof) -> Self {
        match proof {
            LocationProof::Source { .. } => Self::Source,
            LocationProof::Filename { .. } => Self::Filename,
            LocationProof::Path { .. } => Self::Path,
            LocationProof::Key { property, .. } => Self::PropertyKey(*property),
            LocationProof::Value { property, .. } => Self::PropertyValue(*property),
        }
    }
    fn group(group: &Group<'_>) -> Option<Self> {
        Some(match group.origin {
            SearchSnippetOrigin::Source => Self::Source,
            SearchSnippetOrigin::Filename => Self::Filename,
            SearchSnippetOrigin::Path => Self::Path,
            SearchSnippetOrigin::PropertyKey => Self::PropertyKey(group.property?),
            SearchSnippetOrigin::PropertyValue => Self::PropertyValue(group.property?),
        })
    }
}
struct Interval {
    origin: OriginKey,
    start: u32,
    end: u32,
    prefix_end: u32,
    index: u32,
    range_index: usize,
}

/// Transient preparation for one admitted synchronous document invocation.
/// Borrows exact retained inputs; owns only interval descriptors and a lazy sparse
/// source coordinate map. It stores no body, source reader, pin or cursor.
pub struct SnippetProjector<'a> {
    matches: &'a SearchMatches,
    document: SearchDocument<'a>,
    intervals: Vec<Interval>,
    source_coordinates: Option<Coordinates<'a>>,
}
impl<'a> SnippetProjector<'a> {
    pub fn new_checked<E>(
        matches: &'a SearchMatches,
        document: SearchDocument<'a>,
        owned_byte_limit: usize,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Self, SearchError<E>> {
        charge(&mut check, matches.locations.len().saturating_add(1))?;
        let usable = |p: &LocationProof| {
            !matches!(p, LocationProof::Source { .. })
                || matches!(document.source, SearchSource::Text(_))
        };
        let count = matches
            .locations
            .iter()
            .filter(|p| usable(p))
            .try_fold(0usize, |n, p| n.checked_add(proof_ranges(p).0.len()))
            .ok_or(SearchError::Resource("Snippet interval count overflow"))?;
        let mut owned = OwnedBudget {
            used: 0,
            limit: owned_byte_limit.min(MAX_OWNED_BYTES),
        };
        charge(&mut check, count.saturating_add(matches.locations.len()))?;
        let mut intervals = owned.vector(count)?;
        for (index, proof) in matches
            .locations
            .iter()
            .enumerate()
            .filter(|(_, p)| usable(p))
        {
            for (range_index, range) in proof_ranges(proof).0.iter().enumerate() {
                if range.bytes[0] > range.bytes[1] {
                    return Err(SearchError::InvalidDocument("Invalid snippet interval"));
                }
                intervals.push(Interval {
                    origin: OriginKey::of(proof),
                    start: range.bytes[0],
                    end: range.bytes[1],
                    prefix_end: 0,
                    index: index as u32,
                    range_index,
                });
            }
        }
        charge(&mut check, sort_work(intervals.len()))?;
        intervals.sort_unstable_by_key(|i| (i.origin, i.start, i.end, i.index, i.range_index));
        charge(&mut check, intervals.len())?;
        let mut previous = None;
        let mut prefix_end = 0;
        for interval in &mut intervals {
            if previous != Some(interval.origin) {
                prefix_end = 0;
                previous = Some(interval.origin);
            }
            prefix_end = prefix_end.max(interval.end);
            interval.prefix_end = prefix_end;
        }
        Ok(Self {
            matches,
            document,
            intervals,
            source_coordinates: None,
        })
    }
    /// Actual owned heap capacities. Inline stack fields and borrowed input data
    /// are excluded; callers already account their matches and initial locators.
    pub fn retained_bytes(&self) -> usize {
        self.intervals.capacity() * std::mem::size_of::<Interval>()
            + self
                .source_coordinates
                .as_ref()
                .map_or(0, |c| c.points.capacity() * std::mem::size_of::<Point>())
    }
    pub fn project_checked<E>(
        &mut self,
        locations: Vec<SearchLocation>,
        context: SearchContext,
        owned_byte_limit: usize,
        mut check: impl FnMut(usize) -> Result<(), E>,
    ) -> Result<SnippetChunk, SearchError<E>> {
        charge(&mut check, 1)?;
        if locations.len() > MAX_LOCATIONS {
            return Err(SearchError::Resource("Snippet chunk location limit"));
        }
        charge(&mut check, locations.len().saturating_mul(locations.len()))?;
        for (position, location) in locations.iter().enumerate() {
            if location.index as usize >= self.matches.locations_len()
                || locations[..position]
                    .iter()
                    .any(|p| p.index == location.index)
            {
                return Err(SearchError::InvalidDocument(
                    "Invalid snippet location ordinal",
                ));
            }
        }
        let mut owned = OwnedBudget {
            used: self.retained_bytes(),
            limit: owned_byte_limit.min(MAX_OWNED_BYTES),
        };
        owned.admit(0)?;
        if self.source_coordinates.is_none()
            && locations
                .iter()
                .any(|l| matches!(l.locator, SearchLocator::Source { .. }))
        {
            if let SearchSource::Text(text) = self.document.source {
                if text.len() > MAX_FIELD_BYTES {
                    return Err(SearchError::Resource("Snippet field byte limit"));
                }
                self.source_coordinates = Some(Coordinates::new(text, &mut check, &mut owned)?);
            }
        }
        project(
            self.matches,
            locations,
            SearchDocument {
                path: self.document.path,
                source: self.document.source,
                metadata: self.document.metadata,
            },
            context,
            &self.intervals,
            self.source_coordinates.as_ref(),
            owned,
            &mut check,
        )
    }
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
    locations: Vec<SearchLocation>,
    document: SearchDocument<'_>,
    context: SearchContext,
    owned_byte_limit: usize,
    mut check: impl FnMut(usize) -> Result<(), E>,
) -> Result<SnippetChunk, SearchError<E>> {
    let mut projector =
        SnippetProjector::new_checked(matches, document, owned_byte_limit, &mut check)?;
    projector.project_checked(locations, context, owned_byte_limit, check)
}

fn project<E>(
    matches: &SearchMatches,
    mut locations: Vec<SearchLocation>,
    document: SearchDocument<'_>,
    context: SearchContext,
    intervals: &[Interval],
    source_coordinates: Option<&Coordinates<'_>>,
    mut owned: OwnedBudget,
    mut check: impl FnMut(usize) -> Result<(), E>,
) -> Result<SnippetChunk, SearchError<E>> {
    let mut groups: Vec<Group<'_>> = Vec::new();
    for location in &locations {
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
    let mut needed: Vec<usize> = owned.vector(MAX_ASSOCIATED_LOCATIONS)?;
    for group in groups {
        let temporary_coordinates;
        let coordinates = if group.origin == SearchSnippetOrigin::Source {
            source_coordinates.ok_or(SearchError::InvalidDocument(
                "Missing prepared source coordinates",
            ))?
        } else {
            temporary_coordinates = Coordinates::new(group.text, &mut check, &mut owned)?;
            &temporary_coordinates
        };
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
        let origin = OriginKey::group(&group).ok_or(SearchError::InvalidDocument(
            "Missing snippet origin identity",
        ))?;
        for w in merged {
            let active =
                active_intersections(intervals, origin, &w, matches, &mut owned, &mut check)?;
            for item in &active {
                charge(&mut check, log_work(needed.len()).saturating_add(1))?;
                if let Err(position) = needed.binary_search(&(item.index as usize)) {
                    if needed.len() >= MAX_ASSOCIATED_LOCATIONS {
                        return Err(SearchError::Resource("Snippet associated location limit"));
                    }
                    let (ranges, _) = proof_ranges(&matches.locations[item.index as usize]);
                    charge(
                        &mut check,
                        ranges
                            .len()
                            .saturating_mul(RANGE_LOOKUP_WORK)
                            .saturating_add(needed.len() - position),
                    )?;
                    // Keep the complete locator/all its ranges, even though only
                    // this window's intersections are used for normalization.
                    for range in ranges {
                        coordinates.range::<E>(range)?;
                    }
                    needed.insert(position, item.index as usize);
                }
            }
            charge(&mut check, active.len())?;
            let active_spans = active
                .iter()
                .filter(|a| !a.anchor && a.range.bytes[0] < a.range.bytes[1])
                .count();
            charge(
                &mut check,
                active_spans
                    .saturating_mul(RANGE_LOOKUP_WORK)
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
                &active,
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
    for index in needed {
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

fn log_work(n: usize) -> usize {
    if n <= 1 {
        0
    } else {
        usize::BITS as usize - (n - 1).leading_zeros() as usize
    }
}
fn sort_work(n: usize) -> usize {
    n.saturating_mul(log_work(n))
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
struct ActiveSpan<'a> {
    index: u32,
    range: &'a SourceRange,
    anchor: bool,
}
fn active_intersections<'a, E>(
    intervals: &[Interval],
    origin: OriginKey,
    window: &Window,
    matches: &'a SearchMatches,
    owned: &mut OwnedBudget,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<Vec<ActiveSpan<'a>>, SearchError<E>> {
    // Binary search is prepaid independently from actual candidate visits. A
    // long enclosing interval can widen the prefix bucket; those visits remain
    // fully charged rather than being called logarithmic or silently dropped.
    charge(
        check,
        log_work(intervals.len())
            .saturating_mul(4)
            .saturating_add(4),
    )?;
    let first = intervals.partition_point(|i| i.origin < origin);
    let last = intervals.partition_point(|i| i.origin <= origin);
    let origin_intervals = &intervals[first..last];
    let upper = origin_intervals.partition_point(|i| i.start as usize <= window.end);
    let lower =
        origin_intervals[..upper].partition_point(|i| (i.prefix_end as usize) < window.start);
    let bucket = &origin_intervals[lower..upper];
    charge(check, bucket.len())?;
    let hit = |i: &&Interval| {
        ((i.start as usize) < window.end && window.start < i.end as usize)
            || (i.start == i.end
                && window.start <= i.start as usize
                && i.start as usize <= window.end)
    };
    let count = bucket.iter().filter(hit).count();
    let mut active = owned.vector(count)?;
    charge(check, bucket.len().saturating_add(count))?;
    for interval in bucket.iter().filter(hit) {
        let proof = &matches.locations[interval.index as usize];
        let (ranges, anchor) = proof_ranges(proof);
        active.push(ActiveSpan {
            index: interval.index,
            range: &ranges[interval.range_index],
            anchor,
        });
    }
    Ok(active)
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
struct HighlightEvent {
    point: u32,
    index: u32,
    starts: bool,
}
fn highlights<E>(
    locations: &[ActiveSpan<'_>],
    coordinates: &Coordinates<'_>,
    start: usize,
    end: usize,
    active_spans: usize,
    owned: &mut OwnedBudget,
    check: &mut impl FnMut(usize) -> Result<(), E>,
) -> Result<Vec<SearchSnippetHighlight>, SearchError<E>> {
    let base = coordinates.point(start).unwrap().utf16;
    let mut events = owned.vector(active_spans.saturating_mul(2))?;
    charge(check, locations.len())?;
    for location in locations {
        if location.anchor {
            continue;
        }
        let a = (location.range.bytes[0] as usize).max(start);
        let b = (location.range.bytes[1] as usize).min(end);
        if a < b {
            events.push(HighlightEvent {
                point: coordinates.point(a).unwrap().utf16 - base,
                index: location.index,
                starts: true,
            });
            events.push(HighlightEvent {
                point: coordinates.point(b).unwrap().utf16 - base,
                index: location.index,
                starts: false,
            });
        }
    }
    charge(check, sort_work(events.len()))?;
    events.sort_unstable_by_key(|e| (e.point, e.index, e.starts));
    let mut active: Vec<(u32, usize)> = owned.vector(active_spans)?;
    let mut result: Vec<SearchSnippetHighlight> = owned.vector(events.len())?;
    charge(check, events.len())?;
    let mut previous = events.first().map_or(0, |e| e.point);
    for event in events {
        if previous < event.point && !active.is_empty() {
            charge(check, active.len())?;
            let same = result.last().is_some_and(|last| {
                last.utf16[1] == previous
                    && last
                        .location_indices
                        .iter()
                        .copied()
                        .eq(active.iter().map(|(i, _)| *i))
            });
            if same {
                result.last_mut().unwrap().utf16[1] = event.point;
            } else {
                charge(check, active.len())?;
                let mut indices = owned.vector(active.len())?;
                indices.extend(active.iter().map(|(i, _)| *i));
                result.push(SearchSnippetHighlight {
                    utf16: [previous, event.point],
                    location_indices: indices,
                });
            }
        }
        charge(check, log_work(active.len()).saturating_add(1))?;
        match active.binary_search_by_key(&event.index, |(i, _)| *i) {
            Ok(position) => {
                if event.starts {
                    active[position].1 += 1;
                } else {
                    active[position].1 -= 1;
                    if active[position].1 == 0 {
                        charge(check, active.len() - position)?;
                        active.remove(position);
                    }
                }
            }
            Err(position) if event.starts => {
                charge(check, active.len() - position)?;
                active.insert(position, (event.index, 1));
            }
            Err(_) => {
                return Err(SearchError::InvalidDocument(
                    "Unbalanced snippet highlight interval",
                ))
            }
        }
        previous = event.point;
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
        let mut projector = raw_projector(&matches, &text);
        let prepared_bytes = projector.retained_bytes();
        let interval_capacity = projector.intervals.capacity();
        let intervals = projector.intervals.as_ptr();
        assert!(projector.source_coordinates.is_none());
        let map_bytes = (text.len() / STRIDE + 2) * std::mem::size_of::<Point>();
        assert!(prepared_bytes + map_bytes > 32 * 1024);
        let output = projector.project_checked(
            vec![matches.location(0).unwrap()],
            SearchContext::Line,
            32 * 1024,
            |_| Ok::<_, ()>(()),
        );
        assert!(matches!(output, Err(SearchError::Resource(_))));
        // Coordinates::new admits its complete point allocation before its
        // character loop. This limit rejects that allocation; the prepared
        // intervals survive unchanged and no source map is installed.
        assert!(projector.source_coordinates.is_none());
        assert_eq!(projector.retained_bytes(), prepared_bytes);
        assert_eq!(projector.intervals.capacity(), interval_capacity);
        assert_eq!(projector.intervals.as_ptr(), intervals);

        let mut unavailable_units = 0usize;
        let mut unavailable_projector = SnippetProjector::new_checked(
            &matches,
            SearchDocument {
                path: "x.md",
                source: SearchSource::Unavailable,
                metadata: SearchMetadataInput::NotApplicable,
            },
            0,
            |n| {
                unavailable_units += n;
                Ok::<_, ()>(())
            },
        )
        .unwrap();
        assert_eq!(unavailable_projector.retained_bytes(), 0);
        assert!(unavailable_projector.source_coordinates.is_none());
        let unavailable = unavailable_projector
            .project_checked(
                vec![matches.location(0).unwrap()],
                SearchContext::Line,
                0,
                |n| {
                    unavailable_units += n;
                    Ok::<_, ()>(())
                },
            )
            .unwrap();
        assert_eq!(unavailable_projector.retained_bytes(), 0);
        assert!(unavailable_projector.source_coordinates.is_none());
        assert!(unavailable.snippets.is_empty());
        assert_eq!(unavailable.locations, vec![matches.location(0).unwrap()]);
        // Unavailable source uses bounded descriptor work even though this
        // original locator belongs to a body larger than1MiB. Zero-unit
        // cancellation callbacks are allowed and are not scan sentinels.
        assert!(unavailable_units > 0 && unavailable_units < 64);
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

    fn raw_projector<'a>(matches: &'a SearchMatches, source: &'a str) -> SnippetProjector<'a> {
        SnippetProjector::new_checked(
            matches,
            SearchDocument {
                path: "notes/x.md",
                source: SearchSource::Text(source),
                metadata: SearchMetadataInput::NotApplicable,
            },
            MAX_OWNED_BYTES,
            |_| Ok::<_, ()>(()),
        )
        .unwrap()
    }
    #[test]
    fn raw_projector_reuses_the_sparse_source_scan_across_chunks() {
        let prefix = "x".repeat(1024 * 1024);
        let text = format!("{}{}", prefix, "hit ".repeat(128));
        let matches = matched(
            (0..128)
                .map(|i| occurrence(&text, prefix.len() + i * 4, prefix.len() + i * 4 + 3))
                .collect(),
        );
        let mut projector = raw_projector(&matches, &text);
        let prepared_bytes = projector.retained_bytes();
        assert!(projector.source_coordinates.is_none());
        let mut cold_units = 0usize;
        let cold = projector
            .project_checked(
                vec![matches.location(0).unwrap()],
                SearchContext::Line,
                3 * 1024 * 1024,
                |n| {
                    cold_units += n;
                    Ok::<_, ()>(())
                },
            )
            .unwrap();
        assert_retained(&text, &cold.snippets[0]);
        let cached_bytes = projector.retained_bytes();
        let coordinates = projector.source_coordinates.as_ref().unwrap();
        let cached_points = coordinates.points.as_ptr();
        let cached_capacity = coordinates.points.capacity();
        let cached_contents: Vec<_> = coordinates
            .points
            .iter()
            .map(|p| (p.byte, p.utf16, p.scalar))
            .collect();
        assert!(cached_bytes > prepared_bytes);
        let mut warm_units = 0usize;
        let warm = projector
            .project_checked(
                vec![matches.location(0).unwrap()],
                SearchContext::Line,
                3 * 1024 * 1024,
                |n| {
                    warm_units += n;
                    Ok::<_, ()>(())
                },
            )
            .unwrap();
        let source_prepaid = text.len().div_ceil(64) + 1;
        assert_eq!(cold_units.checked_sub(warm_units), Some(source_prepaid));
        assert!(warm_units < source_prepaid);
        assert_eq!(warm.locations, cold.locations);
        assert_eq!(warm.snippets, cold.snippets);
        assert_eq!(projector.retained_bytes(), cached_bytes);
        let coordinates = projector.source_coordinates.as_ref().unwrap();
        assert_eq!(coordinates.points.as_ptr(), cached_points);
        assert_eq!(coordinates.points.capacity(), cached_capacity);
        assert_eq!(
            coordinates
                .points
                .iter()
                .map(|p| (p.byte, p.utf16, p.scalar))
                .collect::<Vec<_>>(),
            cached_contents
        );
        assert!(
            projector.retained_bytes() + cold.retained_bytes() + warm.retained_bytes()
                < 3 * 1024 * 1024
        );
        drop(cold);
        drop(warm);

        let later = projector
            .project_checked(
                vec![matches.location(1).unwrap()],
                SearchContext::Line,
                3 * 1024 * 1024,
                |_| Ok::<_, ()>(()),
            )
            .unwrap();
        assert_eq!(later.snippets[0].primary_location_index, 1);
        assert_retained(&text, &later.snippets[0]);
        assert_eq!(projector.retained_bytes(), cached_bytes);
        assert_eq!(
            projector
                .source_coordinates
                .as_ref()
                .unwrap()
                .points
                .as_ptr(),
            cached_points
        );
    }
    #[test]
    fn dense_disjoint_windows_visit_local_intersections_and_preserve_all_snippets() {
        let text = "hit\n".repeat(1024);
        let matches = matched(
            (0..1024)
                .map(|i| occurrence(&text, i * 4, i * 4 + 3))
                .collect(),
        );
        let mut projector = raw_projector(&matches, &text);
        let mut units = 0usize;
        let output = projector
            .project_checked(
                (0..64).map(|i| matches.location(i).unwrap()).collect(),
                SearchContext::Line,
                MAX_OWNED_BYTES,
                |n| {
                    units += n;
                    Ok::<_, ()>(())
                },
            )
            .unwrap();
        assert_eq!(output.snippets.len(), 64);
        assert_eq!(output.locations.len(), 64);
        // Unchanged64 occurrence-window preparations cost~72k; indexed
        // associations/coordinates/sweeps and headers add<~70k. This bound
        // leaves margin; source arithmetic for the former cross-window loops
        // exceeds400k (an inference, not a measured baseline).
        assert!(units < 200_000, "dense chunk work {units}");
        for (index, snippet) in output.snippets.iter().enumerate() {
            assert_eq!(snippet.text, "hit");
            assert_eq!(snippet.primary_location_index, index as u32);
            assert_eq!(snippet.highlights.len(), 1);
            assert_eq!(snippet.highlights[0].utf16, [0, 3]);
            assert_eq!(snippet.highlights[0].location_indices, [index as u32]);
            assert_retained(&text, snippet);
        }
    }
    #[test]
    fn enclosing_interval_bucket_visits_are_charged_before_pathological_scan() {
        let text = "hit\n".repeat(512);
        let mut proofs = vec![occurrence(&text, 0, text.len())];
        proofs.extend((1..512).map(|i| occurrence(&text, i * 4, i * 4 + 3)));
        let matches = matched(proofs);
        let projector = raw_projector(&matches, &text);
        let window = Window {
            start: 500 * 4,
            end: 500 * 4 + 3,
            primary: 500,
        };
        let mut owned = OwnedBudget {
            used: projector.retained_bytes(),
            limit: MAX_OWNED_BYTES,
        };
        let mut units = 0;
        let active = active_intersections(
            &projector.intervals,
            OriginKey::Source,
            &window,
            &matches,
            &mut owned,
            &mut |n| {
                units += n;
                Ok::<_, ()>(())
            },
        )
        .unwrap();
        assert_eq!(active.iter().map(|a| a.index).collect::<Vec<_>>(), [0, 500]);
        assert!(units >= 2 * 501);
        let mut owned = OwnedBudget {
            used: projector.retained_bytes(),
            limit: MAX_OWNED_BYTES,
        };
        let mut spent = 0;
        let stopped = active_intersections(
            &projector.intervals,
            OriginKey::Source,
            &window,
            &matches,
            &mut owned,
            &mut |n| {
                spent += n;
                if spent > 700 {
                    Err("bucket budget")
                } else {
                    Ok(())
                }
            },
        );
        assert!(matches!(stopped, Err(SearchError::Host("bucket budget"))));
    }
    #[test]
    fn endpoint_sweep_keeps_one_association_for_overlapping_ranges_of_same_key() {
        let key = "abcdef";
        let key_match = SearchKeyMatch::Ranges {
            ranges: vec![range(key, 0, 4), range(key, 2, 6)],
        };
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
        assert_eq!(output.snippets[0].highlights.len(), 1);
        assert_eq!(output.snippets[0].highlights[0].utf16, [0, 6]);
        assert_eq!(output.snippets[0].highlights[0].location_indices, [0]);
        assert_eq!(output.locations[0], matches.location(0).unwrap());
    }
    #[test]
    fn persistent_capacities_and_cancel_are_admitted_before_repeated_chunk_work() {
        let text = format!("{}hit", "x".repeat(1024 * 1024));
        let start = text.len() - 3;
        let matches = matched(vec![occurrence(&text, start, start + 3)]);
        assert!(matches!(
            SnippetProjector::new_checked(
                &matches,
                SearchDocument {
                    path: "x.md",
                    source: SearchSource::Text(&text),
                    metadata: SearchMetadataInput::NotApplicable
                },
                1,
                |_| Ok::<_, ()>(())
            ),
            Err(SearchError::Resource(_))
        ));
        let mut projector = raw_projector(&matches, &text);
        let prepared = projector.retained_bytes();
        assert!(prepared > 0);
        let rejected = projector.project_checked(
            vec![matches.location(0).unwrap()],
            SearchContext::Line,
            prepared - 1,
            |_| Ok::<_, ()>(()),
        );
        assert!(matches!(rejected, Err(SearchError::Resource(_))));
        assert!(projector.source_coordinates.is_none());
        let first = projector
            .project_checked(
                vec![matches.location(0).unwrap()],
                SearchContext::Line,
                MAX_OWNED_BYTES,
                |_| Ok::<_, ()>(()),
            )
            .unwrap();
        drop(first);
        let cached = projector.retained_bytes();
        let cached_points = projector
            .source_coordinates
            .as_ref()
            .unwrap()
            .points
            .as_ptr();
        let stopped = projector.project_checked(
            vec![matches.location(0).unwrap()],
            SearchContext::Line,
            MAX_OWNED_BYTES,
            |_| Err("cancelled chunk"),
        );
        assert!(matches!(stopped, Err(SearchError::Host("cancelled chunk"))));
        assert_eq!(projector.retained_bytes(), cached);
        assert_eq!(
            projector
                .source_coordinates
                .as_ref()
                .unwrap()
                .points
                .as_ptr(),
            cached_points
        );
    }

    #[test]
    fn indexed_zero_points_include_both_window_boundaries_without_adjacent_positive_span() {
        let text = "hitx";
        let matches = matched(vec![
            occurrence(text, 0, 3),
            LocationProof::Source {
                range: range(text, 0, 0),
                kind: SearchContentKind::Anchor,
                count: 0,
            },
            LocationProof::Source {
                range: range(text, 3, 3),
                kind: SearchContentKind::Anchor,
                count: 0,
            },
            occurrence(text, 3, 4),
        ]);
        let projector = raw_projector(&matches, text);
        let mut owned = OwnedBudget {
            used: projector.retained_bytes(),
            limit: MAX_OWNED_BYTES,
        };
        let active = active_intersections(
            &projector.intervals,
            OriginKey::Source,
            &Window {
                start: 0,
                end: 3,
                primary: 0,
            },
            &matches,
            &mut owned,
            &mut |_| Ok::<_, ()>(()),
        )
        .unwrap();
        let mut indices: Vec<_> = active.iter().map(|a| a.index).collect();
        indices.sort_unstable();
        assert_eq!(indices, [0, 1, 2]);
    }
    #[test]
    fn indexed_empty_property_value_keeps_zero_count_primary_without_highlight() {
        let mut matches = matched(vec![LocationProof::Value {
            property: 0,
            range: range("", 0, 0),
            count: 0,
        }]);
        matches.properties.push(SearchPropertyMatch {
            key: "empty".into(),
            key_match: None,
            array_path: vec![1],
            value: Some(SearchPropertyValueMatch {
                text: "".into(),
                ranges: vec![range("", 0, 0)],
            }),
        });
        let output = project(&matches, &[0], SearchSource::NotText, SearchContext::Line);
        assert_eq!(output.locations.len(), 1);
        assert_eq!(
            output.locations[0].role,
            super::super::SearchLocationRole::Predicate
        );
        assert_eq!(output.locations[0].occurrences, 0);
        assert_eq!(output.snippets.len(), 1);
        assert_eq!(
            output.snippets[0].origin,
            SearchSnippetOrigin::PropertyValue
        );
        assert_eq!(output.snippets[0].text, "");
        assert_eq!(output.snippets[0].array_path, Some(vec![1]));
        assert_eq!(output.snippets[0].primary_location_index, 0);
        assert!(output.snippets[0].highlights.is_empty());
        assert_retained("", &output.snippets[0]);
    }
}
