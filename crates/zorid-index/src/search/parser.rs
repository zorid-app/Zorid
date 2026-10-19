use super::*;
use regex::{Regex, RegexBuilder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Scope {
    File,
    Path,
    Content,
    Line,
    Block,
    Section,
    Task,
    Todo,
    Done,
    Tag,
    Sensitive,
    Insensitive,
}
impl Scope {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "file" => Self::File,
            "path" => Self::Path,
            "content" => Self::Content,
            "line" => Self::Line,
            "block" => Self::Block,
            "section" => Self::Section,
            "task" => Self::Task,
            "task-todo" => Self::Todo,
            "task-done" => Self::Done,
            "tag" => Self::Tag,
            "match-case" => Self::Sensitive,
            "ignore-case" => Self::Insensitive,
            _ => return None,
        })
    }
    fn exclusive(self) -> bool {
        !matches!(self, Self::Sensitive | Self::Insensitive)
    }
}
pub(super) struct Pattern {
    pub text: String,
    pub quoted: bool,
    pub regex: bool,
    pub fixed_literal: bool,
    pub sensitive: Regex,
    pub insensitive: Regex,
}
pub(super) enum Node {
    Pattern(Pattern),
    Constant(Constant),
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    Compare(bool, String),
    Scope(Scope, Box<Node>),
    Property(Box<Node>, Option<Box<Node>>),
}
// Constructed in the same parser pass as Node. This preserves the evaluator's
// enum and records consumed syntax before grouping/delimiter tokens disappear.
struct ParsedNode {
    node: Node,
    explanation: ExplanationNode,
}
impl ParsedNode {
    fn in_property_key_context(&mut self) {
        fn apply(node: &mut ExplanationNode) {
            // Evaluator::pattern compares quoted Field::Key operands by
            // lowercase equality, independent of the inherited case variant.
            // Ordinary key patterns and property values keep their context.
            if node.kind == SearchExplanationKind::Quoted {
                node.case_sensitive = false;
            }
            for child in &mut node.children {
                apply(child);
            }
        }
        apply(&mut self.explanation);
    }
}
#[derive(Clone, Copy)]
pub(super) enum Constant {
    True,
    False,
    Empty,
}
#[derive(Clone)]
struct Token {
    kind: Kind,
    value: String,
    start: usize,
    end: usize,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Quote,
    Regex,
    Or,
    True,
    False,
    Empty,
    Minus,
    Open,
    Close,
    Left,
    Right,
    Colon,
    Less,
    Greater,
}
fn diagnostic(
    q: &str,
    code: SearchDiagnosticCode,
    start: usize,
    end: usize,
    message: &str,
) -> SearchDiagnostic {
    SearchDiagnostic {
        code,
        query_range: query_range(q, start, end),
        message: message.into(),
    }
}
fn query_range(q: &str, start: usize, end: usize) -> SourceRange {
    SourceRange {
        bytes: [start as u32, end as u32],
        utf16: [
            q[..start].encode_utf16().count() as u32,
            q[..end].encode_utf16().count() as u32,
        ],
    }
}
fn explanation_scope(scope: Scope) -> SearchScope {
    match scope {
        Scope::File => SearchScope::File,
        Scope::Path => SearchScope::Path,
        Scope::Content => SearchScope::Content,
        Scope::Line => SearchScope::Line,
        Scope::Block => SearchScope::Block,
        Scope::Section => SearchScope::Section,
        Scope::Task => SearchScope::Task,
        Scope::Todo => SearchScope::TaskTodo,
        Scope::Done => SearchScope::TaskDone,
        Scope::Tag => SearchScope::Tag,
        Scope::Sensitive => SearchScope::MatchCase,
        Scope::Insensitive => SearchScope::IgnoreCase,
    }
}
fn tokenize(q: &str, limits: &SearchLimits) -> Result<Vec<Token>, SearchDiagnostic> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < q.len() {
        let start = at;
        let first = q[at..].chars().next().unwrap();
        if first == ' ' {
            at += 1;
            continue;
        }
        let mut value = String::new();
        let kind = if first == '"' || first == '/' {
            at += 1;
            while at < q.len() {
                let c = q[at..].chars().next().unwrap();
                at += c.len_utf8();
                if c == first {
                    break;
                }
                if c == '\\' && at < q.len() {
                    let next = q[at..].chars().next().unwrap();
                    if first == '"' || next == '/' {
                        value.push(next);
                        at += next.len_utf8();
                        continue;
                    }
                    if next == '\\' {
                        value.push_str("\\\\");
                        at += 1;
                        continue;
                    }
                }
                value.push(c);
            }
            if first == '"' {
                Kind::Quote
            } else {
                Kind::Regex
            }
        } else if "-[]():<>".contains(first) {
            at += 1;
            value.push(first);
            match first {
                '-' => Kind::Minus,
                '[' => Kind::Left,
                ']' => Kind::Right,
                '(' => Kind::Open,
                ')' => Kind::Close,
                ':' => Kind::Colon,
                '<' => Kind::Less,
                _ => Kind::Greater,
            }
        } else {
            while at < q.len() {
                let c = q[at..].chars().next().unwrap();
                if " []():<>".contains(c) {
                    break;
                }
                at += c.len_utf8();
            }
            value.push_str(&q[start..at]);
            match value.as_str() {
                "OR" => Kind::Or,
                "TRUE" => Kind::True,
                "FALSE" => Kind::False,
                "EMPTY" => Kind::Empty,
                _ => Kind::Text,
            }
        };
        if out.len() >= limits.tokens {
            return Err(diagnostic(
                q,
                SearchDiagnosticCode::Resource,
                start,
                at,
                "Search token limit exceeded",
            ));
        }
        out.push(Token {
            kind,
            value,
            start,
            end: at,
        });
    }
    Ok(out)
}
struct Parser<'a> {
    q: &'a str,
    tokens: Vec<Token>,
    at: usize,
    nodes: usize,
    limits: &'a SearchLimits,
    regex_budget: usize,
    case_sensitive: bool,
}
impl Parser<'_> {
    fn explained(
        &self,
        node: Node,
        kind: SearchExplanationKind,
        range: [usize; 2],
        stack: &[Scope],
        operand: Option<String>,
        children: Vec<ExplanationNode>,
    ) -> ParsedNode {
        let scope = stack.iter().rev().find(|s| s.exclusive()).copied();
        let sensitive = if scope == Some(Scope::Tag) {
            false // Tag matching deliberately lowercases independent of options.
        } else {
            stack
                .iter()
                .rev()
                .find_map(|s| match s {
                    Scope::Sensitive => Some(true),
                    Scope::Insensitive => Some(false),
                    _ => None,
                })
                .unwrap_or(self.case_sensitive)
        };
        ParsedNode {
            node,
            explanation: ExplanationNode {
                kind,
                query_range: query_range(self.q, range[0], range[1]),
                case_sensitive: sensitive,
                scope: scope.map(explanation_scope),
                operand,
                children,
            },
        }
    }
    fn error(&self, c: SearchDiagnosticCode, t: &Token, m: &str) -> SearchDiagnostic {
        diagnostic(self.q, c, t.start, t.end, m)
    }
    fn group(
        &mut self,
        or: bool,
        stack: &[Scope],
        property: bool,
        depth: usize,
    ) -> Result<Option<ParsedNode>, SearchDiagnostic> {
        let mut children = Vec::new();
        loop {
            let child = if or {
                self.group(false, stack, property, depth + 1)?
            } else {
                self.unary(stack, property, depth + 1)?
            };
            let Some(child) = child else { break };
            children.push(child);
            if or {
                if self.tokens.get(self.at).map(|t| t.kind) != Some(Kind::Or) {
                    break;
                }
                self.at += 1;
            }
        }
        if children.len() > 1 {
            if self.nodes >= self.limits.nodes {
                let at = self.tokens.get(self.at.saturating_sub(1)).unwrap();
                return Err(self.error(
                    SearchDiagnosticCode::Resource,
                    at,
                    "Search node limit exceeded",
                ));
            }
            self.nodes += 1;
        }
        Ok(match children.len() {
            0 => None,
            1 => children.pop(),
            _ => {
                let start = children.first().unwrap().explanation.query_range.bytes[0] as usize;
                let end = children.last().unwrap().explanation.query_range.bytes[1] as usize;
                let (nodes, explanations) = children
                    .into_iter()
                    .map(|c| (c.node, c.explanation))
                    .unzip();
                let (node, kind) = if or {
                    (Node::Or(nodes), SearchExplanationKind::Or)
                } else {
                    (Node::And(nodes), SearchExplanationKind::And)
                };
                Some(self.explained(node, kind, [start, end], stack, None, explanations))
            }
        })
    }
    fn unary(
        &mut self,
        stack: &[Scope],
        property: bool,
        depth: usize,
    ) -> Result<Option<ParsedNode>, SearchDiagnostic> {
        let Some(t) = self.tokens.get(self.at).cloned() else {
            return Ok(None);
        };
        if matches!(t.kind, Kind::Close | Kind::Right | Kind::Colon | Kind::Or) {
            return Ok(None);
        }
        if depth > self.limits.depth || self.nodes >= self.limits.nodes {
            return Err(self.error(
                SearchDiagnosticCode::Resource,
                &t,
                "Search syntax limit exceeded",
            ));
        }
        self.nodes += 1;
        self.at += 1;
        if t.kind == Kind::Text
            && self.tokens.get(self.at).map(|t| t.kind) == Some(Kind::Colon)
            && !property
        {
            self.at += 1;
            let scope = Scope::parse(&t.value.to_lowercase()).ok_or_else(|| {
                self.error(
                    SearchDiagnosticCode::UnknownOperator,
                    &t,
                    "Unknown search operator",
                )
            })?;
            if scope.exclusive() {
                if let Some(outer) = stack.iter().find(|s| s.exclusive()) {
                    if *outer != Scope::Section || scope != Scope::Section {
                        return Err(self.error(
                            SearchDiagnosticCode::InvalidNesting,
                            &t,
                            "Search scopes cannot be nested here",
                        ));
                    }
                }
            }
            let mut next = stack.to_vec();
            next.push(scope);
            let child = match self.unary(&next, property, depth + 1)? {
                Some(c) => c,
                None => self.empty(&t, &next)?,
            };
            if scope == Scope::Tag && !matches!(&child.node,Node::Pattern(p) if !p.quoted&&!p.regex)
            {
                return Err(self.error(
                    SearchDiagnosticCode::InvalidOperand,
                    &t,
                    "tag requires plain text",
                ));
            }
            let end = self.tokens[self.at - 1].end;
            let mut parsed = self.explained(
                Node::Scope(scope, Box::new(child.node)),
                SearchExplanationKind::Scope,
                [t.start, end],
                &next,
                None,
                vec![child.explanation],
            );
            parsed.explanation.scope = Some(explanation_scope(scope));
            return Ok(Some(parsed));
        }
        let (node, kind, operand, children) = match t.kind {
            Kind::Left => {
                if property {
                    return Err(self.error(
                        SearchDiagnosticCode::InvalidNesting,
                        &t,
                        "Properties cannot be nested",
                    ));
                }
                let mut key = match self.group(true, stack, true, depth + 1)? {
                    Some(c) => c,
                    None => self.empty(&t, stack)?,
                };
                key.in_property_key_context();
                let value = if self.tokens.get(self.at).map(|t| t.kind) == Some(Kind::Colon) {
                    self.at += 1;
                    self.group(true, stack, true, depth + 1)?.map(Box::new)
                } else {
                    None
                };
                if self.tokens.get(self.at).map(|t| t.kind) == Some(Kind::Right) {
                    self.at += 1;
                }
                let mut children = vec![key.explanation];
                let value = value.map(|v| {
                    children.push(v.explanation);
                    Box::new(v.node)
                });
                (
                    Node::Property(Box::new(key.node), value),
                    SearchExplanationKind::Property,
                    None,
                    children,
                )
            }
            Kind::Open => {
                let child = match self.group(true, stack, property, depth + 1)? {
                    Some(c) => c,
                    None => self.empty(&t, stack)?,
                };
                if self.tokens.get(self.at).map(|t| t.kind) == Some(Kind::Close) {
                    self.at += 1;
                }
                let mut child = child;
                child.explanation.query_range =
                    query_range(self.q, t.start, self.tokens[self.at - 1].end);
                return Ok(Some(child));
            }
            Kind::Minus => {
                let Some(child) = self.unary(stack, property, depth + 1)? else {
                    return Ok(None);
                };
                (
                    Node::Not(Box::new(child.node)),
                    SearchExplanationKind::Not,
                    None,
                    vec![child.explanation],
                )
            }
            Kind::Less | Kind::Greater => {
                let Some(child) = self.unary(stack, property, depth + 1)? else {
                    return Ok(None);
                };
                let Node::Pattern(p) = child.node else {
                    return Err(self.error(
                        SearchDiagnosticCode::InvalidOperand,
                        &t,
                        "Comparison requires text",
                    ));
                };
                if p.regex {
                    return Err(self.error(
                        SearchDiagnosticCode::InvalidOperand,
                        &t,
                        "Comparison requires text",
                    ));
                }
                // Keep the comparator in the operand: otherwise the explanation
                // would erase the distinction between <text and >text.
                let operand = format!("{}{}", t.value, p.text);
                (
                    Node::Compare(t.kind == Kind::Less, p.text),
                    SearchExplanationKind::Compare,
                    Some(operand),
                    Vec::new(),
                )
            }
            Kind::True => (
                Node::Constant(Constant::True),
                SearchExplanationKind::Constant,
                Some(t.value.clone()),
                Vec::new(),
            ),
            Kind::False => (
                Node::Constant(Constant::False),
                SearchExplanationKind::Constant,
                Some(t.value.clone()),
                Vec::new(),
            ),
            Kind::Empty => (
                Node::Constant(Constant::Empty),
                SearchExplanationKind::Constant,
                Some(t.value.clone()),
                Vec::new(),
            ),
            _ => {
                let kind = match t.kind {
                    Kind::Quote => SearchExplanationKind::Quoted,
                    Kind::Regex => SearchExplanationKind::Regex,
                    _ => SearchExplanationKind::Text,
                };
                (
                    Node::Pattern(pattern(self.q, &t, self.regex_budget)?),
                    kind,
                    Some(t.value.clone()),
                    Vec::new(),
                )
            }
        };
        Ok(Some(self.explained(
            node,
            kind,
            [t.start, self.tokens[self.at - 1].end],
            stack,
            operand,
            children,
        )))
    }
    fn empty(&mut self, t: &Token, stack: &[Scope]) -> Result<ParsedNode, SearchDiagnostic> {
        if self.nodes >= self.limits.nodes {
            return Err(self.error(
                SearchDiagnosticCode::Resource,
                t,
                "Search node limit exceeded",
            ));
        }
        self.nodes += 1;
        let mut t = t.clone();
        t.kind = Kind::Text;
        t.value.clear();
        // An implicit operand has no source characters. Anchor it after the
        // consumed opener/colon rather than attributing the operator's text.
        let at = self.tokens[self.at.saturating_sub(1)].end;
        Ok(self.explained(
            Node::Pattern(pattern(self.q, &t, self.regex_budget)?),
            SearchExplanationKind::Text,
            [at, at],
            stack,
            Some(String::new()),
            Vec::new(),
        ))
    }
}
fn pattern(q: &str, t: &Token, budget: usize) -> Result<Pattern, SearchDiagnostic> {
    let is_regex = t.kind == Kind::Regex;
    let source = if is_regex {
        t.value.clone()
    } else {
        regex::escape(&t.value)
    };
    let build = |insensitive| {
        RegexBuilder::new(&source)
            .case_insensitive(insensitive)
            .multi_line(true)
            .size_limit(budget)
            .dfa_size_limit(budget)
            .build()
            .map_err(|e| {
                let code = if matches!(e, regex::Error::CompiledTooBig(_)) {
                    SearchDiagnosticCode::Resource
                } else if is_regex && unsupported(&t.value) {
                    SearchDiagnosticCode::UnsupportedRegex
                } else {
                    SearchDiagnosticCode::InvalidRegex
                };
                diagnostic(
                    q,
                    code,
                    t.start,
                    t.end,
                    "Invalid or over-budget regular expression",
                )
            })
    };
    Ok(Pattern {
        text: t.value.clone(),
        quoted: t.kind == Kind::Quote,
        regex: is_regex,
        // No escapes, operators, classes or flags: engine interpretation is a
        // fixed Unicode literal, including the slash form /needle/.
        fixed_literal: !is_regex || !t.value.chars().any(|c| r"\.^$*+?()[]{}|".contains(c)),
        sensitive: build(false)?,
        insensitive: build(true)?,
    })
}
/// Class/escape-aware capability classifier. Escaped spelling and class literals
/// must not be confused with executable lookaround/backreference syntax.
fn unsupported(s: &str) -> bool {
    let b = s.as_bytes();
    let mut at = 0;
    let mut class: usize = 0;
    let mut extended = false;
    let mut groups = Vec::new();
    while at < b.len() {
        if extended && b[at] == b'#' {
            while at < b.len() && b[at] != b'\n' {
                at += 1;
            }
            continue;
        }
        if b[at] == b'\\' {
            if at + 1 < b.len() {
                let c = b[at + 1];
                if class == 0
                    && (c.is_ascii_digit() && c != b'0'
                        || c == b'k' && b.get(at + 2) == Some(&b'<')
                        || c == b'g' && matches!(b.get(at + 2), Some(b'<' | b'\'')))
                {
                    return true;
                }
                at += 2;
                continue;
            }
        } else if b[at] == b'[' {
            class += 1;
        } else if b[at] == b']' {
            class = class.saturating_sub(1);
        } else if class == 0 && b[at] == b'(' {
            if b.get(at + 1) == Some(&b'?') {
                // Track valid inline flag scopes so # comments in x mode
                // cannot manufacture unsupported executable capabilities.
                let mut end = at + 2;
                let mut next = extended;
                let mut enabled = true;
                while let Some(&c) = b.get(end) {
                    if c == b'-' {
                        enabled = false;
                        end += 1;
                        continue;
                    }
                    if !b"imsRUux".contains(&c) {
                        break;
                    }
                    if c == b'x' {
                        next = enabled;
                    }
                    end += 1;
                }
                if end > at + 2 && matches!(b.get(end), Some(b':' | b')')) {
                    if b[end] == b':' {
                        groups.push(extended);
                    }
                    extended = next;
                    at = end + 1;
                    continue;
                }
                if matches!(b.get(at + 2), Some(b'=' | b'!'))
                    || b.get(at + 2) == Some(&b'<') && matches!(b.get(at + 3), Some(b'=' | b'!'))
                    || b.get(at + 2..at + 4) == Some(b"P=")
                {
                    return true;
                }
            }
            groups.push(extended);
        } else if class == 0 && b[at] == b')' {
            extended = groups.pop().unwrap_or(extended);
        }
        at += 1;
    }
    false
}

