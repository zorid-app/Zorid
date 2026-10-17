use crate::positions::{after_line, line_end, Positions};
use crate::*;
use regex::Regex;
use saphyr_parser::{Event, Parser, ScalarStyle, Span, Tag};
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::sync::OnceLock;

fn delimiter(line: &str, marker: &str) -> bool {
    line.strip_prefix(marker).is_some_and(|tail| {
        let tail = tail.trim_start_matches([' ', '\t']);
        tail.is_empty() || tail.starts_with('#')
    })
}

pub(crate) fn extract(source: &str, positions: &Positions<'_>, result: &mut DocumentMetadata) {
    let start = if source.starts_with('\u{feff}') { 3 } else { 0 };
    let opening_end = line_end(source, start);
    if !delimiter(&source[start..opening_end], "---") {
        return;
    }
    let yaml_start = after_line(source, opening_end);
    let mut cursor = yaml_start;
    let mut closing = None;
    while cursor < source.len() {
        let end = line_end(source, cursor);
        if delimiter(&source[cursor..end], "---") || delimiter(&source[cursor..end], "...") {
            closing = Some((cursor, after_line(source, end)));
            break;
        }
        cursor = after_line(source, end);
    }
    let Some((yaml_end, body_start)) = closing else {
        let range = positions.range(0..yaml_start);
        result.frontmatter.state = FrontmatterState::Unclosed;
        result.frontmatter.range = Some(range.clone());
        result.diagnostics.push(Diagnostic {
            code: DiagnosticCode::FrontmatterUnclosed,
            severity: Severity::Error,
            range,
        });
        return;
    };
    let range = positions.range(0..body_start);
    result.frontmatter = Frontmatter {
        state: FrontmatterState::Valid,
        range: Some(range.clone()),
        body_start: positions.point(body_start),
    };
    let values = if body_start > MAX_FRONTMATTER_BYTES {
        Err(DiagnosticCode::FrontmatterResource)
    } else {
        decode(&source[yaml_start..yaml_end], yaml_start, positions)
    };
    match values {
        Ok(properties) => {
            result.properties = properties;
            projections(result);
        }
        Err(code) => {
            result.frontmatter.state = FrontmatterState::Invalid;
            result.diagnostics.push(Diagnostic {
                code,
                severity: Severity::Error,
                range,
            });
        }
    }
}

#[derive(Debug)]
enum Kind {
    Scalar(String, ScalarStyle, Option<Tag>),
    Sequence(Vec<usize>, Option<Tag>),
    Mapping(Vec<(usize, usize)>, Option<Tag>),
    Alias(usize),
}
#[derive(Debug)]
struct Node {
    kind: Kind,
    span: Range<usize>,
}
struct Frame {
    node: usize,
    pending_key: Option<usize>,
}
struct Tree {
    nodes: Vec<Node>,
    root: Option<usize>,
}

