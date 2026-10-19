use crate::phases::{AllocationBudget, AllocationKind, ParseFactsJobError};
use crate::positions::{blank, line_end, trim_final_newline, Positions};
use crate::*;
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag, TagEnd};
use regex::Regex;
use std::collections::HashSet;
use std::ops::Range;
use std::sync::OnceLock;

fn options() -> Options {
    Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_WIKILINKS
}
fn excluded(source: &str, budget: &mut AllocationBudget) -> Result<Vec<Range<usize>>, ParseFactsJobError> {
    let mut ranges = Vec::new();
    for (event, range) in Parser::new_ext(source, options()).into_offset_iter() {
        if matches!(event, Event::Start(Tag::CodeBlock(_)) | Event::Code(_) | Event::Html(_) | Event::InlineHtml(_)) {
            budget.reserve_vec(&mut ranges, 1, AllocationKind::Scratch)?;
            ranges.push(range);
        }
    }
    Ok(ranges)
}
fn comments(masked: &mut [u8], exclusion: &[Range<usize>], budget: &mut AllocationBudget) -> Result<(), ParseFactsJobError> {
    // Search only text that is not already parser-owned code/HTML. A comment
    // marker in a code fence must not consume unrelated later note content.
    let mut searchable = budget.bytes(masked, AllocationKind::Scratch)?;
    for range in exclusion {
        blank(&mut searchable, range.clone());
    }
    let searchable = String::from_utf8(searchable).expect("scalar-aligned parser exclusions");
    let mut cursor = 0;
    while let Some(offset) = searchable[cursor..].find("%%") {
        let start = cursor + offset;
        let Some(end) = searchable[start + 2..].find("%%") else {
            break;
        };
        cursor = start + 2 + end + 2;
        blank(masked, start..cursor);
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Phases {
    parsing: String,
    visible: Vec<u8>,
    repairs: Vec<WikiRepair>,
}
impl Phases {
    pub(crate) fn owned_bytes(&self) -> usize {
        self.parsing.capacity() + self.visible.capacity()
        + self.repairs.capacity() * std::mem::size_of::<WikiRepair>()
        + self.repairs.iter().map(|r| r.label.capacity()).sum::<usize>()
    }
    pub(crate) fn initial(&mut self, source: &str, result: &ParseFacts, budget: &mut AllocationBudget) -> Result<(), ParseFactsJobError> {
    let mut bytes = budget.bytes(source.as_bytes(), AllocationKind::Scratch)?;
    if source.starts_with('\u{feff}') {
        // Byte-length-preserving semantic document prefix, not indentation.
        // Three spaces would turn a valid 1–3-space ATX line into code.
        bytes[..3].fill(b'\n');
    }
    if matches!(
        result.frontmatter.state,
        FrontmatterState::Valid | FrontmatterState::Invalid
    ) {
        blank(&mut bytes, 0..result.frontmatter.body_start.byte as usize);
    }
    let first = std::str::from_utf8(&bytes).expect("whole-source masks");
    let initial_exclusions = excluded(first, budget)?;
    comments(&mut bytes, &initial_exclusions, budget)?;
    self.parsing = String::from_utf8(bytes).expect("scalar-aligned masks");
        Ok(())
    }
    pub(crate) fn repairs(&mut self, budget: &mut AllocationBudget) -> Result<(), ParseFactsJobError> {
        self.repairs = wiki_repairs(&self.parsing, budget)?;
        Ok(())
    }
    pub(crate) fn protect(&mut self, source: &str, positions: &Positions<'_>, result: &mut ParseFacts, budget: &mut AllocationBudget) -> Result<(), ParseFactsJobError> {
    let mut protected = std::mem::take(&mut self.parsing).into_bytes();
    // A confirmed OFM wiki embed is opaque to the ordinary image grammar. An
    // escaped opener preserves block indentation and byte positions while the
    // validated atom supplies its own link and heading-label semantics.
    for repair in &self.repairs {
        protected[repair.range.start] = b'\\';
    }
    self.parsing = String::from_utf8(protected).expect("ASCII opener protection");
    let parsing = &self.parsing;
    let mut visible = budget.bytes(parsing.as_bytes(), AllocationKind::Scratch)?;
    for repair in &self.repairs {
        let destination_range = wiki_destination(source, repair.range.clone(), true).unwrap();
        blank(&mut visible, destination_range.clone());
        let raw = &source[destination_range.clone()];
        let split = raw.find('#').unwrap_or(raw.len());
        budget.reserve_vec(&mut result.links, 1, AllocationKind::Facts)?;
        result.links.push(Link {
            kind: LinkKind::Wiki,
            embed: true,
            target: budget.string(&raw[..split], AllocationKind::Facts)?,
            fragment: budget.string(&raw[split..], AllocationKind::Facts)?,
            destination: budget.string(raw, AllocationKind::Facts)?,
            range: positions.range(repair.range.clone()),
            target_range: positions.range(destination_range.start..destination_range.start + split),
            definition_range: None,
        });
    }
    for range in excluded(parsing, budget)? {
        blank(&mut visible, range);
    }
    self.visible = visible;
        Ok(())
    }
    pub(crate) fn semantics(&mut self, source: &str, positions: &Positions<'_>, result: &mut ParseFacts, budget: &mut AllocationBudget) -> Result<(), ParseFactsJobError> {
    let parsing = &self.parsing;
    let visible = &mut self.visible;
    let repairs = &mut self.repairs;
    let mut iterator = Parser::new_ext(&parsing, options()).into_offset_iter();
    for (_, definition) in iterator.reference_definitions().iter() {
        blank(visible, definition.span.clone());
    }
    let mut current_heading: Option<Heading> = None;
    let mut block_depth = 0usize;
    let mut list_depth = 0usize;
    while let Some((event, range)) = iterator.next() {
        // Start offsets already cover the entire parser-owned block/item.
        // All masks preserve byte positions; coordinates refer to original input.
        if let Event::Start(tag) = &event {
            if matches!(tag, Tag::List(_)) {
                list_depth += 1;
            }
            if let Some(kind) = block_kind(tag) {
                if block_depth == 0 && list_depth == 0 {
                    budget.reserve_vec(&mut result.blocks, 1, AllocationKind::Facts)?;
                    result.blocks.push(MarkdownBlock {
                        kind,
                        range: positions.range(trim_final_newline(source, range.clone())),
                    });
                }
                block_depth += 1;
            }
        } else if let Event::End(tag) = &event {
            if matches!(tag, TagEnd::List(_)) {
                list_depth -= 1;
            }
            if block_end(tag) {
                block_depth -= 1;
            }
        } else if matches!(&event, Event::Rule) && block_depth == 0 && list_depth == 0 {
            budget.reserve_vec(&mut result.blocks, 1, AllocationKind::Facts)?;
                    result.blocks.push(MarkdownBlock {
                kind: BlockKind::ThematicBreak,
                range: positions.range(trim_final_newline(source, range.clone())),
            });
        }
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                let mut range = trim_final_newline(source, range);
                while range.start < range.end
                    && matches!(parsing.as_bytes()[range.start], b' ' | b'\t')
                {
                    range.start += 1;
                }
                current_heading = Some(Heading {
                    text: String::new(),
                    level: level as u8,
                    line: positions.line(range.start),
                    range: positions.range(range),
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(heading) = current_heading.take() {
                    budget.reserve_vec(&mut result.headings, 1, AllocationKind::Facts)?;
                    result.headings.push(heading);
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some(heading) = &mut current_heading {
                    append_heading_text(heading, &text, range, parsing, repairs, budget)?;
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(heading) = &mut current_heading {
                    budget.push_str(&mut heading.text, " ", AllocationKind::Facts)?;
                }
            }
            Event::Start(Tag::Item) => {
                let task = task(source, range.clone(), positions, budget)?.filter(|task| {
                    let start = task.range.bytes[0] as usize;
                    let end = task.range.bytes[1] as usize;
                    visible[start..end] == source.as_bytes()[start..end]
                });
                budget.reserve_vec(&mut result.list_items, 1, AllocationKind::Facts)?;
                let task_status = task.as_ref().map(|task| budget.string(&task.status, AllocationKind::Facts)).transpose()?;
                result.list_items.push(ListItem {
                    range: positions.range(trim_final_newline(source, range)),
                    task_status,
                });
                if let Some(task) = task {
                    budget.reserve_vec(&mut result.tasks, 1, AllocationKind::Facts)?;
                    result.tasks.push(task);
                }
            }
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                id,
                ..
            })
            | Event::Start(Tag::Image {
                link_type,
                dest_url,
                id,
                ..
            }) => {
                let mut range = range;
                if matches!(link_type, LinkType::Collapsed)
                    && source.get(range.end..range.end + 2) == Some("[]")
                {
                    range.end += 2;
                }
                let embed = source.as_bytes().get(range.start) == Some(&b'!');
                let definition = match link_type {
                    LinkType::Reference | LinkType::Collapsed | LinkType::Shortcut => iterator
                        .reference_definitions()
                        .get(&id)
                        .map(|definition| definition.span.clone()),
                    _ => None,
                };
                let wiki = matches!(link_type, LinkType::WikiLink { .. });
                let destination_range = if wiki {
                    wiki_destination(source, range.clone(), embed)
                } else if let Some(definition) = &definition {
                    definition_destination(source, definition.clone())
                } else if matches!(link_type, LinkType::Inline) {
                    inline_destination(source, range.clone(), embed)
                } else {
                    None
                };
                let Some(destination_range) = destination_range else {
                    continue;
                };
                blank(visible, destination_range.clone());
                if !wiki && external(&dest_url) {
                    continue;
                }
                let raw = &source[destination_range.clone()];
                let split = raw.find('#').unwrap_or(raw.len());
                budget.reserve_vec(&mut result.links, 1, AllocationKind::Facts)?;
                result.links.push(Link {
                    kind: if wiki {
                        LinkKind::Wiki
                    } else {
                        LinkKind::Markdown
                    },
                    embed,
                    target: budget.string(&raw[..split], AllocationKind::Facts)?,
                    fragment: budget.string(&raw[split..], AllocationKind::Facts)?,
                    destination: if wiki {
                        budget.string(raw, AllocationKind::Facts)?
                    } else {
                        budget.string(&dest_url, AllocationKind::Facts)?
                    },
                    range: positions.range(range),
                    target_range: positions
                        .range(destination_range.start..destination_range.start + split),
                    definition_range: definition
                        .map(|range| positions.range(trim_final_newline(source, range))),
                });
            }
            _ => {}
        }
    }
    // Stable sorting may allocate a temporary half-length merge buffer.
    budget.charge((result.links.len() / 2) * std::mem::size_of::<Link>(), AllocationKind::Scratch)?;
    result.links.sort_by_key(|link| link.range.bytes[0]);
        Ok(())
    }
    pub(crate) fn tags(&mut self, positions: &Positions<'_>, result: &mut ParseFacts, budget: &mut AllocationBudget) -> Result<(), ParseFactsJobError> {
    let visible = std::str::from_utf8(&self.visible).expect("scalar-aligned tag exclusions");
    static TAGS: OnceLock<Regex> = OnceLock::new();
    static DECIMAL: OnceLock<Regex> = OnceLock::new();
    let tags = TAGS.get_or_init(|| Regex::new(r"(?:^|[\s(])#([\p{L}\p{M}\p{N}_/-]+)").unwrap());
    let decimal = DECIMAL.get_or_init(|| Regex::new(r"^\p{Nd}+$").unwrap());
    let mut names: HashSet<String> = HashSet::new();
    for name in &result.tags {
        budget.reserve_set(&mut names, 1, AllocationKind::Scratch)?;
        names.insert(budget.string(name, AllocationKind::Scratch)?);
    }
    for capture in tags.captures_iter(&visible) {
        let name = capture.get(1).unwrap();
        if decimal.is_match(name.as_str()) {
            continue;
        }
        if !names.contains(name.as_str()) {
            budget.reserve_set(&mut names, 1, AllocationKind::Scratch)?;
            names.insert(budget.string(name.as_str(), AllocationKind::Scratch)?);
            budget.reserve_vec(&mut result.tags, 1, AllocationKind::Facts)?;
            result.tags.push(budget.string(name.as_str(), AllocationKind::Facts)?);
        }
        budget.reserve_vec(&mut result.tag_occurrences, 1, AllocationKind::Facts)?;
        result.tag_occurrences.push(TagOccurrence {
            name: budget.string(name.as_str(), AllocationKind::Facts)?,
            range: positions.range(name.start() - 1..name.end()),
        });
    }        Ok(())
    }
}

struct WikiRepair {
    range: Range<usize>,
    label: String,
    heading_inserted: bool,
}

/// pulldown-cmark 0.13.4 can reinterpret ![[...]] as a giant ordinary image
/// when a later escaped bracket closes its image label. Recover ONLY a shorter
/// atom that the same parser independently validates as one exact wiki image,
/// inside an already parser-confirmed inline image context (never code/HTML).
fn wiki_repairs(source: &str, budget: &mut AllocationBudget) -> Result<Vec<WikiRepair>, ParseFactsJobError> {
    let mut repairs = Vec::new();
    for (event, range) in Parser::new_ext(source, options()).into_offset_iter() {
        if !matches!(
            event,
            Event::Start(Tag::Image {
                link_type: LinkType::Inline,
                ..
            })
        ) || !source[range.clone()].starts_with("![[")
        {
            continue;
        }
        let Some(close) = source[range.start + 3..range.end].find("]]") else {
            continue;
        };
        let end = range.start + 3 + close + 2;
        let candidate = &source[range.start..end];
        if candidate.contains(['\r', '\n']) {
            continue;
        }
        let mut valid = false;
        let mut label = String::new();
        for (event, candidate_range) in Parser::new_ext(candidate, options()).into_offset_iter() {
            if matches!(&event, Event::Start(Tag::Image { link_type: LinkType::WikiLink { .. }, .. })) && candidate_range == (0..candidate.len()) { valid = true; }
            match event {
                Event::Text(text) | Event::Code(text) => budget.push_str(&mut label, &text, AllocationKind::Scratch)?,
                Event::SoftBreak | Event::HardBreak => budget.push_str(&mut label, " ", AllocationKind::Scratch)?,
                _ => {}
            }
        }
        if !valid { continue; }
        budget.reserve_vec(&mut repairs, 1, AllocationKind::Scratch)?;
        repairs.push(WikiRepair {
            range: range.start..end,
            label,
            heading_inserted: false,
        });
    }
    Ok(repairs)
}
fn append_heading_text(
    heading: &mut Heading,
    text: &str,
    range: Range<usize>,
    parsing: &str,
    repairs: &mut [WikiRepair],
    budget: &mut AllocationBudget,
) -> Result<(), ParseFactsJobError> {
    if !repairs
        .iter()
        .any(|repair| range.start < repair.range.end && repair.range.start < range.end)
    {
        budget.push_str(&mut heading.text, text, AllocationKind::Facts)?;
        return Ok(());
    }
    let mut cursor = range.start;
    for repair in repairs
        .iter_mut()
        .filter(|repair| range.start < repair.range.end && repair.range.start < range.end)
    {
        if cursor < repair.range.start {
            budget.push_str(&mut heading.text, &parsing[cursor..repair.range.start], AllocationKind::Facts)?;
        }
        if !repair.heading_inserted {
            budget.push_str(&mut heading.text, &repair.label, AllocationKind::Facts)?;
            repair.heading_inserted = true;
        }
        cursor = range.end.min(repair.range.end);
    }
    if cursor < range.end {
        budget.push_str(&mut heading.text, &parsing[cursor..range.end], AllocationKind::Facts)?;
    }
    Ok(())
}

fn external(destination: &str) -> bool {
    if destination.starts_with("//") {
        return true;
    }
    let Some(colon) = destination.find(':') else {
        return false;
    };
    let scheme = &destination[..colon];
    scheme
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphabetic)
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'_' | b'-'))
}
fn wiki_destination(source: &str, range: Range<usize>, embed: bool) -> Option<Range<usize>> {
    let start = range.start + if embed { 3 } else { 2 };
    let end = range.end.checked_sub(2)?;
    if start > end || !source[range.clone()].ends_with("]]") {
        return None;
    }
    let path = &source[start..end];
    if path.contains(['\r', '\n']) {
        return None;
    }
    Some(start..start + path.find('|').unwrap_or(path.len()))
}

