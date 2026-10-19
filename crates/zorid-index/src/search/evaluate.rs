use super::parser::{Constant, Node, Pattern, Scope};
use super::*;
use std::cmp::Ordering;
use zorid_document::PropertyValue;

type Span = (usize, usize);
#[derive(Default)]
struct Raw {
    content: Vec<Span>,
    anchors: Vec<Span>,
    filename: Vec<Span>,
    filepath: Vec<Span>,
    key: Vec<Span>,
    properties: Vec<SearchPropertyMatch>,
    tags: Vec<SearchTagMatch>,
}
impl Raw {
    fn merge(&mut self, mut other: Self) {
        self.content.append(&mut other.content);
        self.anchors.append(&mut other.anchors);
        self.filename.append(&mut other.filename);
        self.filepath.append(&mut other.filepath);
        self.key.append(&mut other.key);
        self.properties.append(&mut other.properties);
        self.tags.append(&mut other.tags);
    }
    fn present(&self) -> bool {
        !self.content.is_empty()
            || !self.filename.is_empty()
            || !self.filepath.is_empty()
            || !self.key.is_empty()
            || !self.properties.is_empty()
            || !self.tags.is_empty()
            || !self.anchors.is_empty()
    }
}
enum Outcome {
    Yes(Raw),
    No,
    Inapplicable,
}
#[derive(Clone, Copy)]
enum Field {
    Content,
    Filename,
    Filepath,
    Key,
}
#[derive(Clone)]
struct Context<'a> {
    text: &'a str,
    base: usize,
    active: Vec<Field>,
    sensitive: bool,
    typed: Option<&'a PropertyValue>,
    key: Option<&'a str>,
    section: Option<usize>,
}
struct HeadingInterval {
    start: usize,
    end: usize,
    descendant_end: usize,
}
struct Evaluator<'a, 'b, F> {
    document: SearchDocument<'a>,
    filename: &'a str,
    query: &'b CompiledSearchQuery,
    check: F,
    work: usize,
    spans: usize,
    bytes: usize,
    headings: Option<Vec<HeadingInterval>>,
}
impl<'a, F, E> Evaluator<'a, '_, F>
where
    F: FnMut(usize) -> Result<(), E>,
{
    fn charge(&mut self, units: usize) -> Result<(), SearchError<E>> {
        (self.check)(units).map_err(SearchError::Host)?;
        self.work = self
            .work
            .checked_add(units)
            .ok_or(SearchError::Resource("Search work limit"))?;
        if self.work > self.query.limits.work {
            return Err(SearchError::Resource("Search work limit"));
        }
        Ok(())
    }
    fn scan(&mut self, len: usize) -> Result<(), SearchError<E>> {
        self.charge(1 + len / 64)
    }
    fn output(&mut self, spans: usize, bytes: usize) -> Result<(), SearchError<E>> {
        self.charge(spans)?;
        self.spans = self
            .spans
            .checked_add(spans)
            .ok_or(SearchError::Resource("Search span limit"))?;
        self.bytes = self
            .bytes
            .checked_add(bytes)
            .ok_or(SearchError::Resource("Search output limit"))?;
        if self.spans > self.query.limits.spans || self.bytes > self.query.limits.output_bytes {
            return Err(SearchError::Resource("Search output limit"));
        }
        Ok(())
    }
    fn normalize(&mut self, spans: Vec<Span>) -> Result<Vec<Span>, SearchError<E>> {
        self.charge(sort_work(spans.len()))?;
        Ok(normalize(spans))
    }
    fn metadata(&self) -> Option<&'a DocumentMetadata> {
        match self.document.metadata {
            SearchMetadataInput::Present(m) => Some(m),
            _ => None,
        }
    }
    fn checked_range(&mut self, range: &SourceRange) -> Result<(), SearchError<E>> {
        self.charge(1)?;
        let Some(m) = self.metadata() else {
            return Err(SearchError::InvalidDocument("Missing parser facts"));
        };
        if range.bytes[0] > range.bytes[1]
            || range.utf16[0] > range.utf16[1]
            || range.bytes[1] > m.source_length.bytes
            || range.utf16[1] > m.source_length.utf16
        {
            return Err(SearchError::InvalidDocument("Parser range exceeds source"));
        }
        if let Some(s) = self.source() {
            if !s.is_char_boundary(range.bytes[0] as usize)
                || !s.is_char_boundary(range.bytes[1] as usize)
            {
                return Err(SearchError::InvalidDocument("Parser range splits UTF8"));
            }
        }
        Ok(())
    }
    fn source(&self) -> Option<&'a str> {
        match self.document.source {
            SearchSource::Text(s) => Some(s),
            _ => None,
        }
    }
    fn eval(&mut self, node: &Node, c: &Context<'_>) -> Result<Outcome, SearchError<E>> {
        self.charge(1)?;
        Ok(match node {
            Node::Pattern(p) => return self.pattern(p, c),
            Node::Constant(v) => {
                let actual = c.typed.unwrap_or(&PropertyValue::Null);
                let yes = matches!(
                    (v, actual),
                    (Constant::True, PropertyValue::Bool(true))
                        | (Constant::False, PropertyValue::Bool(false))
                        | (Constant::Empty, PropertyValue::Null)
                );
                if yes && c.typed.is_none() {
                    Outcome::Yes(Raw::default())
                } else if yes {
                    let text = render(actual, 0, self)?;
                    self.output(1, 32)?;
                    Outcome::Yes(Raw {
                        content: vec![(c.base, c.base + text.len())],
                        ..Raw::default()
                    })
                } else {
                    Outcome::No
                }
            }
            Node::Compare(less, right) => {
                self.scan(c.text.len().saturating_add(right.len()))?;
                if let Some(value) = c.typed {
                    let ordering = match value {
                        PropertyValue::Null => None,
                        PropertyValue::String(left) => {
                            Some(left.encode_utf16().cmp(right.encode_utf16()))
                        }
                        PropertyValue::Number(n) => {
                            n.as_f64().and_then(|n| n.partial_cmp(&js_number(right)))
                        }
                        PropertyValue::Bool(b) => (*b as u8 as f64).partial_cmp(&js_number(right)),
                        PropertyValue::Array(_) => {
                            let text = render(value, 0, self)?;
                            Some(text.encode_utf16().cmp(right.encode_utf16()))
                        }
                        PropertyValue::Object(_) => {
                            Some("[object Object]".encode_utf16().cmp(right.encode_utf16()))
                        }
                    };
                    if ordering
                        == Some(if *less {
                            Ordering::Less
                        } else {
                            Ordering::Greater
                        })
                    {
                        let text = render(value, 0, self)?;
                        self.output(1, 32)?;
                        Outcome::Yes(Raw {
                            content: vec![(c.base, c.base + text.len())],
                            ..Raw::default()
                        })
                    } else {
                        Outcome::No
                    }
                } else {
                    Outcome::No
                }
            }
            Node::Not(child) => match self.eval(child, c)? {
                Outcome::Inapplicable => Outcome::Inapplicable,
                Outcome::Yes(_) => Outcome::No,
                Outcome::No => Outcome::Yes(Raw::default()),
            },
            Node::And(children) | Node::Or(children) => {
                let mut result = None;
                let mut no = false;
                for child in children {
                    match self.eval(child, c)? {
                        Outcome::No => {
                            if matches!(node, Node::And(_)) {
                                return Ok(Outcome::No);
                            }
                            no = true;
                        }
                        Outcome::Yes(found) => {
                            result.get_or_insert_with(Raw::default).merge(found);
                        }
                        Outcome::Inapplicable => {}
                    }
                }
                if let Some(found) = result {
                    Outcome::Yes(found)
                } else if no {
                    Outcome::No
                } else {
                    Outcome::Inapplicable
                }
            }
            Node::Property(key, value) => return self.property(key, value.as_deref(), c),
            Node::Scope(scope, child) => return self.scoped(*scope, child, c),
        })
    }
    fn pattern(&mut self, p: &Pattern, c: &Context<'_>) -> Result<Outcome, SearchError<E>> {
        if p.text.is_empty() {
            return Ok(if !p.quoted && !p.regex {
                Outcome::No
            } else {
                Outcome::Inapplicable
            });
        }
        let mut out = Raw::default();
        for field in &c.active {
            let text = match field {
                Field::Content => c.text,
                Field::Filename => self.filename,
                Field::Filepath => self.document.path,
                Field::Key => c.key.unwrap_or(""),
            };
            self.scan(text.len())?;
            if matches!(field, Field::Key) && p.quoted {
                // Quoted property names are exact and case-insensitive even
                // inside match-case, preserving the accepted search contract.
                if text.to_lowercase() == p.text.to_lowercase() {
                    self.output(1, 32)?;
                    out.key.push((0, text.len()));
                }
                continue;
            }
            let expression = if c.sensitive {
                &p.sensitive
            } else {
                &p.insensitive
            };
            let mut spans = Vec::new();
            let mut at = 0;
            while at <= text.len() {
                if p.fixed_literal {
                    // The field was prepaid once above. Fixed literal calls
                    // consume disjoint prefixes (at advances to match end),
                    // with bounded pattern work/cancellation per invocation.
                    // Do not bill the whole remaining field for every hit.
                    self.scan(p.text.len())?;
                } else {
                    // Arbitrary regex iteration may rescan the remaining
                    // haystack; retain its conservative per-call precharge.
                    self.scan(text.len() - at)?;
                }
                let Some(found) = expression.find_at(text, at) else {
                    break;
                };
                self.charge(0)?;
                if found.is_empty() {
                    if found.end() == text.len() {
                        break;
                    }
                    at = found.end() + text[found.end()..].chars().next().unwrap().len_utf8();
                    continue;
                }
                at = found.end();
                self.charge(1)?;
                let (start, end) = (found.start(), found.end());
                if p.quoted && matches!(field, Field::Content) {
                    let first = p.text.chars().next().unwrap();
                    let last = p.text.chars().next_back().unwrap();
                    if self.is_word(first)
                        && text[..start]
                            .chars()
                            .next_back()
                            .is_some_and(|c| self.is_word(c))
                    {
                        continue;
                    }
                    if self.is_word(last)
                        && text[end..].chars().next().is_some_and(|c| self.is_word(c))
                    {
                        continue;
                    }
                }
                self.output(1, 32)?;
                let base = if matches!(field, Field::Content) {
                    c.base
                } else {
                    0
                };
                spans.push((start + base, end + base));
            }
            self.charge(0)?;
            match field {
                Field::Content => out.content.extend(spans),
                Field::Filename => out.filename.extend(spans),
                Field::Filepath => out.filepath.extend(spans),
                Field::Key => out.key.extend(spans),
            }
        }
        Ok(if out.present() {
            Outcome::Yes(out)
        } else {
            Outcome::No
        })
    }
    fn is_word(&self, c: char) -> bool {
        let mut bytes = [0; 4];
        self.query.word.is_match(c.encode_utf8(&mut bytes))
    }
    fn property(
        &mut self,
        key: &Node,
        value: Option<&Node>,
        c: &Context<'_>,
    ) -> Result<Outcome, SearchError<E>> {
        let Some(metadata) = self.metadata() else {
            return Ok(Outcome::No);
        };
        let mut out = Raw::default();
        for property in &metadata.properties {
            self.scan(property.key.len())?;
            let mut key_context = c.clone();
            key_context.active = vec![Field::Key];
            key_context.key = Some(&property.key);
            if !matches!(self.eval(key, &key_context)?, Outcome::Yes(_)) {
                continue;
            }
            let Some(value_node) = value else {
                self.output(1, property.key.len() + 32)?;
                out.properties.push(SearchPropertyMatch {
                    key: property.key.clone(),
                    array_path: vec![],
                    value: None,
                });
                continue;
            };
            let items = match &property.value {
                PropertyValue::Array(items) => items.as_slice(),
                value => std::slice::from_ref(value),
            };
            for (i, item) in items.iter().enumerate() {
                self.charge(1)?;
                let text = render(item, 0, self)?;
                let context = Context {
                    text: &text,
                    base: 0,
                    active: vec![Field::Content],
                    sensitive: c.sensitive,
                    typed: Some(item),
                    key: None,
                    section: c.section,
                };
                if let Outcome::Yes(found) = self.eval(value_node, &context)? {
                    // Exclusion-only success has no value location, as in the
                    // accepted typed-property contract; do not invent one.
                    if found.content.is_empty() {
                        continue;
                    }
                    let spans = self.normalize(found.content)?;
                    self.scan(text.len())?;
                    if spans.iter().any(|s| s.1 > text.len()) {
                        return Err(SearchError::InvalidDocument(
                            "Property range exceeds rendered value",
                        ));
                    }
                    let ranges = coordinates(&text, &spans)?;
                    self.output(1, property.key.len() + text.len() + 64)?;
                    out.properties.push(SearchPropertyMatch {
                        key: property.key.clone(),
                        array_path: if matches!(property.value, PropertyValue::Array(_)) {
                            vec![i as u32]
                        } else {
                            vec![]
                        },
                        value: Some(SearchPropertyValueMatch { text, ranges }),
                    });
                }
            }
        }
        Ok(if out.present() {
            Outcome::Yes(out)
        } else {
            Outcome::No
        })
    }
    fn scoped(
        &mut self,
        scope: Scope,
        child: &Node,
        c: &Context<'_>,
    ) -> Result<Outcome, SearchError<E>> {
        match scope {
            Scope::Sensitive | Scope::Insensitive => {
                let mut context = c.clone();
                context.sensitive = scope == Scope::Sensitive;
                self.eval(child, &context)
            }
            Scope::File | Scope::Path | Scope::Content => {
                if scope == Scope::Content && matches!(self.document.source, SearchSource::NotText)
                {
                    return Ok(Outcome::No);
                }
                let mut context = c.clone();
                context.active = vec![match scope {
                    Scope::File => Field::Filename,
                    Scope::Path => Field::Filepath,
                    _ => Field::Content,
                }];
                self.eval(child, &context)
            }
            Scope::Tag => self.tag(child),
            Scope::Line => {
                if self.source().is_none() {
                    return Ok(Outcome::No);
                }
                let source = self.source().unwrap();
                self.scan(source.len())?;
                let mut ranges = Vec::new();
                let mut start = 0;
                for (i, b) in source.bytes().enumerate() {
                    if b == b'\n' {
                        self.charge(1)?;
                        if ranges.len() >= 100_000 {
                            return Err(SearchError::Resource("Search segment limit"));
                        }
                        ranges.push((start, i, None));
                        start = i + 1;
                    }
                }
                self.charge(1)?;
                ranges.push((start, source.len(), None));
                self.segments(child, c, ranges, false)
            }
            Scope::Block => {
                let Some(m) = self.metadata() else {
                    return Ok(Outcome::No);
                };
                let mut ranges = Vec::new();
                for range in m
                    .blocks
                    .iter()
                    .map(|b| &b.range)
                    .chain(m.list_items.iter().map(|i| &i.range))
                {
                    self.checked_range(range)?;
                    ranges.push((range.bytes[0] as usize, range.bytes[1] as usize, None));
                }
                self.segments(child, c, ranges, false)
            }
            Scope::Task | Scope::Todo | Scope::Done => {
                let Some(m) = self.metadata() else {
                    return Ok(Outcome::No);
                };
                let mut ranges = Vec::new();
                for item in &m.list_items {
                    self.checked_range(&item.range)?;
                    if let Some(status) = &item.task_status {
                        if scope == Scope::Task || (scope == Scope::Todo) == (status == " ") {
                            ranges.push((
                                item.range.bytes[0] as usize,
                                item.range.bytes[1] as usize,
                                None,
                            ));
                        }
                    }
                }
                self.segments(
                    child,
                    c,
                    ranges,
                    matches!(child,Node::Pattern(p) if p.quoted&&p.text.is_empty()),
                )
            }
            Scope::Section => {
                if self.metadata().is_none() {
                    return Ok(Outcome::No);
                }
                self.prepare_headings()?;
                let headings = self.headings.as_ref().unwrap();
                let (start, end) = c
                    .section
                    .map_or((0, headings.len()), |i| (i + 1, headings[i].descendant_end));
                let mut ranges = Vec::new();
                for (i, h) in headings.iter().enumerate().take(end).skip(start) {
                    ranges.push((h.start, h.end, Some(i)));
                }
                self.charge(ranges.len())?;
                self.segments(child, c, ranges, false)
            }
        }
    }
    fn segments(
        &mut self,
        node: &Node,
        c: &Context<'_>,
        ranges: Vec<(usize, usize, Option<usize>)>,
        all: bool,
    ) -> Result<Outcome, SearchError<E>> {
        let Some(source) = self.source() else {
            return Ok(Outcome::No);
        };
        let mut out = None;
        let mut unavailable = false;
        for (start, end, section) in ranges {
            self.charge(1)?;
            let text = source
                .get(start..end)
                .ok_or(SearchError::InvalidDocument("Invalid parser segment range"))?;
            let context = Context {
                text,
                base: start,
                active: vec![Field::Content],
                sensitive: c.sensitive,
                typed: c.typed,
                key: c.key,
                section: section.or(c.section),
            };
            let found = if all {
                self.output(1, 32)?;
                Outcome::Yes(Raw {
                    anchors: vec![(start, start)],
                    ..Raw::default()
                })
            } else {
                self.eval(node, &context)?
            };
            match found {
                Outcome::Yes(mut found) => {
                    if found.content.is_empty() && found.anchors.is_empty() {
                        self.output(1, 32)?;
                        found.anchors.push((start, start));
                    }
                    // Scoped sections produce only source locations, preserving
                    // the accepted scope result rather than leaking names.
                    let source_only = Raw {
                        content: found.content,
                        anchors: found.anchors,
                        ..Raw::default()
                    };
                    out.get_or_insert_with(Raw::default).merge(source_only);
                }
                Outcome::Inapplicable => unavailable = true,
                Outcome::No => {}
            }
        }
        Ok(if let Some(out) = out {
            Outcome::Yes(out)
        } else if unavailable {
            Outcome::Inapplicable
        } else {
            Outcome::No
        })
    }
    fn prepare_headings(&mut self) -> Result<(), SearchError<E>> {
        if self.headings.is_some() {
            return Ok(());
        }
        let Some(source) = self.source() else {
            return Ok(());
        };
        let m = self.metadata().unwrap();
        let mut headings: Vec<HeadingInterval> = Vec::new();
        let mut ancestors: Vec<usize> = Vec::new();
        for (i, h) in m.headings.iter().enumerate() {
            self.charge(1)?;
            self.checked_range(&h.range)?;
            let start = h.range.bytes[0] as usize;
            if !source.is_char_boundary(start)
                || start > source.len()
                || i > 0 && start < m.headings[i - 1].range.bytes[0] as usize
            {
                return Err(SearchError::InvalidDocument("Invalid heading interval"));
            }
            while ancestors
                .last()
                .is_some_and(|&j| m.headings[j].level >= h.level)
            {
                self.charge(1)?;
                let j = ancestors.pop().unwrap();
                headings[j].descendant_end = i;
            }
            headings.push(HeadingInterval {
                start,
                end: m
                    .headings
                    .get(i + 1)
                    .map_or(source.len(), |h| h.range.bytes[0] as usize),
                descendant_end: m.headings.len(),
            });
            ancestors.push(i);
        }
        if headings.is_empty() {
            self.charge(1)?;
            headings.push(HeadingInterval {
                start: 0,
                end: source.len(),
                descendant_end: 1,
            });
        }
        if headings.first().is_some_and(|h| h.start > 0) {
            self.charge(headings.len() + 1)?;
            for h in &mut headings {
                h.descendant_end += 1;
            }
            headings.insert(
                0,
                HeadingInterval {
                    start: 0,
                    end: headings[0].start,
                    descendant_end: 1,
                },
            );
        }
        self.headings = Some(headings);
        Ok(())
    }
    fn tag(&mut self, child: &Node) -> Result<Outcome, SearchError<E>> {
        let Node::Pattern(p) = child else {
            return Ok(Outcome::No);
        };
        let Some(metadata) = self.metadata() else {
            return Ok(Outcome::No);
        };
        self.scan(p.text.len())?;
        let target = p.text.strip_prefix('#').unwrap_or(&p.text).to_lowercase();
        let mut out = Raw::default();
        for tag in &metadata.tag_occurrences {
            self.scan(tag.name.len())?;
            self.checked_range(&tag.range)?;
            if accepts_tag(&tag.name, &target) {
                self.output(1, tag.name.len() + 48)?;
                out.tags.push(SearchTagMatch {
                    name: tag.name.clone(),
                    source_range: Some(tag.range.clone()),
                });
            }
        }
        // Aggregate metadata.tags combines inline and frontmatter values.
        // Only the original occurrence or typed property supplies provenance;
        // never duplicate that aggregate as an invented source location.
        let mut tag_property = None;
        for property in &metadata.properties {
            self.scan(property.key.len())?;
            if property.key.to_lowercase() == "tags" {
                tag_property = Some(property);
                break;
            }
        }
        if let Some(property) = tag_property {
            self.scan(property.key.len())?;
            let values = match &property.value {
                PropertyValue::Array(v) => v.as_slice(),
                v => std::slice::from_ref(v),
            };
            for value in values {
                self.charge(1)?;
                if let PropertyValue::String(s) = value {
                    self.scan(s.len())?;
                    let s = s.trim_matches(js_whitespace);
                    if !s.is_empty() && !s.contains(' ') && accepts_tag(s, &target) {
                        self.output(1, property.key.len() + 32)?;
                        out.properties.push(SearchPropertyMatch {
                            key: property.key.clone(),
                            array_path: vec![],
                            value: None,
                        });
                        break;
                    }
                }
            }
        }
        Ok(if out.present() {
            Outcome::Yes(out)
        } else {
            Outcome::No
        })
    }
}
fn accepts_tag(name: &str, target: &str) -> bool {
    let n = name.strip_prefix('#').unwrap_or(name).to_lowercase();
    n == target || n.strip_prefix(target).is_some_and(|s| s.starts_with('/'))
}
// ECMAScript StringNumericLiteral conversion used by the accepted search
// comparisons. Rust's float parser alone accepts extra inf spellings, and a
// u64 radix intermediate would silently reject valid larger numeric operands.
fn js_number(s: &str) -> f64 {
    let s = s.trim_matches(js_whitespace);
    if s.is_empty() {
        return 0.0;
    }
    if s == "Infinity" || s == "+Infinity" {
        return f64::INFINITY;
    }
    if s == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    for (prefix, bits) in [
        ("0x", 4),
        ("0X", 4),
        ("0b", 1),
        ("0B", 1),
        ("0o", 3),
        ("0O", 3),
    ] {
        if let Some(digits) = s.strip_prefix(prefix) {
            return radix_number(digits, bits);
        }
    }
    let b = s.as_bytes();
    let mut at = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let mut digits = 0;
    while b.get(at).is_some_and(u8::is_ascii_digit) {
        at += 1;
        digits += 1;
    }
    if b.get(at) == Some(&b'.') {
        at += 1;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if matches!(b.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(b.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let start = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return f64::NAN;
        }
    }
    if at != b.len() {
        return f64::NAN;
    }
    s.parse().unwrap_or(f64::NAN)
}
fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn radix_number(s: &str, bits: usize) -> f64 {
    let radix = 1u32 << bits;
    if s.is_empty()
        || !s
            .chars()
            .all(|c| c.is_ascii() && c.to_digit(radix).is_some())
    {
        return f64::NAN;
    }
    let s = s.trim_start_matches('0');
    if s.is_empty() {
        return 0.0;
    }
    let first = s.chars().next().unwrap().to_digit(radix).unwrap();
    let significant = (u32::BITS - first.leading_zeros()) as usize;
    let bit_len = (s.len() - 1) * bits + significant;
    if bit_len > 1024 {
        return f64::INFINITY;
    }
    let mut mantissa = 0u64;
    let mut seen = 0;
    let mut guard = false;
    let mut sticky = false;
    for (i, c) in s.chars().enumerate() {
        let value = c.to_digit(radix).unwrap();
        let width = if i == 0 { significant } else { bits };
        for shift in (0..width).rev() {
            let one = (value >> shift) & 1 != 0;
            if seen < 53 {
                mantissa = (mantissa << 1) | u64::from(one);
            } else if seen == 53 {
                guard = one;
            } else {
                sticky |= one;
            }
            seen += 1;
        }
    }
    if bit_len <= 53 {
        return mantissa as f64;
    }
    if guard && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    (mantissa as f64) * 2f64.powi((bit_len - 53) as i32)
}

fn render<F, E>(
    value: &PropertyValue,
    depth: usize,
    e: &mut Evaluator<'_, '_, F>,
) -> Result<String, SearchError<E>>
where
    F: FnMut(usize) -> Result<(), E>,
{
    e.charge(1)?;
    if depth > 64 {
        return Err(SearchError::Resource("Property rendering depth"));
    }
    let text = match value {
        PropertyValue::Null => "null".into(),
        PropertyValue::Bool(b) => b.to_string(),
        PropertyValue::Number(n) => number_text(n),
        PropertyValue::String(s) => {
            e.scan(s.len())?;
            if s.len() > e.query.limits.output_bytes {
                return Err(SearchError::Resource("Property rendering size"));
            }
            s.clone()
        }
        PropertyValue::Object(_) => "[object Object]".into(),
        PropertyValue::Array(values) => {
            let mut out = String::new();
            for (i, value) in values.iter().enumerate() {
                e.charge(1)?;
                let text = if matches!(value, PropertyValue::Null) {
                    String::new()
                } else {
                    render(value, depth + 1, e)?
                };
                let len = out
                    .len()
                    .saturating_add(text.len())
                    .saturating_add(usize::from(i > 0));
                if len > e.query.limits.output_bytes {
                    return Err(SearchError::Resource("Property rendering size"));
                }
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&text);
            }
            out
        }
    };
    Ok(text)
}
fn normalize(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_unstable();
    let mut result: Vec<Span> = Vec::new();
    for span in spans {
        if let Some(last) = result.last_mut() {
            if last.1 >= span.0 {
                last.1 = last.1.max(span.1);
                continue;
            }
        }
        result.push(span);
    }
    result
}
/// Sorted disjoint spans allow a single monotonic Unicode coordinate pass.
fn coordinates<E>(text: &str, spans: &[Span]) -> Result<Vec<SourceRange>, SearchError<E>> {
    let mut out = Vec::new();
    let mut byte = 0;
    let mut utf16 = 0;
    for &(start, end) in spans {
        if start < byte
            || end < start
            || end > text.len()
            || !text.is_char_boundary(start)
            || !text.is_char_boundary(end)
        {
            return Err(SearchError::InvalidDocument("Invalid search range"));
        }
        utf16 += text[byte..start].encode_utf16().count();
        let ustart = utf16;
        utf16 += text[start..end].encode_utf16().count();
        byte = end;
        out.push(SourceRange {
            bytes: [start as u32, end as u32],
            utf16: [ustart as u32, utf16 as u32],
        });
    }
    Ok(out)
}
pub(super) fn evaluate<F, E>(
    q: &CompiledSearchQuery,
    document: SearchDocument<'_>,
    check: F,
) -> Result<SearchEvaluation, SearchError<E>>
where
    F: FnMut(usize) -> Result<(), E>,
{
    let filename = document.path.rsplit('/').next().unwrap_or(document.path);
    let extension = filename.rsplit_once('.').map_or(filename, |(_, e)| e);
    let source = match document.source {
        SearchSource::Text(s) => Some(s),
        _ => None,
    };
    let metadata = match document.metadata {
        SearchMetadataInput::Present(m) => Some(m),
        _ => None,
    };
    let mut e = Evaluator {
        document,
        filename,
        query: q,
        check,
        work: 0,
        spans: 0,
        bytes: 0,
        headings: None,
    };
    e.charge(0)?;
    if e.document.path.len() > q.limits.source_bytes
        || source.is_some_and(|s| s.len() > q.limits.source_bytes)
    {
        return Err(SearchError::Resource("Search document size"));
    }
    let Some(ast) = &q.ast else {
        return Ok(SearchEvaluation::NoMatch);
    };
    let missing = SearchRequirements {
        content: q.requirements.content && matches!(e.document.source, SearchSource::Unavailable),
        metadata: q.requirements.metadata
            && matches!(e.document.metadata, SearchMetadataInput::Unavailable),
    };
    if missing.content || missing.metadata {
        return Ok(SearchEvaluation::Unavailable(missing));
    }
    if let Some(m) = metadata.filter(|_| q.requirements.metadata) {
        if m.source_length.bytes as usize > q.limits.source_bytes
            || m.source_length.utf16 > m.source_length.bytes
        {
            return Err(SearchError::InvalidDocument(
                "Invalid metadata source length",
            ));
        }
        if m.schema_version != zorid_document::SCHEMA_VERSION
            || m.dialect_version != zorid_document::DIALECT_VERSION
        {
            return Err(SearchError::InvalidDocument("Unsupported metadata version"));
        }
        if let Some(source) = source {
            e.scan(source.len())?;
            if m.source_length.bytes as usize != source.len()
                || m.source_length.utf16 as usize != source.encode_utf16().count()
            {
                return Err(SearchError::InvalidDocument(
                    "Metadata source length mismatch",
                ));
            }
        }
    }
    let mut active = Vec::new();
    if matches!(extension, "md" | "canvas" | "base") {
        active.push(Field::Filename);
    }
    if extension == "md" && source.is_some() {
        active.push(Field::Content);
    }
    let context = Context {
        text: source.unwrap_or(""),
        base: 0,
        active,
        sensitive: q.options.case_sensitive,
        typed: None,
        key: None,
        section: None,
    };
    let raw = match e.eval(ast, &context)? {
        Outcome::No => return Ok(SearchEvaluation::NoMatch),
        Outcome::Inapplicable => Raw::default(),
        Outcome::Yes(r) => r,
    };
    e.charge(0)?;
    let content = e.normalize(raw.content)?;
    let anchors = e.normalize(raw.anchors)?;
    if !content.is_empty() || !anchors.is_empty() {
        e.scan(source.map_or(0, str::len))?;
    }
    e.charge(content.len().saturating_add(anchors.len()))?;
    let mut result = SearchMatches::default();
    for range in coordinates(source.unwrap_or(""), &content)? {
        result.content.push(SearchContentMatch {
            kind: SearchContentKind::Occurrence,
            range,
        });
    }
    for range in coordinates(source.unwrap_or(""), &anchors)? {
        result.content.push(SearchContentMatch {
            kind: SearchContentKind::Anchor,
            range,
        });
    }
    e.charge(sort_work(result.content.len()))?;
    result
        .content
        .sort_by_key(|r| (r.range.bytes[0], r.range.bytes[1]));
    for (text, spans, target) in [
        (filename, raw.filename, &mut result.filename),
        (e.document.path, raw.filepath, &mut result.filepath),
    ] {
        if !spans.is_empty() {
            e.scan(text.len())?;
            e.output(0, text.len())?;
            *target = Some(SearchFieldMatches {
                value: text.into(),
                ranges: coordinates(text, &e.normalize(spans)?)?,
            });
        }
    }
    result.properties = raw.properties;
    result.tags = raw.tags;
    // Final bounded serialization accounts for key escaping/locator overhead,
    // separately from the conservative allocation counters above.
    let mut encoded = SizeWriter {
        bytes: 0,
        maximum: q.limits.output_bytes,
    };
    serde_json::to_writer(&mut encoded, &result)
        .map_err(|_| SearchError::Resource("Search encoded output limit"))?;
    e.scan(encoded.bytes)?;
    Ok(SearchEvaluation::Match(result))
}

struct SizeWriter {
    bytes: usize,
    maximum: usize,
}
impl std::io::Write for SizeWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .filter(|n| *n <= self.maximum)
            .ok_or_else(|| std::io::Error::other("Search output limit"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn number_text(n: &serde_json::Number) -> String {
    if let Some(n) = n.as_i64() {
        return n.to_string();
    }
    if let Some(n) = n.as_u64() {
        return n.to_string();
    }
    let n = n.as_f64().expect("finite property number");
    if n == 0.0 {
        return "0".into();
    }
    if n.abs() >= 1e21 || n.abs() < 1e-6 {
        let text = format!("{n:e}");
        if let Some((mantissa, exponent)) = text.split_once('e') {
            let exponent: i32 = exponent.parse().expect("formatted exponent");
            return format!("{mantissa}e{exponent:+}");
        }
        text
    } else {
        n.to_string()
    }
}

fn sort_work(n: usize) -> usize {
    n.saturating_mul(if n < 2 {
        0
    } else {
        usize::BITS as usize - (n - 1).leading_zeros() as usize
    })
}