fn syntax(error: &saphyr_parser::ScanError) -> DiagnosticCode {
    // Stable public codes, pinned dependency-specific recognition kept here.
    if error.info() == "while parsing node, found unknown anchor" {
        DiagnosticCode::FrontmatterAlias
    } else {
        DiagnosticCode::FrontmatterSyntax
    }
}
fn event_tree(source: &str) -> Result<Tree, DiagnosticCode> {
    let mut tree = Tree {
        nodes: Vec::new(),
        root: None,
    };
    let mut stack: Vec<Frame> = Vec::new();
    let mut anchors = HashMap::new();
    let mut documents = 0;
    for event in Parser::new_from_str(source) {
        let (event, span) = event.map_err(|error| syntax(&error))?;
        let (kind, anchor, opens) = match event {
            Event::Scalar(text, style, anchor, tag) => (
                Kind::Scalar(text.into_owned(), style, tag.map(|tag| tag.into_owned())),
                anchor,
                false,
            ),
            Event::SequenceStart(anchor, tag) => (
                Kind::Sequence(Vec::new(), tag.map(|tag| tag.into_owned())),
                anchor,
                true,
            ),
            Event::MappingStart(anchor, tag) => (
                Kind::Mapping(Vec::new(), tag.map(|tag| tag.into_owned())),
                anchor,
                true,
            ),
            Event::Alias(anchor) => (
                Kind::Alias(
                    *anchors
                        .get(&anchor)
                        .ok_or(DiagnosticCode::FrontmatterAlias)?,
                ),
                0,
                false,
            ),
            Event::SequenceEnd | Event::MappingEnd => {
                let frame = stack.pop().ok_or(DiagnosticCode::FrontmatterSyntax)?;
                if frame.pending_key.is_some() {
                    return Err(DiagnosticCode::FrontmatterSyntax);
                }
                tree.nodes[frame.node].span.end = span.end.index();
                continue;
            }
            Event::DocumentStart(_) => {
                documents += 1;
                if documents > 1 {
                    return Err(DiagnosticCode::FrontmatterSyntax);
                }
                continue;
            }
            Event::DocumentEnd | Event::StreamStart | Event::StreamEnd | Event::Nothing => continue,
        };
        // Keys may double the number of value nodes. Stop before allocation.
        if tree.nodes.len() >= MAX_VALUE_NODES * 2 || stack.len() > MAX_YAML_DEPTH + 1 {
            return Err(DiagnosticCode::FrontmatterResource);
        }
        let node = tree.nodes.len();
        tree.nodes.push(Node {
            kind,
            span: span.start.index()..span.end.index(),
        });
        if anchor != 0 {
            anchors.insert(anchor, node);
        }
        if let Some(frame) = stack.last_mut() {
            match &mut tree.nodes[frame.node].kind {
                Kind::Sequence(items, _) => items.push(node),
                Kind::Mapping(items, _) => {
                    if let Some(key) = frame.pending_key.take() {
                        items.push((key, node));
                    } else {
                        frame.pending_key = Some(node);
                    }
                }
                _ => return Err(DiagnosticCode::FrontmatterSyntax),
            }
        } else if tree.root.replace(node).is_some() {
            return Err(DiagnosticCode::FrontmatterSyntax);
        }
        if opens {
            stack.push(Frame {
                node,
                pending_key: None,
            });
        }
    }
    if !stack.is_empty() {
        return Err(DiagnosticCode::FrontmatterSyntax);
    }
    Ok(tree)
}