/// Locate original spelling only inside a parser-confirmed link. Markdown
/// validity, reference matching and URL decoding remain pulldown-cmark's job.
fn label_end(bytes: &[u8], mut cursor: usize, end: usize) -> Option<usize> {
    if bytes.get(cursor) != Some(&b'[') {
        return None;
    }
    let mut depth = 1usize;
    cursor += 1;
    while cursor < end {
        match bytes[cursor] {
            b'\\' => {
                cursor = (cursor + 2).min(end);
                continue;
            }
            b'`' => {
                let start = cursor;
                while cursor < end && bytes[cursor] == b'`' {
                    cursor += 1;
                }
                let width = cursor - start;
                let mut search = cursor;
                while search < end {
                    if bytes[search] != b'`' {
                        search += 1;
                        continue;
                    }
                    let run = search;
                    while search < end && bytes[search] == b'`' {
                        search += 1;
                    }
                    if search - run == width {
                        cursor = search;
                        break;
                    }
                }
                continue;
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(cursor);
                }
            }
            _ => {}
        }
        cursor += 1;
    }
    None
}
fn inline_destination(source: &str, range: Range<usize>, embed: bool) -> Option<Range<usize>> {
    let close = label_end(
        source.as_bytes(),
        range.start + usize::from(embed),
        range.end,
    )?;
    if source.as_bytes().get(close + 1) != Some(&b'(') {
        return None;
    }
    destination_span(source, close + 2, range.end)
}
fn definition_destination(source: &str, range: Range<usize>) -> Option<Range<usize>> {
    let close = label_end(source.as_bytes(), range.start, range.end)?;
    if source.as_bytes().get(close + 1) != Some(&b':') {
        return None;
    }
    destination_span(source, close + 2, range.end)
}
fn destination_span(source: &str, mut start: usize, end: usize) -> Option<Range<usize>> {
    let bytes = source.as_bytes();
    while start < end && bytes[start].is_ascii_whitespace() {
        start += 1;
    }
    if start >= end {
        return Some(start..start);
    }
    if bytes[start] == b'<' {
        start += 1;
        let mut cursor = start;
        while cursor < end {
            if bytes[cursor] == b'\\' {
                cursor = (cursor + 2).min(end);
                continue;
            }
            if bytes[cursor] == b'>' {
                return Some(start..cursor);
            }
            cursor += 1;
        }
        return None;
    }
    let mut cursor = start;
    let mut depth = 0usize;
    while cursor < end {
        match bytes[cursor] {
            b'\\' => {
                cursor = (cursor + 2).min(end);
                continue;
            }
            b'(' => depth += 1,
            b')' if depth == 0 => break,
            b')' => depth -= 1,
            byte if byte.is_ascii_whitespace() && depth == 0 => break,
            _ => {}
        }
        cursor += 1;
    }
    Some(start..cursor)
}
fn block_kind(tag: &Tag<'_>) -> Option<BlockKind> {
    Some(match tag {
        Tag::Paragraph => BlockKind::Paragraph,
        Tag::Heading { .. } => BlockKind::Heading,
        Tag::BlockQuote(_) => BlockKind::Blockquote,
        Tag::CodeBlock(_) => BlockKind::Code,
        Tag::HtmlBlock => BlockKind::Html,
        Tag::Table(_) => BlockKind::Table,
        _ => return None,
    })
}
fn block_end(tag: &TagEnd) -> bool {
    matches!(
        tag,
        TagEnd::Paragraph
            | TagEnd::Heading(_)
            | TagEnd::BlockQuote(_)
            | TagEnd::CodeBlock
            | TagEnd::HtmlBlock
            | TagEnd::Table
    )
}