pub(super) fn compile(
    q: &str,
    l: &SearchLimits,
    case_sensitive: bool,
) -> Result<(Option<Node>, Option<ExplanationNode>, usize), SearchDiagnostic> {
    if !l.valid() || q.len() > l.query_bytes {
        return Err(diagnostic(
            q,
            SearchDiagnosticCode::Resource,
            0,
            0,
            "Search query or limit exceeds shared bounds",
        ));
    }
    let tokens = tokenize(q, l)?;
    // Every admitted token is a conservative upper bound on one pattern.
    // Both case variants are retained; cap compiled and lazy-DFA components.
    let variants = tokens.len().max(1).saturating_mul(2);
    let regex_budget = l.regex_variant_bytes.min(l.regex_bytes / variants);
    if regex_budget == 0 {
        return Err(diagnostic(
            q,
            SearchDiagnosticCode::Resource,
            0,
            0,
            "Search regex budget exhausted",
        ));
    }
    let mut parser = Parser {
        q,
        tokens,
        at: 0,
        nodes: 0,
        limits: l,
        regex_budget,
        case_sensitive,
    };
    Ok(match parser.group(true, &[], false, 0)? {
        Some(parsed) => (Some(parsed.node), Some(parsed.explanation), regex_budget),
        None => (None, None, regex_budget),
    })
}