struct Decoder<'a> {
    tree: &'a Tree,
    active: HashSet<usize>,
    nodes: usize,
    alias_nodes: usize,
    issues: Vec<DiagnosticCode>,
}
impl Decoder<'_> {
    fn issue(&mut self, issue: DiagnosticCode) {
        if !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }
    fn key(&mut self, index: usize) -> String {
        match &self.tree.nodes[index].kind {
            Kind::Scalar(text, _, tag) => {
                if tag.as_ref().is_some_and(|tag| !supported_tag(tag)) {
                    self.issue(DiagnosticCode::FrontmatterTag);
                }
                if text.trim().is_empty() || text.chars().any(|ch| ch <= '\u{1f}' || ch == '\u{7f}')
                {
                    self.issue(DiagnosticCode::FrontmatterValue);
                }
                text.clone()
            }
            _ => {
                self.issue(DiagnosticCode::FrontmatterValue);
                String::new()
            }
        }
    }
    fn value(
        &mut self,
        index: usize,
        depth: usize,
        alias: bool,
    ) -> Result<PropertyValue, DiagnosticCode> {
        if depth > MAX_YAML_DEPTH
            || self.nodes >= MAX_VALUE_NODES
            || alias && self.alias_nodes >= MAX_ALIAS_NODES
        {
            return Err(DiagnosticCode::FrontmatterResource);
        }
        if !self.active.insert(index) {
            self.issue(DiagnosticCode::FrontmatterAlias);
            return Ok(PropertyValue::Null);
        }
        if let Kind::Alias(target) = self.tree.nodes[index].kind {
            let value = self.value(target, depth, true);
            self.active.remove(&index);
            return value;
        }
        self.nodes += 1;
        if alias {
            self.alias_nodes += 1;
        }
        let result = match &self.tree.nodes[index].kind {
            Kind::Scalar(text, style, tag) => match scalar(text, *style, tag.as_ref()) {
                Ok(value) => value,
                Err(code) => {
                    self.issue(code);
                    PropertyValue::Null
                }
            },
            Kind::Sequence(items, tag) => {
                if tag.as_ref().is_some_and(|tag| !core_tag(tag, "seq")) {
                    self.issue(DiagnosticCode::FrontmatterTag);
                }
                let mut values = Vec::new();
                for item in items {
                    values.push(self.value(*item, depth + 1, alias)?);
                }
                PropertyValue::Array(values)
            }
            Kind::Mapping(items, tag) => {
                if tag.as_ref().is_some_and(|tag| !core_tag(tag, "map")) {
                    self.issue(DiagnosticCode::FrontmatterTag);
                }
                let mut values = Vec::new();
                let mut keys = HashSet::new();
                for (key, value) in items {
                    let key = self.key(*key);
                    if !keys.insert(key.clone()) {
                        self.issue(DiagnosticCode::FrontmatterDuplicateKey);
                    }
                    values.push((key, self.value(*value, depth + 1, alias)?));
                }
                PropertyValue::Object(values)
            }
            Kind::Alias(_) => unreachable!(),
        };
        self.active.remove(&index);
        Ok(result)
    }
}
fn priority(code: &DiagnosticCode) -> u8 {
    match code {
        DiagnosticCode::FrontmatterResource => 0,
        DiagnosticCode::FrontmatterSyntax => 1,
        DiagnosticCode::FrontmatterDuplicateKey => 2,
        DiagnosticCode::FrontmatterTag => 3,
        DiagnosticCode::FrontmatterAlias => 4,
        DiagnosticCode::FrontmatterMapping => 5,
        _ => 6,
    }
}
fn decode(
    source: &str,
    offset: usize,
    positions: &Positions<'_>,
) -> Result<Vec<Property>, DiagnosticCode> {
    let tree = event_tree(source)?;
    let Some(root) = tree.root else {
        return Ok(Vec::new());
    };
    let mut decoder = Decoder {
        tree: &tree,
        active: HashSet::new(),
        nodes: 0,
        alias_nodes: 0,
        issues: Vec::new(),
    };
    let value = decoder.value(root, 0, false)?;
    let entries = match value {
        PropertyValue::Object(entries) => entries,
        _ if source
            .lines()
            .all(|line| line.trim().is_empty() || line.trim_start().starts_with('#')) =>
        {
            Vec::new()
        }
        _ => {
            decoder.issue(DiagnosticCode::FrontmatterMapping);
            Vec::new()
        }
    };
    if let Some(code) = decoder.issues.into_iter().min_by_key(priority) {
        return Err(code);
    }
    let keys = match &tree.nodes[root].kind {
        Kind::Mapping(entries, _) => entries.iter().map(|entry| entry.0).collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    Ok(entries
        .into_iter()
        .zip(keys)
        .map(|((key, value), index)| {
            let span = &tree.nodes[index].span;
            let property_type = infer(&key, &value);
            Property {
                key,
                value,
                property_type,
                key_range: positions.range(offset + span.start..offset + span.end),
            }
        })
        .collect())
}
fn core_tag(tag: &Tag, name: &str) -> bool {
    tag.is_yaml_core_schema() && tag.suffix == name
}
fn supported_tag(tag: &Tag) -> bool {
    tag.is_yaml_core_schema()
        && matches!(
            tag.suffix.as_str(),
            "str" | "null" | "bool" | "int" | "float" | "seq" | "map"
        )
}

struct Patterns {
    integer: Regex,
    float: Regex,
    nonfinite: Regex,
    date: Regex,
    datetime: Regex,
}
fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    PATTERNS.get_or_init(|| Patterns {
        integer: Regex::new(r"^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$").unwrap(),
        float: Regex::new(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$").unwrap(),
        nonfinite: Regex::new(r"^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$").unwrap(),
        date: Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$").unwrap(),
        datetime: Regex::new(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,9})?)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))?$").unwrap(),
    })
}
fn scalar(
    text: &str,
    style: ScalarStyle,
    tag: Option<&Tag>,
) -> Result<PropertyValue, DiagnosticCode> {
    if tag.is_some_and(|tag| !supported_tag(tag)) {
        return Err(DiagnosticCode::FrontmatterTag);
    }
    if tag.is_some_and(|tag| core_tag(tag, "str")) || tag.is_none() && style != ScalarStyle::Plain {
        return Ok(PropertyValue::String(text.into()));
    }
    let requested = tag.map(|tag| tag.suffix.as_str());
    if matches!(text, "" | "~" | "null" | "Null" | "NULL")
        && requested.is_none_or(|tag| tag == "null")
    {
        return Ok(PropertyValue::Null);
    }
    if matches!(text, "true" | "True" | "TRUE" | "false" | "False" | "FALSE")
        && requested.is_none_or(|tag| tag == "bool")
    {
        return Ok(PropertyValue::Bool(text.eq_ignore_ascii_case("true")));
    }
    let patterns = patterns();
    if patterns.nonfinite.is_match(text) {
        return Err(DiagnosticCode::FrontmatterValue);
    }
    if patterns.integer.is_match(text) && requested.is_none_or(|tag| tag == "int" || tag == "float")
    {
        let integer = if let Some(text) = text.strip_prefix("0x") {
            i128::from_str_radix(text, 16)
        } else if let Some(text) = text.strip_prefix("0o") {
            i128::from_str_radix(text, 8)
        } else {
            text.parse::<i128>()
        }
        .map_err(|_| DiagnosticCode::FrontmatterValue)?;
        if !(-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&integer) {
            return Err(DiagnosticCode::FrontmatterValue);
        }
        return Ok(PropertyValue::Number((integer as i64).into()));
    }
    if patterns.float.is_match(text) && requested.is_none_or(|tag| tag == "float") {
        let float = text
            .parse::<f64>()
            .map_err(|_| DiagnosticCode::FrontmatterValue)?;
        if !float.is_finite() || float.fract() == 0.0 && float.abs() > 9_007_199_254_740_991.0 {
            return Err(DiagnosticCode::FrontmatterValue);
        }
        return Ok(PropertyValue::Number(
            serde_json::Number::from_f64(float).ok_or(DiagnosticCode::FrontmatterValue)?,
        ));
    }
    if requested.is_some() {
        return Err(DiagnosticCode::FrontmatterValue);
    }
    Ok(PropertyValue::String(text.into()))
}
fn valid_date(value: &str) -> bool {
    if !patterns().date.is_match(value) {
        return false;
    }
    let year: u32 = value[0..4].parse().unwrap();
    let month: u32 = value[5..7].parse().unwrap();
    let day: u32 = value[8..10].parse().unwrap();
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    day >= 1 && day <= days
}
fn valid_datetime(value: &str) -> bool {
    let Some(captures) = patterns().datetime.captures(value) else {
        return false;
    };
    let bounded = |index, maximum| {
        captures
            .get(index)
            .is_none_or(|value| value.as_str().parse::<u32>().unwrap() < maximum)
    };
    valid_date(&captures[1])
        && bounded(2, 24)
        && bounded(3, 60)
        && bounded(4, 60)
        && bounded(6, 24)
        && bounded(7, 60)
}
fn infer(key: &str, value: &PropertyValue) -> PropertyType {
    if key.eq_ignore_ascii_case("tags")
        && (matches!(value, PropertyValue::String(_))
            || value.as_array().is_some_and(|items| {
                items
                    .iter()
                    .all(|value| matches!(value, PropertyValue::String(_)))
            }))
    {
        return PropertyType::Tags;
    }
    match value {
        PropertyValue::Bool(_) => PropertyType::Checkbox,
        PropertyValue::Number(_) => PropertyType::Number,
        PropertyValue::String(value) if valid_date(value) => PropertyType::Date,
        PropertyValue::String(value) if valid_datetime(value) => PropertyType::Datetime,
        PropertyValue::String(_) => PropertyType::Text,
        PropertyValue::Array(values)
            if values
                .iter()
                .all(|value| matches!(value, PropertyValue::String(_))) =>
        {
            PropertyType::List
        }
        _ => PropertyType::Unknown,
    }
}
fn projections(result: &mut DocumentMetadata) {
    let selected = |plural: &str, singular: &str| {
        result
            .properties
            .iter()
            .position(|property| {
                property.key == plural && !matches!(property.value, PropertyValue::Null)
            })
            .or_else(|| {
                result
                    .properties
                    .iter()
                    .position(|property| property.key == singular)
            })
    };
    let aliases = selected("aliases", "alias");
    let tags = selected("tags", "tag");
    for (index, property) in result.properties.iter().enumerate() {
        if Some(index) != aliases && Some(index) != tags {
            continue;
        }
        let (values, warning) = match &property.value {
            PropertyValue::String(text) => (
                text.split(',')
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
                false,
            ),
            PropertyValue::Array(values) => (
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect(),
                values.iter().any(|value| value.as_str().is_none()),
            ),
            _ => (Vec::new(), true),
        };
        if warning {
            result.diagnostics.push(Diagnostic {
                code: DiagnosticCode::ProjectionNonString,
                severity: Severity::Warning,
                range: property.key_range.clone(),
            });
        }
        if Some(index) == aliases {
            result.aliases = values.clone();
        }
        if Some(index) == tags {
            for value in values {
                let value = value.strip_prefix('#').unwrap_or(&value).to_string();
                if !result.tags.contains(&value) {
                    result.tags.push(value);
                }
            }
        }
    }
}