fn task(source: &str, item: Range<usize>, positions: &Positions<'_>, budget: &mut AllocationBudget) -> Result<Option<Task>, ParseFactsJobError> {
    let mut cursor = item.start;
    let end = line_end(source, cursor);
    let bytes = source.as_bytes();
    while cursor < end && matches!(bytes[cursor], b' ' | b'\t') {
        cursor += 1;
    }
    if matches!(bytes.get(cursor), Some(b'-' | b'+' | b'*')) {
        cursor += 1;
    } else {
        let begin = cursor;
        while cursor < end && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == begin || !matches!(bytes.get(cursor), Some(b'.' | b')')) {
            return Ok(None);
        }
        cursor += 1;
    }
    if !matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        return Ok(None);
    }
    while cursor < end && matches!(bytes[cursor], b' ' | b'\t') {
        cursor += 1;
    }
    let start = cursor;
    if bytes.get(start) != Some(&b'[') {
        return Ok(None);
    }
    let Some(character) = source.get(start + 1..).and_then(|text| text.chars().next()) else { return Ok(None); };
    if character.len_utf16() != 1 || matches!(character, '\r' | '\n') {
        return Ok(None);
    }
    let status_end = start + 1 + character.len_utf8();
    if bytes.get(status_end) != Some(&b']') {
        return Ok(None);
    }
    let marker_end = status_end + 1;
    if marker_end < end && !matches!(bytes[marker_end], b' ' | b'\t') {
        return Ok(None);
    }
    cursor = marker_end;
    while cursor < end && matches!(bytes[cursor], b' ' | b'\t') {
        cursor += 1;
    }
    let mut scalar_bytes = [0; 4];
    Ok(Some(Task {
        status: budget.string(character.encode_utf8(&mut scalar_bytes), AllocationKind::Facts)?,
        checked: character != ' ',
        completed: matches!(character, 'x' | 'X'),
        text: budget.string(&source[cursor..end], AllocationKind::Facts)?,
        line: positions.line(start),
        range: positions.range(start..marker_end),
        status_range: positions.range(start + 1..status_end),
        text_range: positions.range(cursor..end),
        item_range: positions.range(trim_final_newline(source, item)),
    }))
}