/// Dynamic allocations under Node; its inline size is counted by its owner.
/// Regex internals do not expose allocator capacities: reserve the admitted
/// compiled-program and lazy-DFA component limits for each retained variant.
/// This is a component admission estimate, not a total regex/process heap bound.
pub(super) fn retained_bytes(node: &Node, regex_budget: usize) -> usize {
    use std::mem::size_of;
    match node {
        Node::Pattern(p) => p
            .text
            .capacity()
            .saturating_add(regex_budget.saturating_mul(4))
            // Regex stores its source separately from our decoded operand.
            .saturating_add(p.sensitive.as_str().len().saturating_mul(2)),
        Node::Compare(_, s) => s.capacity(),
        Node::And(children) | Node::Or(children) => children
            .capacity()
            .saturating_mul(size_of::<Node>())
            .saturating_add(
                children
                    .iter()
                    .map(|c| retained_bytes(c, regex_budget))
                    .fold(0usize, usize::saturating_add),
            ),
        Node::Not(c) | Node::Scope(_, c) => {
            size_of::<Node>().saturating_add(retained_bytes(c, regex_budget))
        }
        Node::Property(key, value) => size_of::<Node>()
            .saturating_add(retained_bytes(key, regex_budget))
            .saturating_add(value.as_ref().map_or(0, |v| {
                size_of::<Node>().saturating_add(retained_bytes(v, regex_budget))
            })),
        Node::Constant(_) => 0,
    }
}
pub(super) fn explanation_retained_bytes(node: &ExplanationNode) -> usize {
    node.operand
        .as_ref()
        .map_or(0, String::capacity)
        .saturating_add(
            node.children
                .capacity()
                .saturating_mul(std::mem::size_of::<ExplanationNode>()),
        )
        .saturating_add(
            node.children
                .iter()
                .map(explanation_retained_bytes)
                .fold(0usize, usize::saturating_add),
        )
}
pub(super) fn requirements(node: &Node) -> SearchRequirements {
    match node {
        Node::And(c) | Node::Or(c) => {
            c.iter()
                .map(requirements)
                .fold(SearchRequirements::default(), |a, b| SearchRequirements {
                    content: a.content || b.content,
                    metadata: a.metadata || b.metadata,
                })
        }
        Node::Not(c) => requirements(c),
        Node::Property(..) => SearchRequirements {
            content: false,
            metadata: true,
        },
        Node::Scope(s, c) => match s {
            Scope::File | Scope::Path => SearchRequirements {
                content: false,
                metadata: requirements(c).metadata,
            },
            Scope::Sensitive | Scope::Insensitive => requirements(c),
            Scope::Tag => SearchRequirements {
                content: false,
                metadata: true,
            },
            _ => SearchRequirements {
                content: true,
                metadata: !matches!(s, Scope::Content | Scope::Line) || requirements(c).metadata,
            },
        },
        Node::Pattern(_) => SearchRequirements {
            content: true,
            metadata: false,
        },
        _ => SearchRequirements::default(),
    }
}
