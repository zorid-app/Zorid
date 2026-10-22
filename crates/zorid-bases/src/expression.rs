// Adapted from callumalpass/mdbase-rs, MIT, Copyright (c) 2025 Callum Alpass.
// Pinned origin and modifications: ../UPSTREAM.md; full notice: ../LICENSE-MDBASE.
use indexmap::IndexMap;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, OnceLock, RwLock};

use chrono::{
    DateTime, Datelike, FixedOffset, LocalResult, NaiveDate, NaiveDateTime, TimeZone,
    Timelike, Utc,
};
use chrono_tz::{GapInfo, Tz};
use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};

#[cfg(test)]
#[path = "expression_call_tests.rs"]
mod call_contract_tests;
#[cfg(test)]
#[path = "expression_collection_tests.rs"]
mod collection_tests;
#[path = "expression_signatures.rs"]
mod call_signatures;
#[path = "expression_format.rs"]
mod date_format;
#[path = "expression_regex_admission.rs"]
mod regex_admission;
#[cfg(test)]
#[path = "expression_regex_admission_tests.rs"]
mod regex_admission_tests;
#[path = "expression_duration.rs"]
mod duration_semantics;
#[path = "expression_duration_dependency.rs"]
mod duration_dependency;
#[cfg(test)]
#[path = "duration_semantics_tests.rs"]
mod duration_semantics_tests;

#[path = "expression_shape.rs"]
mod runtime_shape;
pub(crate) use runtime_shape::{
    capture_runtime_shape, restore_runtime_shape, runtime_shape_restore_bytes, TagShape,
};

use crate::{BaseValue, EvaluationResult, ExpressionDiagnostic, OperationCancellation};
#[derive(Clone, Debug, PartialEq)]
enum Expr {
    Literal(Value),
    Regex(String, String, Arc<()>),
    Identifier(String),
    Array(Vec<Expr>),
    Unary(String, Box<Expr>),
    Binary(String, Box<Expr>, Box<Expr>),
    Member(Box<Expr>, Member),
    Call(Box<Expr>, Vec<Expr>),
}

#[derive(Clone, Debug, PartialEq)]
enum Member {
    Named(String),
    Computed(Box<Expr>),
}

#[derive(Clone, Debug, PartialEq)]
enum TokenKind {
    Number(f64),
    String(String),
    Identifier(String),
    Regex(String, String),
    Operator(String),
    Punct(char),
    Eof,
}

#[derive(Clone, Debug, PartialEq)]
struct Token {
    kind: TokenKind,
    raw: String,
}

struct Lexer<'a> {
    source: &'a str,
    chars: Vec<char>,
    index: usize,
    tokens: Vec<Token>,
    previous_ends_expression: bool,
}

impl<'a> Lexer<'a> {
    fn tokenize(source: &'a str) -> Result<Vec<Token>, String> {
        let mut lexer = Self {
            source,
            chars: source.chars().collect(),
            index: 0,
            tokens: Vec::new(),
            previous_ends_expression: false,
        };
        while let Some(character) = lexer.peek(0) {
            if character.is_whitespace() {
                lexer.index += 1;
            } else if character.is_ascii_digit()
                || (character == '.' && lexer.peek(1).is_some_and(|value| value.is_ascii_digit()))
            {
                lexer.number()?;
            } else if matches!(character, '\'' | '"') {
                lexer.string(character)?;
            } else if character == '/' && !lexer.previous_ends_expression {
                lexer.regexp()?;
            } else if is_identifier_start(character) {
                lexer.identifier();
            } else {
                lexer.symbol()?;
            }
        }
        lexer.tokens.push(Token {
            kind: TokenKind::Eof,
            raw: String::new(),
        });
        Ok(lexer.tokens)
    }

    fn peek(&self, offset: usize) -> Option<char> {
        self.chars.get(self.index + offset).copied()
    }

    fn slice(&self, start: usize, end: usize) -> String {
        self.chars[start..end].iter().collect()
    }

    fn push(&mut self, kind: TokenKind, raw: String, ends_expression: bool) {
        self.tokens.push(Token { kind, raw });
        self.previous_ends_expression = ends_expression;
    }

    fn number(&mut self) -> Result<(), String> {
        let start = self.index;
        if self.peek(0) != Some('.') {
            while self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                self.index += 1;
            }
        }
        if self.peek(0) == Some('.') && self.peek(1).is_some_and(|value| value.is_ascii_digit()) {
            self.index += 1;
            while self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                self.index += 1;
            }
        }
        if self.peek(0).is_some_and(|value| matches!(value, 'e' | 'E')) {
            let exponent = self.index;
            self.index += 1;
            if self.peek(0).is_some_and(|value| matches!(value, '+' | '-')) {
                self.index += 1;
            }
            if self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                while self.peek(0).is_some_and(|value| value.is_ascii_digit()) {
                    self.index += 1;
                }
            } else {
                self.index = exponent;
            }
        }
        let raw = self.slice(start, self.index);
        let value = raw
            .parse::<f64>()
            .map_err(|_| format!("Invalid number {raw}"))?;
        if !value.is_finite() {
            return Err("numeric-domain\0Nonfinite numeric literal".into());
        }
        self.push(TokenKind::Number(value), raw, true);
        Ok(())
    }

    fn string(&mut self, quote: char) -> Result<(), String> {
        let start = self.index;
        self.index += 1;
        let mut value = String::new();
        while let Some(character) = self.peek(0) {
            self.index += 1;
            if character == quote {
                let raw = self.slice(start, self.index);
                self.push(TokenKind::String(value), raw, true);
                return Ok(());
            }
            if character == '\\' {
                let escaped = self
                    .peek(0)
                    .ok_or_else(|| "Unterminated string literal".to_string())?;
                self.index += 1;
                value.push(match escaped {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    'b' => '\u{0008}',
                    'f' => '\u{000c}',
                    other => other,
                });
            } else {
                value.push(character);
            }
        }
        Err(format!("Unterminated string literal in {}", self.source))
    }

    fn regexp(&mut self) -> Result<(), String> {
        let start = self.index;
        self.index += 1;
        let mut pattern = String::new();
        let mut escaped = false;
        let mut in_class = false;
        while let Some(character) = self.peek(0) {
            self.index += 1;
            if escaped {
                pattern.push('\\');
                pattern.push(character);
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '[' {
                in_class = true;
                pattern.push(character);
            } else if character == ']' {
                in_class = false;
                pattern.push(character);
            } else if character == '/' && !in_class {
                let mut flags = String::new();
                while self
                    .peek(0)
                    .is_some_and(|value| value.is_ascii_alphabetic())
                {
                    flags.push(self.peek(0).expect("checked"));
                    self.index += 1;
                }
                let raw = self.slice(start, self.index);
                self.push(TokenKind::Regex(pattern, flags), raw, true);
                return Ok(());
            } else {
                pattern.push(character);
            }
        }
        Err("Unterminated regular expression literal".to_string())
    }

    fn identifier(&mut self) {
        let start = self.index;
        self.index += 1;
        while self.peek(0).is_some_and(is_identifier_part) {
            self.index += 1;
        }
        let raw = self.slice(start, self.index);
        self.push(TokenKind::Identifier(raw.clone()), raw, true);
    }

    fn symbol(&mut self) -> Result<(), String> {
        let character = self.peek(0).expect("symbol exists");
        let pair = self
            .peek(1)
            .map(|next| format!("{character}{next}"))
            .unwrap_or_default();
        if matches!(pair.as_str(), "==" | "!=" | ">=" | "<=" | "&&" | "||") {
            self.index += 2;
            self.push(TokenKind::Operator(pair.clone()), pair, false);
            return Ok(());
        }
        if matches!(character, '+' | '-' | '*' | '/' | '%' | '!' | '>' | '<') {
            self.index += 1;
            self.push(
                TokenKind::Operator(character.to_string()),
                character.to_string(),
                false,
            );
            return Ok(());
        }
        if matches!(
            character,
            '(' | '[' | '{' | '.' | ',' | ':' | ')' | ']' | '}'
        ) {
            self.index += 1;
            let ends = matches!(character, ')' | ']' | '}');
            self.push(TokenKind::Punct(character), character.to_string(), ends);
            return Ok(());
        }
        Err(format!("Unexpected character {character:?}"))
    }
}

fn is_identifier_start(character: char) -> bool {
    character.is_alphabetic() || character == '_' || character == '$'
}

fn is_identifier_part(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '_' | '$')
}

struct Parser {
    tokens: Vec<Token>,
    index: usize,
    depth: usize,
}

impl Parser {
    fn parse(source: &str) -> Result<Expr, String> {
        let mut parser = Self {
            tokens: Lexer::tokenize(source)?,
            index: 0,
            depth: 0,
        };
        let expression = parser.expression(0)?;
        check_ast_depth(&expression, 0)?;
        if !matches!(parser.current().kind, TokenKind::Eof) {
            return Err(format!("Unexpected token {}", parser.current().raw));
        }
        Ok(expression)
    }

    fn current(&self) -> &Token {
        &self.tokens[self.index]
    }

    fn advance(&mut self) -> Token {
        let token = self.tokens[self.index].clone();
        self.index += 1;
        token
    }

    fn match_punct(&mut self, expected: char) -> bool {
        if matches!(&self.current().kind, TokenKind::Punct(value) if *value == expected) {
            self.index += 1;
            true
        } else {
            false
        }
    }

    fn expect_punct(&mut self, expected: char) -> Result<(), String> {
        if self.match_punct(expected) {
            Ok(())
        } else {
            Err(format!("Expected {expected}, found {}", self.current().raw))
        }
    }

    fn expression(&mut self, minimum: u8) -> Result<Expr, String> {
        if self.depth >= 128 {
            return Err("Expression nesting exceeds 128".into());
        }
        self.depth += 1;
        let result = self.expression_inner(minimum);
        self.depth -= 1;
        result
    }

    fn expression_inner(&mut self, minimum: u8) -> Result<Expr, String> {
        let mut left = self.prefix()?;
        let mut chain = 0;
        left = self.postfix(left)?;
        while let TokenKind::Operator(operator) = &self.current().kind {
            let precedence = match operator.as_str() {
                "||" => 1,
                "&&" => 2,
                "==" | "!=" | ">" | "<" | ">=" | "<=" => 3,
                "+" | "-" => 4,
                "*" | "/" | "%" => 5,
                _ => 0,
            };
            if precedence == 0 || precedence < minimum {
                break;
            }
            chain += 1;
            if chain > 128 {
                return Err("Expression operator chain exceeds 128".into());
            }
            let operator = operator.clone();
            self.advance();
            let right = self.expression(precedence + 1)?;
            left = Expr::Binary(operator, Box::new(left), Box::new(right));
            check_ast_depth(&left, 0)?;
        }
        Ok(left)
    }

    fn prefix(&mut self) -> Result<Expr, String> {
        let token = self.advance();
        match token.kind {
            TokenKind::Number(value) => Ok(Expr::Literal(number_json(value))),
            TokenKind::String(value) => Ok(Expr::Literal(Value::String(value))),
            TokenKind::Regex(pattern, flags) => Ok(Expr::Regex(pattern, flags, Arc::new(()))),
            TokenKind::Identifier(value) if value == "true" => Ok(Expr::Literal(Value::Bool(true))),
            TokenKind::Identifier(value) if value == "false" => {
                Ok(Expr::Literal(Value::Bool(false)))
            }
            TokenKind::Identifier(value) if value == "null" => Ok(Expr::Literal(Value::Null)),
            TokenKind::Identifier(value) => Ok(Expr::Identifier(value)),
            TokenKind::Operator(operator) if matches!(operator.as_str(), "!" | "-" | "+") => {
                Ok(Expr::Unary(operator, Box::new(self.expression(6)?)))
            }
            TokenKind::Punct('(') => {
                let value = self.expression(0)?;
                self.expect_punct(')')?;
                Ok(value)
            }
            TokenKind::Punct('[') => {
                let mut values = Vec::new();
                if !self.match_punct(']') {
                    loop {
                        values.push(self.expression(0)?);
                        if !self.match_punct(',') {
                            self.expect_punct(']')?;
                            break;
                        }
                    }
                }
                Ok(Expr::Array(values))
            }
            TokenKind::Punct('{') => {
                Err("Object literals are not supported by Obsidian Bases".to_string())
            }
            _ => Err(format!("Expected expression, found {}", token.raw)),
        }
    }

    fn postfix(&mut self, mut expression: Expr) -> Result<Expr, String> {
        let mut chain = 0;
        loop {
            chain += 1;
            if chain > 128 {
                return Err("Expression member chain exceeds 128".into());
            }
            if self.match_punct('.') {
                let token = self.advance();
                let TokenKind::Identifier(property) = token.kind else {
                    return Err("Expected property name after dot".to_string());
                };
                expression = Expr::Member(Box::new(expression), Member::Named(property));
            } else if self.match_punct('[') {
                let property = self.expression(0)?;
                self.expect_punct(']')?;
                expression =
                    Expr::Member(Box::new(expression), Member::Computed(Box::new(property)));
            } else if self.match_punct('(') {
                let mut arguments = Vec::new();
                if !self.match_punct(')') {
                    loop {
                        arguments.push(self.expression(0)?);
                        if !self.match_punct(',') {
                            self.expect_punct(')')?;
                            break;
                        }
                    }
                }
                expression = Expr::Call(Box::new(expression), arguments);
            } else {
                break;
            }
            check_ast_depth(&expression, 0)?;
        }
        Ok(expression)
    }
}

#[derive(Clone, Default)]
pub(crate) struct BasesEvaluationContext<'a> {
    pub relationships: Option<&'a super::graph::PreparedRelationships<'a>>,
    pub note: IndexMap<String, RuntimeValue>,
    pub file: BasesFile,
    pub this_file: Option<BasesFile>,
    pub files: Arc<super::files::BasesFiles>,
    pub formulas: Arc<IndexMap<String, String>>,
    pub preparsed_formulas: Option<Arc<PreparedFormulaExpressions>>,
    pub link_resolutions: Arc<BTreeMap<String, Option<String>>>,
    pub now: Option<String>,
    pub random_seed: Option<u64>,
    pub timezone: BasesTimezone,
    /// Optional semantic work ceiling used by bounded hosted execution. One
    /// unit is charged for every AST node evaluation, including nested list
    /// callbacks and formulas.
    pub work_limit: Option<usize>,
    /// Cooperative host cancellation checked at every AST node. Filesystem
    /// execution leaves this unset and uses its outer operation boundaries.
    pub cancellation: Option<OperationCancellation>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BasesFile {
    pub witness: Option<super::RecordWitness>,
    pub metadata_unavailable: bool,
    pub path: String,
    pub name: String,
    pub basename: String,
    pub folder: String,
    pub extension: String,
    pub size: Option<u64>,
    pub properties: IndexMap<String, RuntimeValue>,
    pub tags: Vec<String>,
    pub links: Vec<BasesLink>,
    pub embeds: Vec<BasesLink>,
    pub backlinks: Vec<BasesLink>,
    pub ctime: Option<String>,
    pub mtime: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct BasesLink {
    /// Original constructor data and owning note; Some("") is vault root.
    /// None is unavailable provenance, never permission to guess an origin.
    pub raw_destination: Option<String>,
    pub source_path: Option<String>,
    pub subpath: Option<String>,
    pub target: Option<super::RecordWitness>,
    pub path: String,
    pub display: Option<String>,
    pub display_value: Option<Box<RuntimeValue>>,
    pub resolved_path: Option<Option<String>>,
    pub external: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct DateValue {
    pub(crate) millis: i64,
    pub(crate) date_only: bool,
    timezone: BasesTimezone,
}

// Invocation clocks round-trip through the evaluator's RFC3339 parser, which
// accepts four-digit nonnegative years. Validate that domain before formatting
// instead of letting Evaluator::new panic on chrono's wider date range.
// File timestamps retain their separate serialization/interpretation behavior.
pub(crate) fn invocation_clock(millis: i64) -> Option<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp_millis(millis).filter(|date| (0..=9999).contains(&date.year()))
}

#[derive(Clone, Debug, Default)]
pub(crate) enum BasesTimezone {
    #[default]
    Utc,
    Fixed(FixedOffset),
    Named(Tz),
}

impl BasesTimezone {
    pub(crate) fn from_setting(value: Option<&str>) -> Result<Self, String> {
        let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(Self::Utc);
        };
        match value {
            "local" => Err("An explicit IANA timezone or UTC is required".into()),
            "UTC" | "utc" | "Z" => Ok(Self::Fixed(FixedOffset::east_opt(0).expect("UTC offset"))),
            value if value.starts_with('+') || value.starts_with('-') => {
                parse_timezone_offset(value)
                    .map(Self::Fixed)
                    .ok_or_else(|| format!("Invalid fixed timezone offset '{value}'"))
            }
            value => value
                .parse::<Tz>()
                .map(Self::Named)
                .map_err(|_| format!("Unknown IANA timezone '{value}'")),
        }
    }

    fn local_datetime(&self, millis: i64) -> NaiveDateTime {
        let utc = Utc
            .timestamp_millis_opt(millis)
            .single()
            .unwrap_or(DateTime::<Utc>::UNIX_EPOCH);
        match self {
            Self::Utc => utc.naive_utc(),
            Self::Fixed(offset) => utc.with_timezone(offset).naive_local(),
            Self::Named(timezone) => utc.with_timezone(timezone).naive_local(),
        }
    }

    fn try_millis_from_local(&self, value: NaiveDateTime) -> Option<i64> {
        match self {
            Self::Utc => Some(value.and_utc().timestamp_millis()),
            Self::Fixed(offset) => offset
                .from_local_datetime(&value)
                .single()
                .map(|date| date.timestamp_millis()),
            Self::Named(timezone) => timezone
                .from_local_datetime(&value)
                .single()
                .map(|date| date.timestamp_millis()),
        }
    }

    /// Resolve a civil midnight forward through a gap. This primitive may move
    /// across a skipped civil date; value truncation must check the date below.
    /// A deadline can additionally require the earliest strictly future instant.
    fn midnight_forward<E>(
        &self,
        date: NaiveDate,
        after: Option<i64>,
        check: &mut impl FnMut(usize) -> Result<(), E>,
    ) -> Result<Option<i64>, E> {
        check(1)?;
        let Some(midnight) = date.and_hms_opt(0, 0, 0) else {
            return Ok(None);
        };
        check(1)?;
        let candidate = match self {
            Self::Utc => Some(midnight.and_utc().timestamp_millis()),
            Self::Fixed(offset) => offset
                .from_local_datetime(&midnight)
                .single()
                .map(|instant| instant.timestamp_millis()),
            Self::Named(zone) => match zone.from_local_datetime(&midnight) {
                LocalResult::Single(instant) => Some(instant.timestamp_millis()),
                LocalResult::Ambiguous(first, second) => {
                    [first.timestamp_millis(), second.timestamp_millis()]
                        .into_iter()
                        .filter(|instant| after.is_none_or(|after| *instant > after))
                        .min()
                }
                LocalResult::None => {
                    check(1)?;
                    GapInfo::new(&midnight, zone)
                        .and_then(|gap| gap.end)
                        .map(|instant| instant.timestamp_millis())
                }
            },
        };
        check(1)?;
        Ok(candidate.filter(|instant| after.is_none_or(|after| *instant > after)))
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct DurationValue {
    years: f64,
    months: f64,
    weeks: f64,
    days: f64,
    hours: f64,
    minutes: f64,
    seconds: f64,
    milliseconds: f64,
}

#[derive(Clone, Debug)]
pub(crate) enum RuntimeValue {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    // String/List subclasses retained only inside one core invocation.
    Tag(String),
    TagList(Vec<RuntimeValue>),
    Date(DateValue),
    Duration(DurationValue),
    List(Vec<RuntimeValue>),
    Object(IndexMap<String, RuntimeValue>),
    File(Box<BasesFile>),
    Link(BasesLink),
    Regex(String, String, Arc<()>),
    Html(String),
    Image(String),
    Icon(String),
    Error(String),
    /// An already materialized Error value; unlike Error, this is not a thrown failure.
    ErrorValue(String),
}

fn error_message(encoded: &str) -> &str {
    encoded
        .split_once('\0')
        .map_or(encoded, |(_, message)| message)
}
fn returned_error(code: &str, message: &str) -> Result<RuntimeValue, ExpressionDiagnostic> {
    if ["budget", "cancelled"].contains(&code) {
        return Err(ExpressionDiagnostic::new(code, message));
    }
    Ok(RuntimeValue::ErrorValue(format!("{code}\0{message}")))
}

pub(crate) struct Session<'a> {
    evaluator: Evaluator<'a>,
    initial_steps: usize,
}
#[cfg(test)]
thread_local! { static SESSION_STARTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub(crate) fn session_starts() -> usize {
    SESSION_STARTS.get()
}

impl<'a> Session<'a> {
    pub(crate) fn new(context: &'a BasesEvaluationContext<'a>) -> Self {
        #[cfg(test)]
        SESSION_STARTS.set(SESSION_STARTS.get().saturating_add(1));
        Self {
            evaluator: Evaluator::new(context),
            initial_steps: context.work_limit.unwrap_or(100_000),
        }
    }
    pub(crate) fn charge_preparation(&mut self, work: usize) -> Result<(), ExpressionDiagnostic> {
        self.evaluator.charge(work).map_err(|value| match value {
            RuntimeValue::Error(message) => {
                let (code, text) = message.split_once('\0').unwrap_or(("budget", &message));
                ExpressionDiagnostic::new(code, text)
            }
            _ => unreachable!(),
        })
    }
    pub(crate) fn steps_used(&self) -> usize {
        self.initial_steps
            .saturating_sub(self.evaluator.remaining_work)
    }
    pub(crate) fn evaluate(&mut self, source: &str) -> Result<BaseValue, ExpressionDiagnostic> {
        self.evaluate_tagged(source, false, &mut |_| Ok(()))
            .map(|(value, _)| value)
    }
    pub(crate) fn evaluate_with_tag_shape(
        &mut self,
        source: &str,
        mut reserve: impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<(BaseValue, Option<TagShape>), ExpressionDiagnostic> {
        self.evaluate_tagged(source, true, &mut reserve)
    }
    fn evaluate_tagged(
        &mut self,
        source: &str,
        preserve_tags: bool,
        reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<(BaseValue, Option<TagShape>), ExpressionDiagnostic> {
        let ast = parse_cached(source).map_err(|message| {
            let (code, text) = message
                .split_once('\0')
                .unwrap_or(("parse", message.as_str()));
            ExpressionDiagnostic::new(code, text)
        })?;
        self.evaluator
            .admit_literals(&ast)
            .map_err(runtime_diagnostic)?;
        let value = self.evaluator.evaluate(ast.as_ref(), &BTreeMap::new());
        let shape = if preserve_tags {
            self.evaluator
                .tag_shape(&value, 0, reserve)
                .map_err(runtime_diagnostic)?
        } else {
            None
        };
        Ok((typed_result(value)?, shape))
    }
}
pub(crate) fn evaluate(
    expression: &str,
    context: &BasesEvaluationContext,
) -> Result<EvaluationResult, ExpressionDiagnostic> {
    let mut session = Session::new(context);
    let value = session.evaluate(expression)?;
    Ok(EvaluationResult {
        value,
        steps_used: session.steps_used(),
    })
}

/// Convert sealed derived values without reparsing dates or readable links.
/// No bare file can be fabricated without an immutable source record.
pub(crate) fn runtime_from_base_value(
    value: &BaseValue,
    timezone: &BasesTimezone,
) -> Result<RuntimeValue, ExpressionDiagnostic> {
    let context = BasesEvaluationContext {
        timezone: timezone.clone(),
        ..Default::default()
    };
    let mut evaluator = Evaluator::new(&context);
    let mut converted = summary_runtime_value(value, 0, &mut 0usize, &mut evaluator, &mut |_| {
        Err(ExpressionDiagnostic::new(
            "unavailable",
            "Derived file values require a snapshot record",
        ))
    })?;
    // Derived links with a witness use canonical paths supplied by the sealed
    // relation resolver. No raw Markdown link is granted target authority here.
    fn mark(value: &mut RuntimeValue) {
        match value {
            RuntimeValue::Link(link) => {
                link.resolved_path = Some(link.target.as_ref().map(|_| link.path.clone()));
                if let Some(display) = link.display_value.as_deref_mut() {
                    mark(display);
                }
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                values.iter_mut().for_each(mark)
            }
            RuntimeValue::Object(values) => values.values_mut().for_each(mark),
            _ => {}
        }
    }
    mark(&mut converted);
    Ok(converted)
}

/// Evaluate a summary with only `values` and list callback bindings in scope.
/// File values are rehydrated from the same immutable query input, never from
/// an ambient vault. Conversion work shares the expression work allowance.
pub(crate) fn evaluate_summary(
    source: &str,
    values: &[&BaseValue],
    tag_shapes: &[Option<&TagShape>],
    prepared_formulas: Option<Arc<PreparedFormulaExpressions>>,
    options: &crate::EvaluationOptions,
    relationships: Option<&super::graph::PreparedRelationships<'_>>,
    shared_files: Option<Arc<super::files::BasesFiles>>,
    mut file: impl FnMut(&str) -> Result<BasesFile, ExpressionDiagnostic>,
) -> Result<EvaluationResult, ExpressionDiagnostic> {
    let timezone = BasesTimezone::from_setting(Some(&options.timezone))
        .map_err(|message| ExpressionDiagnostic::new("input", message))?;
    let context = BasesEvaluationContext {
        relationships,
        preparsed_formulas: prepared_formulas,
        random_seed: options.random_seed,
        files: shared_files.unwrap_or_default(),
        now: Some(
            invocation_clock(options.clock_ms)
                .ok_or_else(|| {
                    ExpressionDiagnostic::new("input", "Clock or timestamp is out of range")
                })?
                .to_rfc3339(),
        ),
        timezone,
        work_limit: Some(options.max_steps),
        cancellation: options.cancellation.clone(),
        ..Default::default()
    };
    let mut evaluator = Evaluator::new(&context);
    evaluator.summary_only = true;
    let ast = parse_cached(source)
        .map_err(|message| {
            let (code, text) = message.split_once('\0').unwrap_or(("parse", &message));
            ExpressionDiagnostic::new(code, text)
        })
        .and_then(|ast| {
            evaluator
                .admit_literals(&ast)
                .map_err(runtime_diagnostic)
                .map(|()| ast)
        });
    let ast = match ast {
        Ok(ast) => ast,
        Err(error) if ["budget", "cancelled"].contains(&error.code.as_str()) => return Err(error),
        Err(error) => {
            return Ok(EvaluationResult {
                value: BaseValue::Error {
                    code: error.code,
                    message: error.message,
                },
                steps_used: options.max_steps.saturating_sub(evaluator.remaining_work),
            })
        }
    };
    let mut bytes = 0usize;
    let mut converted = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let mut value = summary_runtime_value(value, 0, &mut bytes, &mut evaluator, &mut file)?;
        if let Some(Some(shape)) = tag_shapes.get(index) {
            let restored_bytes = runtime_shape_restore_bytes(shape, &mut |work| {
                evaluator.charge(work).map_err(runtime_diagnostic)
            })?;
            bytes = bytes.saturating_add(restored_bytes);
            if bytes > 8 * 1024 * 1024 {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "Summary runtime provenance exceeds byte budget",
                ));
            }
            evaluator
                .restore_tags(&mut value, shape, 0)
                .map_err(runtime_diagnostic)?;
        }
        converted.push(value);
    }
    let scope = BTreeMap::from([("values".into(), RuntimeValue::List(converted))]);
    let value = typed_result(evaluator.evaluate(&ast, &scope));
    // Semantic failures are visible cells and still consume query work. Only
    // resource/cancellation failures reject the entire bounded query.
    let value = match value {
        Ok(value) => value,
        Err(error) if ["budget", "cancelled"].contains(&error.code.as_str()) => return Err(error),
        Err(error) => BaseValue::Error {
            code: error.code,
            message: error.message,
        },
    };
    Ok(EvaluationResult {
        value,
        steps_used: options.max_steps.saturating_sub(evaluator.remaining_work),
    })
}

/// Query grouping converts each captured key once, then reuses exactly the
/// same typed equality and stringification as ordinary core expressions.
pub(crate) fn group_runtime_from_base(
    value: &BaseValue,
    tag_shape: Option<&TagShape>,
    timezone: &BasesTimezone,
    options: &crate::EvaluationOptions,
    mut file: impl FnMut(&str) -> Result<BasesFile, ExpressionDiagnostic>,
) -> Result<(RuntimeValue, usize), ExpressionDiagnostic> {
    let context = BasesEvaluationContext {
        timezone: timezone.clone(),
        work_limit: Some(options.max_steps),
        cancellation: options.cancellation.clone(),
        ..Default::default()
    };
    let mut evaluator = Evaluator::new(&context);
    let mut bytes = 0usize;
    let mut value = summary_runtime_value(value, 0, &mut bytes, &mut evaluator, &mut file)?;
    if let Some(shape) = tag_shape {
        let restored_bytes = runtime_shape_restore_bytes(shape, &mut |work| {
            evaluator.charge(work).map_err(runtime_diagnostic)
        })?;
        if bytes.saturating_add(restored_bytes) > 8 * 1024 * 1024 {
            return Err(ExpressionDiagnostic::new(
                "budget",
                "Group runtime provenance exceeds byte budget",
            ));
        }
        evaluator
            .restore_tags(&mut value, shape, 0)
            .map_err(runtime_diagnostic)?;
    }
    Ok((
        value,
        options.max_steps.saturating_sub(evaluator.remaining_work),
    ))
}
fn group_comparison_work(
    value: &RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<(), ExpressionDiagnostic> {
    check(1)?;
    match value {
        RuntimeValue::String(value)
        | RuntimeValue::Tag(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Image(value)
        | RuntimeValue::Icon(value)
        | RuntimeValue::Error(value)
        | RuntimeValue::ErrorValue(value) => check(value.len() / 16)?,
        RuntimeValue::Link(link) => check(
            link.path
                .len()
                .saturating_add(link.display.as_ref().map_or(0, String::len))
                .saturating_add(link.subpath.as_ref().map_or(0, String::len))
                .saturating_add(
                    link.resolved_path
                        .as_ref()
                        .and_then(Option::as_ref)
                        .map_or(0, String::len),
                )
                / 16,
        )?,
        RuntimeValue::File(file) => check(file.path.len() / 16)?,
        RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
            for value in values {
                group_comparison_work(value, check)?
            }
        }
        RuntimeValue::Object(values) => {
            for (key, value) in values {
                check(key.len() / 16)?;
                group_comparison_work(value, check)?
            }
        }
        _ => {}
    }
    Ok(())
}
pub(crate) fn group_values_match(
    key: &RuntimeValue,
    value: &RuntimeValue,
    manual: bool,
    timezone: &BasesTimezone,
    relationships: Option<&super::graph::PreparedRelationships<'_>>,
    options: &crate::EvaluationOptions,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<bool, ExpressionDiagnostic> {
    group_comparison_work(key, check)?;
    group_comparison_work(value, check)?;
    let context = BasesEvaluationContext {
        timezone: timezone.clone(),
        now: Some(invocation_clock(options.clock_ms)
            .ok_or_else(|| ExpressionDiagnostic::new("input", "Invocation clock is out of range"))?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        relationships,
        work_limit: Some(options.max_steps),
        cancellation: options.cancellation.clone(),
        ..Default::default()
    };
    let mut evaluator = Evaluator::new(&context);
    let equal = evaluator.equals_checked(key, value);
    check(options.max_steps.saturating_sub(evaluator.remaining_work))?;
    let equal = equal.map_err(|error| match error {
        RuntimeValue::Error(message) => {
            let (code, text) = message.split_once('\0').unwrap_or(("evaluation", &message));
            ExpressionDiagnostic::new(code, text)
        }
        _ => unreachable!("comparison errors are diagnostics"),
    })?;
    Ok(equal || manual && matches!(key,RuntimeValue::String(key) if key==&stringify(value)))
}
pub(crate) fn group_value_string(
    value: &RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<String, ExpressionDiagnostic> {
    group_comparison_work(value, check)?;
    Ok(stringify(value))
}

fn summary_runtime_value(
    value: &BaseValue,
    depth: usize,
    bytes: &mut usize,
    evaluator: &mut Evaluator<'_>,
    file: &mut impl FnMut(&str) -> Result<BasesFile, ExpressionDiagnostic>,
) -> Result<RuntimeValue, ExpressionDiagnostic> {
    if depth > 128 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Summary values exceed depth budget",
        ));
    }
    evaluator.charge(1).map_err(|value| match value {
        RuntimeValue::Error(message) => {
            let (code, text) = message.split_once('\0').unwrap_or(("budget", &message));
            ExpressionDiagnostic::new(code, text)
        }
        _ => unreachable!("charge errors are diagnostics"),
    })?;
    *bytes = bytes.saturating_add(64);
    let result = match value {
        BaseValue::Null => RuntimeValue::Null,
        BaseValue::Boolean { value } => RuntimeValue::Bool(*value),
        BaseValue::Number { value } => RuntimeValue::Number(*value),
        BaseValue::String { value } => {
            *bytes = bytes.saturating_add(value.len());
            RuntimeValue::String(value.clone())
        }
        BaseValue::List { value } => RuntimeValue::List(
            value
                .iter()
                .map(|value| summary_runtime_value(value, depth + 1, bytes, evaluator, file))
                .collect::<Result<_, _>>()?,
        ),
        BaseValue::Object { value } => {
            let mut result = IndexMap::new();
            for (key, value) in value {
                *bytes = bytes.saturating_add(key.len());
                result.insert(
                    key.clone(),
                    summary_runtime_value(value, depth + 1, bytes, evaluator, file)?,
                );
            }
            RuntimeValue::Object(result)
        }
        BaseValue::Date {
            timestamp,
            has_time,
        } => RuntimeValue::Date(DateValue {
            millis: *timestamp,
            date_only: !has_time,
            timezone: evaluator.timezone.clone(),
        }),
        BaseValue::Duration {
            years,
            months,
            weeks,
            days,
            hours,
            minutes,
            seconds,
            milliseconds,
        } => RuntimeValue::Duration(DurationValue {
            years: *years,
            months: *months,
            weeks: *weeks,
            days: *days,
            hours: *hours,
            minutes: *minutes,
            seconds: *seconds,
            milliseconds: *milliseconds,
        }),
        BaseValue::File { path } => {
            // Admission precedes this clone in the query reducer.
            let hydrated = RuntimeValue::File(Box::new(file(path)?));
            *bytes = bytes.saturating_add(value_bytes(&hydrated).unwrap_or(usize::MAX));
            hydrated
        }
        BaseValue::Link {
            path,
            subpath,
            target,
            display,
            display_value,
            external,
        } => {
            *bytes = bytes.saturating_add(
                path.len()
                    + subpath.as_ref().map_or(0, String::len)
                    + display.as_ref().map_or(0, String::len),
            );
            RuntimeValue::Link(BasesLink {
                path: path.clone(),
                subpath: subpath.clone(),
                target: target.clone(),
                display: display.clone(),
                display_value: display_value
                    .as_deref()
                    .map(|value| {
                        summary_runtime_value(value, depth + 1, bytes, evaluator, file)
                            .map(Box::new)
                    })
                    .transpose()?,
                external: *external,
                resolved_path: target
                    .as_ref()
                    .and_then(|witness| evaluator.context.files.by_witness(witness))
                    .map(|file| Some(file.path.clone())),
                ..Default::default()
            })
        }
        BaseValue::Html { value } => {
            *bytes = bytes.saturating_add(value.len());
            RuntimeValue::Html(value.clone())
        }
        BaseValue::Image { value } => {
            *bytes = bytes.saturating_add(value.len());
            RuntimeValue::Image(value.clone())
        }
        BaseValue::Icon { value } => {
            *bytes = bytes.saturating_add(value.len());
            RuntimeValue::Icon(value.clone())
        }
        BaseValue::Error { code, message } => {
            *bytes = bytes.saturating_add(code.len() + message.len());
            returned_error(code, message)?
        }
    };
    let allocated = value_bytes(&result).unwrap_or(usize::MAX);
    if *bytes > 8 * 1024 * 1024 || allocated > 8 * 1024 * 1024 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Summary values exceed byte budget",
        ));
    }
    Ok(result)
}

/// Validation without a host context still has a finite construction budget.
/// Planning helpers intentionally keep using syntax-only parse_cached instead.
pub(crate) fn validate(expression: &str) -> Result<(), String> {
    let mut remaining = crate::MAX_EXPRESSION_STEPS;
    validate_checked(expression, &mut |work| {
        remaining = remaining.checked_sub(work).ok_or_else(|| {
            RuntimeValue::Error("budget\0Regex validation exceeds work budget".into())
        })?;
        Ok(())
    })
    .map_err(|error| match error {
        RuntimeValue::Error(message) => message,
        _ => unreachable!(),
    })
}

pub(crate) fn validate_checked(
    expression: &str,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<(), RuntimeValue> {
    // Check cancellation before even a warm optional syntax-cache lookup.
    check(expression.len() / 16 + 1)?;
    let ast = parse_cached(expression).map_err(|message| {
        RuntimeValue::Error(if message.contains('\0') {
            message
        } else {
            format!("parse\0{message}")
        })
    })?;
    regex_admission::admit(&ast, check)
}

pub(crate) fn matches(expression: &str, context: &BasesEvaluationContext) -> Result<bool, String> {
    let ast = parse_cached(expression)?;
    let mut evaluator = Evaluator::new(context);
    evaluator
        .admit_literals(&ast)
        .map_err(|error| match error {
            RuntimeValue::Error(message) => message,
            _ => unreachable!(),
        })?;
    match evaluator.evaluate(ast.as_ref(), &BTreeMap::new()) {
        RuntimeValue::Error(message) => Err(message),
        value => Ok(is_truthy(&value)),
    }
}

/// Query-owned definitions retain literal object identity across rows even if
/// unrelated syntax evicts every entry in the optional process cache.
#[derive(Default)]
pub(crate) struct PreparedFormulaExpressions {
    expressions: IndexMap<String, (String, Result<Arc<Expr>, String>)>,
}
pub(crate) fn prepare_formula_expressions(
    formulas: &[(String, String)],
    reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<Arc<PreparedFormulaExpressions>, RuntimeValue> {
    check(1)?;
    // The admitted source/program owns the existing bounded parser/cache
    // construction. This seam separately admits the new retained map and AST
    // references, not a speculative per-character parser allocation bound.
    let slots = formulas
        .len()
        .max(1)
        .checked_next_power_of_two()
        .ok_or_else(|| RuntimeValue::Error("budget\0Formula map capacity overflow".into()))?;
    let bytes = slots.saturating_mul(2).saturating_mul(
        std::mem::size_of::<(String, String, Result<Arc<Expr>, String>)>()
            + 2 * std::mem::size_of::<usize>(),
    );
    reserve(bytes.saturating_add(
        std::mem::size_of::<PreparedFormulaExpressions>() + 2 * std::mem::size_of::<usize>(),
    ))?;
    let mut expressions = IndexMap::with_capacity(formulas.len());
    for (name, source) in formulas {
        check(name.len() / 16 + source.len() / 16 + 1)?;
        reserve(name.len().saturating_add(source.len()))?;
        let parsed = parse_cached_scoped(source, Some(name));
        let parsed = match parsed {
            Ok(ast) => match regex_admission::admit(&ast, check) {
                Ok(()) => Ok(ast),
                Err(RuntimeValue::Error(message))
                    if message.starts_with("budget\0") || message.starts_with("cancelled\0") =>
                {
                    return Err(RuntimeValue::Error(message))
                }
                Err(RuntimeValue::Error(message)) => Err(message),
                Err(_) => unreachable!(),
            },
            Err(message) => Err(message),
        };
        let retained = match &parsed {
            Ok(ast) => ast_retained_bytes(ast, check)?,
            Err(message) => {
                check(message.len() / 16 + 1)?;
                message.capacity()
            }
        };
        reserve(retained)?;
        expressions.insert(name.clone(), (source.clone(), parsed));
    }
    Ok(Arc::new(PreparedFormulaExpressions { expressions }))
}

fn ast_retained_bytes(
    expression: &Expr,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<usize, RuntimeValue> {
    fn visit(
        expression: &Expr,
        depth: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<usize, RuntimeValue> {
        check(1)?;
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Formula AST retention depth exceeds128".into(),
            ));
        }
        let mut bytes = std::mem::size_of::<Expr>();
        let mut text = |value: &String| -> Result<usize, RuntimeValue> {
            check(value.len() / 16 + 1)?;
            Ok(value.capacity())
        };
        match expression {
            Expr::Literal(Value::String(value)) | Expr::Identifier(value) => {
                bytes = bytes.saturating_add(text(value)?)
            }
            Expr::Regex(pattern, flags, _) => {
                bytes = bytes
                    .saturating_add(text(pattern)?)
                    .saturating_add(text(flags)?)
                    .saturating_add(2 * std::mem::size_of::<usize>())
            }
            Expr::Unary(operator, value) => {
                bytes = bytes.saturating_add(text(operator)?);
                bytes = bytes.saturating_add(visit(value, depth + 1, check)?);
            }
            Expr::Binary(operator, left, right) => {
                bytes = bytes.saturating_add(text(operator)?);
                bytes = bytes
                    .saturating_add(visit(left, depth + 1, check)?)
                    .saturating_add(visit(right, depth + 1, check)?);
            }
            Expr::Array(values) => {
                bytes = bytes.saturating_add(
                    (values.capacity() - values.len()).saturating_mul(std::mem::size_of::<Expr>()),
                );
                for value in values {
                    bytes = bytes.saturating_add(visit(value, depth + 1, check)?);
                }
            }
            Expr::Call(callee, values) => {
                bytes = bytes
                    .saturating_add(visit(callee, depth + 1, check)?)
                    .saturating_add(
                        (values.capacity() - values.len())
                            .saturating_mul(std::mem::size_of::<Expr>()),
                    );
                for value in values {
                    bytes = bytes.saturating_add(visit(value, depth + 1, check)?);
                }
            }
            Expr::Member(object, member) => {
                bytes = bytes.saturating_add(visit(object, depth + 1, check)?);
                bytes = bytes.saturating_add(match member {
                    Member::Named(name) => {
                        check(name.len() / 16 + 1)?;
                        name.capacity()
                    }
                    Member::Computed(value) => visit(value, depth + 1, check)?,
                });
            }
            Expr::Literal(_) => {}
        }
        if bytes > 8 * 1024 * 1024 {
            return Err(RuntimeValue::Error(
                "budget\0Formula AST retention exceeds byte budget".into(),
            ));
        }
        Ok(bytes)
    }
    Ok(visit(expression, 0, check)?.saturating_add(2 * std::mem::size_of::<usize>()))
}
fn parse_cached(expression: &str) -> Result<Arc<Expr>, String> {
    parse_cached_scoped(expression, None)
}
fn parse_cached_scoped(expression: &str, formula: Option<&str>) -> Result<Arc<Expr>, String> {
    if expression.len() > 65_536 {
        return Err("Expression exceeds 65536 bytes".into());
    }
    if expression.trim().is_empty() {
        return Ok(Arc::new(Expr::Literal(Value::Null)));
    }
    if formula.is_some_and(|name| name.len() > 65_536) {
        return Err("Formula name exceeds 65536 bytes".into());
    }
    // <=8 MiB of source/name keys plus bounded ASTs. None is the direct
    // expression namespace; each formula name owns a distinct literal wrapper.
    // Sharing between separate queries is unobservable to their private IDs.
    const MAX_ENTRIES: usize = 64;
    type CacheKey = (String, Option<String>);
    static CACHE: OnceLock<RwLock<HashMap<CacheKey, Arc<Expr>>>> = OnceLock::new();
    let key = (expression.to_string(), formula.map(str::to_string));
    let cache = CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    if let Ok(cache) = cache.read() {
        if let Some(ast) = cache.get(&key) {
            return Ok(ast.clone());
        }
    }
    let ast = Arc::new(Parser::parse(expression)?);
    if let Ok(mut cache) = cache.write() {
        if cache.len() >= MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(key, ast.clone());
    }
    Ok(ast)
}

/// Return whether an Obsidian Bases expression requires the collection
/// relationship graph or link-resolution namespace. This intentionally walks
/// the parsed syntax tree rather than searching source text, so string
/// literals and similarly named frontmatter fields do not create false
/// dependencies.
/// Whether a filter actually reads the contextual `this` binding. A property
/// named `this` and text containing the word do not require an ambient record.
pub(crate) fn uses_current_context(source: &str) -> bool {
    fn reads(expression: &Expr) -> bool {
        match expression {
            Expr::Identifier(name) => name.eq_ignore_ascii_case("this"),
            Expr::Literal(_) | Expr::Regex(_, _, _) => false,
            Expr::Array(values) => values.iter().any(reads),
            Expr::Unary(_, value) => reads(value),
            Expr::Binary(_, left, right) => reads(left) || reads(right),
            Expr::Member(object, member) => {
                reads(object) || matches!(member, Member::Computed(key) if reads(key))
            }
            Expr::Call(callee, arguments) => reads(callee) || arguments.iter().any(reads),
        }
    }
    parse_cached(source).is_ok_and(|expression| reads(&expression))
}

pub(crate) fn uses_relationships(expression: &str) -> bool {
    parse_cached(expression)
        .map(|expression| expression_uses_relationships(expression.as_ref()))
        // Validation normally rejects parse failures before planning. Treat
        // any exceptional accepted syntax conservatively so hosted execution
        // cannot select a projection-only path without proving independence.
        .unwrap_or(true)
}

/// Return whether an expression reads the filesystem creation/change time.
/// Hosted authorities do not possess a portable canonical ctime, so planning
/// must reject this dependency rather than silently evaluating it as null.
pub(crate) fn uses_file_ctime(expression: &str) -> bool {
    parse_cached(expression)
        .map(|expression| expression_uses_file_ctime(expression.as_ref()))
        .unwrap_or(true)
}

/// Return whether an expression can read backlinks. Unknown computed members
/// are classified conservatively because their runtime name can depend on the
/// current row and therefore cannot prove graph independence during planning.
pub(crate) fn uses_backlinks(expression: &str) -> bool {
    parse_cached(expression)
        .map(|expression| expression_uses_backlinks(expression.as_ref()))
        .unwrap_or(true)
}

// Conservative proof for optional answer reuse. Refuse every call, including
// computed/unknown dispatch. This exhaustive match must be updated deliberately
// when syntax grows; it never treats an unparsed expression as independent.
pub(crate) fn clock_independent(source: &str, check: &mut impl FnMut(usize) -> Option<()>) -> bool {
    fn walk(expression: &Expr, check: &mut impl FnMut(usize) -> Option<()>) -> Option<()> {
        check(1)?;
        match expression {
            Expr::Literal(_) | Expr::Regex(_, _, _) | Expr::Identifier(_) => Some(()),
            Expr::Array(values) => {
                for value in values {
                    walk(value, check)?;
                }
                Some(())
            }
            Expr::Unary(_, value) => walk(value, check),
            Expr::Binary(_, left, right) => {
                walk(left, check)?;
                walk(right, check)
            }
            Expr::Member(value, member) => {
                walk(value, check)?;
                match member {
                    Member::Named(_) => Some(()),
                    Member::Computed(value) => walk(value, check),
                }
            }
            Expr::Call(_, _) => None,
        }
    }
    if check(1usize.saturating_add(source.len() / 64)).is_none() {
        return false;
    }
    parse_cached(source)
        .ok()
        .is_some_and(|ast| walk(&ast, check).is_some()
            && duration_dependency::reads_clock(&ast, check) == Some(false))
}

/// Refresh scheduling is separate from the stricter optional-answer reuse proof
/// above. Known pure calls inherit their operands; an unknown dispatch or an
/// incomplete proof conservatively needs an instant refresh.
pub(crate) fn clock_dependency(
    source: &str,
    check: &mut impl FnMut(usize) -> Option<()>,
) -> crate::query::BaseClockDependency {
    use crate::query::BaseClockDependency as Dependency;
    fn values(
        expressions: &[Expr],
        check: &mut impl FnMut(usize) -> Option<()>,
    ) -> Option<Dependency> {
        let mut result = Dependency::None;
        for expression in expressions {
            result = result.join(walk(expression, check)?);
            if result == Dependency::Instant {
                break;
            }
        }
        Some(result)
    }
    fn walk(expression: &Expr, check: &mut impl FnMut(usize) -> Option<()>) -> Option<Dependency> {
        check(1)?;
        match expression {
            Expr::Literal(_) | Expr::Regex(_, _, _) | Expr::Identifier(_) => Some(Dependency::None),
            Expr::Array(children) => values(children, check),
            Expr::Unary(_, child) => walk(child, check),
            Expr::Binary(_, left, right) => Some(walk(left, check)?.join(walk(right, check)?)),
            Expr::Member(object, member) => {
                let object = walk(object, check)?;
                Some(match member {
                    Member::Named(_) => object,
                    Member::Computed(key) => object.join(walk(key, check)?),
                })
            }
            Expr::Call(callee, arguments) => {
                let callee = match callee.as_ref() {
                    Expr::Identifier(name) => match canonical_function_name(name) {
                        "now" => Dependency::Instant,
                        "today" => Dependency::Day,
                        "if" | "escapeHTML" | "date" | "duration" | "list" | "max" | "min"
                        | "number" | "file" | "link" | "html" | "image" | "icon" | "random" => {
                            Dependency::None
                        }
                        _ => Dependency::Instant,
                    },
                    Expr::Member(receiver, Member::Named(method)) => {
                        let own = match canonical_function_name(method) {
                            // The receiver may be a Date at runtime; relative
                            // reads the invocation clock even for a static date.
                            "relative" => Dependency::Instant,
                            "isTruthy" | "isEmpty" | "toString" | "isType" | "contains"
                            | "containsAll" | "containsAny" | "endsWith" | "lower" | "replace"
                            | "repeat" | "reverse" | "slice" | "split" | "startsWith" | "title"
                            | "trim" | "abs" | "ceil" | "floor" | "round" | "toFixed" | "date"
                            | "format" | "time" | "filter" | "flat" | "join" | "map" | "reduce"
                            | "sort" | "unique" | "sum" | "mean" | "min" | "max" | "median"
                            | "stddev" | "earliest" | "latest" | "keys" | "values" | "matches"
                            | "hasLink" | "asLink" | "asFile" | "linksTo" | "hasProperty"
                            | "hasTag" | "inFolder" => Dependency::None,
                            _ => Dependency::Instant,
                        };
                        own.join(walk(receiver, check)?)
                    }
                    // Computed calls are not supported dispatch today. Do not
                    // let a future dispatch expansion silently prove them pure.
                    _ => Dependency::Instant,
                };
                if callee == Dependency::Instant {
                    Some(callee)
                } else {
                    Some(callee.join(values(arguments, check)?))
                }
            }
        }
    }
    if check(1usize.saturating_add(source.len() / 64)).is_none() {
        return Dependency::Instant;
    }
    parse_cached(source)
        .ok()
        .and_then(|ast| {
            let dependency = walk(&ast, check)?;
            Some(if duration_dependency::reads_clock(&ast, check)? {Dependency::Instant} else {dependency})
        })
        .unwrap_or(Dependency::Instant)
}

/// Pure one-shot scheduling advice for the same captured invocation context.
/// Invalid time input remains unavailable advice, preserving the established
/// lazy validation behavior of queries which never evaluate a row.
pub(crate) fn refresh_deadline(
    dependency: crate::query::BaseClockDependency,
    clock_ms: i64,
    timezone: &str,
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<Option<(String, Option<i64>)>, ExpressionDiagnostic> {
    use crate::query::BaseClockDependency as Dependency;
    check(1usize.saturating_add(timezone.len() / 64))?;
    let Some(clock) = invocation_clock(clock_ms) else {
        return Ok(None);
    };
    check(1)?;
    let Ok(zone) = BasesTimezone::from_setting(Some(timezone)) else {
        return Ok(None);
    };
    let next = match dependency {
        Dependency::None => None,
        // This is the visible-view refresh cadence, not a claim that arbitrary
        // clock expressions change only once per second.
        Dependency::Instant => {
            check(1)?;
            clock_ms
                .checked_add(1_000)
                .filter(|next| invocation_clock(*next).is_some())
        }
        Dependency::Day => {
            check(1)?;
            let date = match &zone {
                BasesTimezone::Utc => clock.naive_utc().date(),
                BasesTimezone::Fixed(offset) => clock.with_timezone(offset).date_naive(),
                BasesTimezone::Named(zone) => clock.with_timezone(zone).date_naive(),
            };
            match date.succ_opt() {
                None => None,
                Some(next_date) => {
                    // Unlike a value truncation, a wake may cross a skipped
                    // civil date to the first valid instant after the gap.
                    let candidate = zone.midnight_forward(next_date, Some(clock_ms), check)?;
                    check(1)?;
                    candidate.filter(|next| invocation_clock(*next).is_some())
                }
            }
        }
    };
    let canonical = match &zone {
        BasesTimezone::Utc => {
            check(1)?;
            "UTC".to_owned()
        }
        BasesTimezone::Fixed(offset) if offset.local_minus_utc() == 0 => {
            check(1)?;
            "UTC".to_owned()
        }
        BasesTimezone::Fixed(offset) => {
            check(1)?; // Checked input components yield a short minute offset.
            offset.to_string()
        }
        BasesTimezone::Named(zone) => {
            check(1usize.saturating_add(zone.name().len() / 64))?;
            zone.name().to_owned()
        }
    };
    Ok(Some((canonical, next)))
}

#[cfg(test)]
mod refresh_hint_tests {
    use super::*;
    use crate::query::BaseClockDependency as Dependency;

    fn millis(instant: &str) -> i64 {
        DateTime::parse_from_rfc3339(instant)
            .unwrap()
            .timestamp_millis()
    }
    fn deadline(dependency: Dependency, instant: &str, zone: &str) -> (String, Option<i64>) {
        refresh_deadline(dependency, millis(instant), zone, &mut |_| Ok(()))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn refresh_dependencies_distinguish_known_pure_calls_and_real_clock_reads() {
        for source in [
            "file.name.lower().contains('note')",
            "number('2') + max(3, 4)",
            "date('2024-01-01').format('YYYY-MM-DD')",
            "duration('1 month')",
            "[1, 2].map(value * 2).sum()",
            "if(note.ready, note.name.trim(), 'today()')",
            "formula[note.selected]",
            "note['now()']",
        ] {
            assert_eq!(
                clock_dependency(source, &mut |_| Some(())),
                Dependency::None,
                "{source}"
            );
        }
        for source in [
            "today()",
            "TODAY()",
            "today().format('YYYY-MM-DD')",
            "if(note.ready, today(), null)",
        ] {
            assert_eq!(
                clock_dependency(source, &mut |_| Some(())),
                Dependency::Day,
                "{source}"
            );
        }
        for source in [
            "now()",
            "today() + now()",
            "date('2024-01-01').relative()",
            "[1].map(now())",
            "formula['clock']()",
            "note['lower']()",
            "unknown()",
        ] {
            assert_eq!(
                clock_dependency(source, &mut |_| Some(())),
                Dependency::Instant,
                "{source}"
            );
        }
        assert_eq!(clock_dependency("1", &mut |_| None), Dependency::Instant);
        assert_eq!(
            clock_dependency("(", &mut |_| Some(())),
            Dependency::Instant
        );
        // Do not weaken the independent optional-answer reuse proof.
        assert!(!clock_independent("number('2')", &mut |_| Some(())));
    }

    #[test]
    fn civil_day_deadlines_handle_short_long_and_non_hour_days() {
        for (clock, zone, expected, hours) in [
            (
                "2024-03-10T05:00:00Z",
                "America/Toronto",
                "2024-03-11T04:00:00Z",
                23.0,
            ),
            (
                "2024-11-03T04:00:00Z",
                "America/Toronto",
                "2024-11-04T05:00:00Z",
                25.0,
            ),
            (
                "2024-10-05T13:30:00Z",
                "Australia/Lord_Howe",
                "2024-10-06T13:00:00Z",
                23.5,
            ),
        ] {
            let (selected, next) = deadline(Dependency::Day, clock, zone);
            assert_eq!(selected, zone);
            assert_eq!(next, Some(millis(expected)));
            assert_eq!(next.unwrap() - millis(clock), (hours * 3_600_000.0) as i64);
        }
    }

    #[test]
    fn civil_day_deadlines_use_gap_end_and_earliest_midnight_fold() {
        for (clock, zone, expected) in [
            // Local midnight does not exist: first valid local time is01:00.
            (
                "2018-11-03T15:00:00Z",
                "America/Sao_Paulo",
                "2018-11-04T03:00:00Z",
            ),
            // The entire next civil date was skipped when the date line moved.
            (
                "2011-12-29T12:00:00Z",
                "Pacific/Apia",
                "2011-12-30T10:00:00Z",
            ),
            // Local midnight repeats; select the first future occurrence.
            (
                "2024-11-02T12:00:00Z",
                "America/Havana",
                "2024-11-03T04:00:00Z",
            ),
        ] {
            assert_eq!(
                deadline(Dependency::Day, clock, zone).1,
                Some(millis(expected))
            );
        }
    }

    #[test]
    fn deadline_capture_canonicalizes_zones_and_preserves_invalid_lazy_inputs() {
        let clock = "2024-01-01T00:00:00Z";
        for zone in ["", " UTC ", "utc", "Z", "+00:00", "-00:00"] {
            assert_eq!(
                deadline(Dependency::None, clock, zone),
                ("UTC".into(), None)
            );
        }
        assert_eq!(
            deadline(Dependency::Day, clock, "+05:30"),
            ("+05:30".into(), Some(millis("2024-01-01T18:30:00Z")))
        );
        assert_eq!(
            deadline(Dependency::Instant, clock, "UTC").1,
            Some(millis(clock) + 1_000)
        );
        for zone in ["local", "unknown/timezone", "+2147483647:00"] {
            assert!(
                refresh_deadline(Dependency::Day, millis(clock), zone, &mut |_| Ok(()))
                    .unwrap()
                    .is_none()
            );
        }
        assert!(
            refresh_deadline(Dependency::None, i64::MAX, "UTC", &mut |_| Ok(()))
                .unwrap()
                .is_none()
        );
        for dependency in [Dependency::Day, Dependency::Instant] {
            assert_eq!(
                deadline(dependency, "9999-12-31T23:59:59.999Z", "UTC").1,
                None
            );
        }
        let cancelled = refresh_deadline(Dependency::Day, millis(clock), "UTC", &mut |_| {
            Err(ExpressionDiagnostic::new("cancelled", "stop"))
        })
        .unwrap_err();
        assert_eq!(cancelled.code, "cancelled");
    }
}

fn constant_member_name(expression: &Expr) -> Option<String> {
    match expression {
        Expr::Literal(Value::String(value)) => Some(value.clone()),
        Expr::Binary(operator, left, right) if operator == "+" => {
            let mut value = constant_member_name(left)?;
            value.push_str(&constant_member_name(right)?);
            Some(value)
        }
        _ => None,
    }
}

fn member_maybe_matches(member: &Member, expected: &[&str]) -> bool {
    match member {
        Member::Named(name) => expected
            .iter()
            .any(|expected| name.eq_ignore_ascii_case(expected)),
        Member::Computed(value) => constant_member_name(value).is_none_or(|name| {
            expected
                .iter()
                .any(|expected| name.eq_ignore_ascii_case(expected))
        }),
    }
}

fn expression_uses_file_ctime(expression: &Expr) -> bool {
    match expression {
        Expr::Literal(_) | Expr::Regex(_, _, _) | Expr::Identifier(_) => false,
        Expr::Array(values) => values.iter().any(expression_uses_file_ctime),
        Expr::Unary(_, value) => expression_uses_file_ctime(value),
        Expr::Binary(_, left, right) => {
            expression_uses_file_ctime(left) || expression_uses_file_ctime(right)
        }
        Expr::Member(object, member) => {
            let ctime_member = matches!(object.as_ref(), Expr::Identifier(namespace) if namespace.eq_ignore_ascii_case("file"))
                && member_maybe_matches(member, &["ctime"]);
            ctime_member
                || expression_uses_file_ctime(object)
                || matches!(member, Member::Computed(value) if expression_uses_file_ctime(value))
        }
        Expr::Call(callee, arguments) => {
            expression_uses_file_ctime(callee) || arguments.iter().any(expression_uses_file_ctime)
        }
    }
}

fn expression_uses_relationships(expression: &Expr) -> bool {
    match expression {
        Expr::Literal(_) | Expr::Regex(_, _, _) | Expr::Identifier(_) => false,
        Expr::Array(values) => values.iter().any(expression_uses_relationships),
        Expr::Unary(_, value) => expression_uses_relationships(value),
        Expr::Binary(_, left, right) => {
            expression_uses_relationships(left) || expression_uses_relationships(right)
        }
        Expr::Member(object, member) => {
            let relationship_member = member_maybe_matches(
                member,
                &[
                    "links",
                    "embeds",
                    "backlinks",
                    "hasLink",
                    "asFile",
                    "asLink",
                    "linksTo",
                ],
            );
            relationship_member
                || expression_uses_relationships(object)
                || matches!(member, Member::Computed(value) if expression_uses_relationships(value))
        }
        Expr::Call(callee, arguments) => {
            let relationship_call = match callee.as_ref() {
                Expr::Identifier(name) => {
                    matches!(canonical_function_name(name), "file" | "link" | "image")
                }
                Expr::Member(_, Member::Named(name)) => {
                    matches!(
                        canonical_function_name(name),
                        "hasLink" | "asFile" | "asLink" | "linksTo"
                    )
                }
                _ => false,
            };
            relationship_call
                || expression_uses_relationships(callee)
                || arguments.iter().any(expression_uses_relationships)
        }
    }
}

fn expression_uses_backlinks(expression: &Expr) -> bool {
    match expression {
        Expr::Literal(_) | Expr::Regex(_, _, _) | Expr::Identifier(_) => false,
        Expr::Array(values) => values.iter().any(expression_uses_backlinks),
        Expr::Unary(_, value) => expression_uses_backlinks(value),
        Expr::Binary(_, left, right) => {
            expression_uses_backlinks(left) || expression_uses_backlinks(right)
        }
        Expr::Member(object, member) => {
            member_maybe_matches(member, &["backlinks"])
                || expression_uses_backlinks(object)
                || matches!(member, Member::Computed(value) if expression_uses_backlinks(value))
        }
        Expr::Call(callee, arguments) => {
            expression_uses_backlinks(callee) || arguments.iter().any(expression_uses_backlinks)
        }
    }
}

struct Evaluator<'a> {
    context: &'a BasesEvaluationContext<'a>,
    now: DateValue,
    timezone: BasesTimezone,
    formula_cache: HashMap<String, RuntimeValue>,
    formula_stack: HashSet<String>,
    remaining_work: usize,
    summary_only: bool,
    random_state: u64,
}

pub(crate) const BASES_WORK_BUDGET_EXCEEDED: &str = "Obsidian Base expression work budget exceeded";
pub(crate) const BASES_OPERATION_CANCELLED: &str = "Obsidian Base expression evaluation cancelled";

type Scope = BTreeMap<String, RuntimeValue>;

fn canonical_function_name(name: &str) -> &str {
    const NAMES: &[&str] = &[
        "if",
        "escapeHTML",
        "date",
        "duration",
        "file",
        "html",
        "image",
        "icon",
        "link",
        "list",
        "max",
        "min",
        "now",
        "number",
        "today",
        "random",
        "isTruthy",
        "isEmpty",
        "toString",
        "isType",
        "contains",
        "containsAll",
        "containsAny",
        "endsWith",
        "lower",
        "replace",
        "repeat",
        "reverse",
        "slice",
        "split",
        "startsWith",
        "title",
        "trim",
        "abs",
        "ceil",
        "floor",
        "round",
        "toFixed",
        "format",
        "time",
        "relative",
        "filter",
        "flat",
        "join",
        "map",
        "reduce",
        "sort",
        "unique",
        "sum",
        "mean",
        "median",
        "stddev",
        "earliest",
        "latest",
        "keys",
        "values",
        "matches",
        "hasLink",
        "asLink",
        "asFile",
        "linksTo",
        "hasProperty",
        "hasTag",
        "inFolder",
    ];
    NAMES
        .iter()
        .find(|candidate| candidate.eq_ignore_ascii_case(name))
        .copied()
        .unwrap_or(name)
}

pub(crate) fn runtime_diagnostic(value: RuntimeValue) -> ExpressionDiagnostic {
    let RuntimeValue::Error(message) = value else {
        unreachable!()
    };
    let (code, text) = message.split_once('\0').unwrap_or(("type", &message));
    ExpressionDiagnostic::new(code, text)
}
fn arity_error(name: &str, expected: usize) -> RuntimeValue {
    RuntimeValue::Error(format!(
        "arity\0{name} expects exactly {expected} argument(s)"
    ))
}
fn tag_text(value: &str) -> String {
    if value.starts_with('#') {
        value.into()
    } else {
        format!("#{value}")
    }
}
fn tag_matches(tag: &str, query: &str) -> bool {
    let tag = tag.to_lowercase();
    let query = tag_text(query).to_lowercase();
    tag.starts_with(&query)
        && (tag.len() == query.len() || tag.as_bytes().get(query.len()) == Some(&b'/'))
}

fn string_data(value: &RuntimeValue) -> Option<&str> {
    match value {
        RuntimeValue::String(value)
        | RuntimeValue::Tag(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Image(value)
        | RuntimeValue::Icon(value) => Some(value),
        RuntimeValue::Link(link) => Some(&link.path),
        _ => None,
    }
}

fn seeded_row_state(context: &BasesEvaluationContext<'_>) -> u64 {
    let mut state = context.random_seed.unwrap_or(0) ^ 0xcbf29ce484222325;
    let mut mix = |byte: u8| {
        state ^= u64::from(byte);
        state = state.wrapping_mul(0x100000001b3);
    };
    if let Some(witness) = &context.file.witness {
        // Opaque IDs are bounded ASCII. The separator cannot occur in either
        // token; hashing never depends on Debug formatting or platform layout.
        witness.entry_id.as_str().bytes().for_each(&mut mix);
        mix(0);
        witness.revision.as_str().bytes().for_each(&mut mix);
    } else {
        context.file.path.bytes().for_each(&mut mix);
    }
    state
}

impl<'a> Evaluator<'a> {
    fn new(context: &'a BasesEvaluationContext<'a>) -> Self {
        let timezone = context.timezone.clone();
        Self {
            context,
            now: parse_date(
                context.now.as_deref().unwrap_or("1970-01-01T00:00:00Z"),
                &timezone,
            )
            .expect("invocation clock is validated before evaluation"),
            timezone,
            formula_cache: HashMap::new(),
            formula_stack: HashSet::new(),
            remaining_work: context.work_limit.unwrap_or(100_000),
            summary_only: false,
            random_state: seeded_row_state(context),
        }
    }

    fn admit_literals(&mut self, expression: &Expr) -> Result<(), RuntimeValue> {
        regex_admission::admit(expression, &mut |work| self.charge(work))
    }

    fn evaluate(&mut self, expression: &Expr, scope: &Scope) -> RuntimeValue {
        let value = self.evaluate_inner(expression, scope);
        match value {
            RuntimeValue::Duration(ref duration) if !duration_finite(duration) => {
                RuntimeValue::Error("numeric-domain\0Nonfinite duration result".into())
            }
            RuntimeValue::Number(value) if !value.is_finite() => {
                RuntimeValue::Error("numeric-domain\0Nonfinite numeric result".into())
            }
            value if value_bytes(&value).is_none() => {
                RuntimeValue::Error("budget\0Expression value exceeds byte budget".into())
            }
            value => value,
        }
    }

    fn evaluate_inner(&mut self, expression: &Expr, scope: &Scope) -> RuntimeValue {
        if self
            .context
            .cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.stop_reason().is_some())
        {
            return RuntimeValue::Error(format!("cancelled\0{BASES_OPERATION_CANCELLED}"));
        }
        let Some(remaining) = self.remaining_work.checked_sub(1) else {
            return RuntimeValue::Error(format!("budget\0{BASES_WORK_BUDGET_EXCEEDED}"));
        };
        self.remaining_work = remaining;
        match expression {
            Expr::Literal(value) => from_json(value, None),
            Expr::Regex(pattern, flags, identity) => {
                if let Err(error) = self.charge(pattern.len() / 16 + flags.len() + 1) {
                    return error;
                }
                match canonical_regex_flags(flags) {
                    Ok(flags)
                        if pattern
                            .len()
                            .saturating_mul(6)
                            .saturating_add(flags.len() + 3)
                            <= 8 * 1024 * 1024 =>
                    {
                        if let Err(error) = compile_regex(pattern, &flags) {
                            return RuntimeValue::Error(error);
                        }
                        RuntimeValue::Regex(pattern.clone(), flags, Arc::clone(identity))
                    }
                    Ok(_) => RuntimeValue::Error(
                        "budget\0Regex string representation exceeds byte budget".into(),
                    ),
                    Err(error) => RuntimeValue::Error(error),
                }
            }
            Expr::Identifier(name) => self.identifier(name, scope),
            Expr::Array(values) => {
                let mut result = Vec::new();
                let mut bytes = 0usize;
                for value in values {
                    let value = self.evaluate(value, scope);
                    if matches!(value, RuntimeValue::Error(_)) {
                        return value;
                    }
                    bytes = bytes.saturating_add(value_bytes(&value).unwrap_or(usize::MAX));
                    if bytes > 8 * 1024 * 1024 {
                        return RuntimeValue::Error("budget\0List exceeds byte budget".into());
                    }
                    result.push(value);
                }
                RuntimeValue::List(result)
            }
            Expr::Unary(operator, value) => {
                let value = self.evaluate(value, scope);
                if matches!(value, RuntimeValue::Error(_)) {
                    return value;
                }
                if matches!(value, RuntimeValue::Null) {
                    return RuntimeValue::Null;
                }
                match operator.as_str() {
                    "!" => RuntimeValue::Bool(!is_truthy(&value)),
                    "-" => match value {
                        RuntimeValue::Number(value) => RuntimeValue::Number(-value),
                        _ => RuntimeValue::Error("type\0Unary minus requires a number".into()),
                    },
                    "+" => self
                        .number(&value)
                        .map(RuntimeValue::Number)
                        .unwrap_or_else(RuntimeValue::Error),
                    _ => RuntimeValue::Error(format!("Unsupported unary operator {operator}")),
                }
            }
            Expr::Binary(operator, left, right) => self.binary(operator, left, right, scope),
            Expr::Member(object, member) => self.member(object, member, scope),
            Expr::Call(callee, arguments) => self.call(callee, arguments, scope),
        }
    }

    fn identifier(&mut self, name: &str, scope: &Scope) -> RuntimeValue {
        if let Some(value) = scope.get(name) {
            return value.clone();
        }
        if self.summary_only {
            return scope
                .get(if name.eq_ignore_ascii_case("values") {
                    "values"
                } else {
                    name
                })
                .cloned()
                .unwrap_or(RuntimeValue::Null);
        }
        let lower = name.to_lowercase();
        if self.context.file.metadata_unavailable
            && !matches!(lower.as_str(), "file" | "this" | "formula")
        {
            return RuntimeValue::Error(
                "unavailable\0Property metadata is unavailable for this revision".into(),
            );
        }
        match lower.as_str() {
            "note" => RuntimeValue::Object(
                self.context
                    .note
                    .iter()
                    .map(|(key, value)| (key.clone(), self.note_property(key, value)))
                    .collect(),
            ),
            "file" => {
                if self.context.file.path.is_empty() {
                    RuntimeValue::Null
                } else {
                    RuntimeValue::File(Box::new(self.context.file.clone()))
                }
            }
            "this" => self
                .context
                .this_file
                .as_ref()
                .map(|file| {
                    if file.metadata_unavailable { return RuntimeValue::Error("unavailable\0Current property metadata is unavailable for this revision".into()); }
                    let mut values = file.properties.clone();
                    values.insert("file".into(), RuntimeValue::File(Box::new(file.clone())));
                    RuntimeValue::Object(values)
                })
                .unwrap_or(RuntimeValue::Null),
            "formula" => RuntimeValue::Object(IndexMap::new()),
            "values" => self
                .context
                .note
                .get("values")
                .cloned()
                .unwrap_or(RuntimeValue::Null),
            _ => self
                .context
                .note
                .get(own_key(&self.context.note, name).unwrap_or(name))
                .map(|value| self.note_property(name, value))
                .unwrap_or(RuntimeValue::Null),
        }
    }

    fn note_property(&self, _name: &str, value: &RuntimeValue) -> RuntimeValue {
        value.clone()
    }

    fn binary(&mut self, operator: &str, left: &Expr, right: &Expr, scope: &Scope) -> RuntimeValue {
        if operator == "&&" || operator == "||" {
            let left = self.evaluate(left, scope);
            if matches!(left, RuntimeValue::Error(_)) {
                return left;
            }
            let truth = is_truthy(&left);
            if (operator == "&&" && !truth) || (operator == "||" && truth) {
                return RuntimeValue::Bool(truth);
            }
            let right = self.evaluate(right, scope);
            if matches!(right, RuntimeValue::Error(_)) {
                return right;
            }
            return RuntimeValue::Bool(is_truthy(&right));
        }
        let left = self.evaluate(left, scope);
        let right = self.evaluate(right, scope);
        if let RuntimeValue::Error(_) = left {
            return left;
        }
        if let RuntimeValue::Error(_) = right {
            return right;
        }
        if matches!(left, RuntimeValue::Null) || matches!(right, RuntimeValue::Null) {
            if !matches!(operator, "==" | "!=" | "+") {
                return RuntimeValue::Null;
            }
            if operator == "+" && string_data(&left).is_none() && string_data(&right).is_none() {
                return RuntimeValue::Null;
            }
        }
        match operator {
            "+" => self.add(left, right),
            "-" => self.subtract(left, right),
            "*" => match (&left, &right) {
                (RuntimeValue::Duration(value), RuntimeValue::Number(scale)) => {
                    RuntimeValue::Duration(scale_duration(value, *scale))
                }
                (RuntimeValue::Duration(_), _) | (_, RuntimeValue::Duration(_)) => {
                    RuntimeValue::Error("Invalid operator involving Duration".to_string())
                }
                _ => numeric_pair(self, &left, &right, |a, b| a * b),
            },
            "/" => match (&left, &right) {
                (RuntimeValue::Duration(value), RuntimeValue::Number(scale)) =>
                    RuntimeValue::Duration(scale_duration(value, 1.0 / *scale)),
                (RuntimeValue::Duration(_), _) | (_, RuntimeValue::Duration(_)) =>
                    RuntimeValue::Error("Invalid operator involving Duration".into()),
                _ => numeric_pair(self, &left, &right, |a, b| a / b),
            },
            "%" if matches!(left, RuntimeValue::Duration(_)) || matches!(right, RuntimeValue::Duration(_)) =>
                RuntimeValue::Error("Invalid operator involving Duration".into()),
            "%" => numeric_pair(self, &left, &right, |a, b| a % b),
            "==" => self
                .equals_checked(&left, &right)
                .map(RuntimeValue::Bool)
                .unwrap_or_else(|error| error),
            "!=" => self
                .equals_checked(&left, &right)
                .map(|equal| RuntimeValue::Bool(!equal))
                .unwrap_or_else(|error| error),
            ">" | "<" | ">=" | "<=" => self
                .compare(&left, &right, operator)
                .map(RuntimeValue::Bool)
                .unwrap_or_else(RuntimeValue::Error),
            _ => RuntimeValue::Error(format!("Unsupported operator {operator}")),
        }
    }

    fn add(&self, left: RuntimeValue, right: RuntimeValue) -> RuntimeValue {
        if let (
            RuntimeValue::List(a) | RuntimeValue::TagList(a),
            RuntimeValue::List(b) | RuntimeValue::TagList(b),
        ) = (&left, &right)
        {
            return RuntimeValue::List(a.iter().chain(b).cloned().collect());
        }
        if let RuntimeValue::Date(date) = &left {
            if let Some(duration) = coerce_duration(&right) {
                return add_duration(date, &duration, 1.0)
                    .map(RuntimeValue::Date)
                    .unwrap_or_else(RuntimeValue::Error);
            }
        }
        if string_data(&left).is_some() || string_data(&right).is_some() {
            return RuntimeValue::String(format!(
                "{}{}",
                if matches!(left, RuntimeValue::Null) {
                    String::new()
                } else {
                    plain_string(&left)
                },
                if matches!(right, RuntimeValue::Null) {
                    String::new()
                } else {
                    plain_string(&right)
                }
            ));
        }
        if let (RuntimeValue::Duration(left), RuntimeValue::Duration(right)) = (&left, &right) {
            return RuntimeValue::Duration(add_durations(left, right));
        }
        if matches!(left, RuntimeValue::Duration(_)) || matches!(right, RuntimeValue::Duration(_)) {
            return RuntimeValue::Error("Invalid operator involving Duration".into());
        }
        numeric_pair(self, &left, &right, |a, b| a + b)
    }

    fn subtract(&self, left: RuntimeValue, right: RuntimeValue) -> RuntimeValue {
        if let (RuntimeValue::Date(left), RuntimeValue::Date(right)) = (&left, &right) {
            return RuntimeValue::Duration(DurationValue {
                milliseconds: (left.millis - right.millis) as f64,
                ..Default::default()
            });
        }
        if let RuntimeValue::Date(date) = &left {
            if let Some(duration) = coerce_duration(&right) {
                return add_duration(date, &duration, -1.0)
                    .map(RuntimeValue::Date)
                    .unwrap_or_else(RuntimeValue::Error);
            }
        }
        if let (RuntimeValue::Duration(left), RuntimeValue::Duration(right)) = (&left, &right) {
            return RuntimeValue::Duration(add_durations(left, &scale_duration(right, -1.0)));
        }
        if matches!(left, RuntimeValue::Duration(_)) || matches!(right, RuntimeValue::Duration(_)) {
            return RuntimeValue::Error("Invalid operator involving Duration".into());
        }
        numeric_pair(self, &left, &right, |a, b| a - b)
    }

    fn member(&mut self, object: &Expr, member: &Member, scope: &Scope) -> RuntimeValue {
        if let Expr::Identifier(namespace) = object {
            if !self.summary_only && namespace.eq_ignore_ascii_case("formula") {
                let name = match member {
                    Member::Named(name) => name.clone(),
                    Member::Computed(expression) => {
                        let value = self.evaluate(expression, scope);
                        match value {
                            RuntimeValue::String(name) | RuntimeValue::Tag(name) => name,
                            RuntimeValue::Error(_) => return value,
                            _ => {
                                return RuntimeValue::Error(
                                    "access\0Formula key must be text".into(),
                                )
                            }
                        }
                    }
                };
                return self.formula(&name);
            }
        }
        let object = self.evaluate(object, scope);
        let property = match member {
            Member::Named(value) => value.clone(),
            Member::Computed(value) => {
                let value = self.evaluate(value, scope);
                if matches!(value, RuntimeValue::Error(_)) {
                    return value;
                }
                if let Some(text) = string_data(&object) {
                    return match value {
                        RuntimeValue::Null => RuntimeValue::Null,
                        RuntimeValue::Number(index) => {
                            if let Err(error) = self.charge(text.len() / 16 + 1) {
                                return error;
                            }
                            // Keep the accepted Unicode-scalar policy while
                            // following charAt's truncation and empty bounds.
                            let index = if index.is_nan() { 0.0 } else { index.trunc() };
                            RuntimeValue::String(if index >= 0.0 && index.is_finite() {
                                text.chars()
                                    .nth(index as usize)
                                    .map(String::from)
                                    .unwrap_or_default()
                            } else {
                                String::new()
                            })
                        }
                        _ => RuntimeValue::Error("access\0String index must be a number".into()),
                    };
                }
                plain_string(&value)
            }
        };
        self.property(object, &property)
    }

    fn lazy_if(
        &mut self,
        subject: Option<&Expr>,
        arguments: &[Expr],
        scope: &Scope,
    ) -> RuntimeValue {
        let supplied = arguments.len() + usize::from(subject.is_some());
        if !(2..=3).contains(&supplied) {
            return call_signatures::arity_error(
                "if",
                if supplied < 2 {
                    "not enough"
                } else {
                    "too many"
                },
            );
        }
        let (condition, results) = if let Some(subject) = subject {
            (subject, arguments)
        } else {
            (&arguments[0], &arguments[1..])
        };
        let condition = self.evaluate(condition, scope);
        if matches!(condition, RuntimeValue::Error(_)) {
            return condition;
        }
        let selected = if is_truthy(&condition) {
            results.first()
        } else {
            results.get(1)
        };
        selected
            .map(|expression| self.evaluate(expression, scope))
            .unwrap_or(RuntimeValue::Null)
    }

    fn call(&mut self, callee: &Expr, arguments: &[Expr], scope: &Scope) -> RuntimeValue {
        match callee {
            Expr::Identifier(name) if name == "if" => self.lazy_if(None, arguments, scope),
            Expr::Member(subject, Member::Named(name)) if name == "if" => {
                self.lazy_if(Some(subject), arguments, scope)
            }
            Expr::Identifier(name) => {
                let Some(signature) = call_signatures::global(name) else {
                    return RuntimeValue::Error(format!(
                        "unknown-function\0Cannot find function \"{name}\""
                    ));
                };
                match self.registered_arguments(signature, name, arguments, scope) {
                    Ok(Some(values)) => self.global(name, &values),
                    Ok(None) => RuntimeValue::Null,
                    Err(error) => error,
                }
            }
            Expr::Member(object, Member::Named(method)) => {
                let receiver = self.evaluate(object, scope);
                if matches!(receiver, RuntimeValue::Error(_)) {
                    return receiver;
                }
                self.method(receiver, method, arguments, scope)
            }
            _ => RuntimeValue::Error("Expression is not callable".to_string()),
        }
    }

    /// Evaluate each argument once and validate it immediately. A required null
    /// returns before later expressions; ordinary excess arguments are evaluated
    /// before their arity error, and missing arguments are checked at the end.
    fn registered_arguments(
        &mut self,
        signature: call_signatures::Signature,
        name: &str,
        arguments: &[Expr],
        scope: &Scope,
    ) -> Result<Option<Vec<RuntimeValue>>, RuntimeValue> {
        let mut values = Vec::new();
        let mut bytes = 0usize;
        for (index, argument) in arguments.iter().enumerate() {
            let value = self.evaluate(argument, scope);
            if matches!(value, RuntimeValue::Error(_)) {
                return Err(value);
            }
            bytes = bytes.saturating_add(value_bytes(&value).unwrap_or(usize::MAX));
            if bytes > 8 * 1024 * 1024 {
                return Err(RuntimeValue::Error(
                    "budget\0Arguments exceed byte budget".into(),
                ));
            }
            match signature.argument(name, index, value)? {
                call_signatures::Argument::Value(value) => values.push(value),
                // Every registered optional slot is trailing. Omission therefore
                // preserves indices and the existing bodies' optional defaults.
                call_signatures::Argument::Omitted => {}
                call_signatures::Argument::Null => return Ok(None),
            }
        }
        signature.finish(name, arguments.len())?;
        Ok(Some(values))
    }

    fn charge(&mut self, work: usize) -> Result<(), RuntimeValue> {
        if self
            .context
            .cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.stop_reason().is_some())
        {
            return Err(RuntimeValue::Error("cancelled\0Operation cancelled".into()));
        }
        self.remaining_work = self.remaining_work.checked_sub(work).ok_or_else(|| {
            RuntimeValue::Error("budget\0Builtin traversal exceeds work budget".into())
        })?;
        Ok(())
    }

    fn global(&mut self, name: &str, arguments: &[RuntimeValue]) -> RuntimeValue {
        let name = canonical_function_name(name);
        let first = arguments.first().cloned().unwrap_or(RuntimeValue::Null);
        match name {
            "if" => {
                if matches!(first, RuntimeValue::Bool(true)) {
                    arguments.get(1).cloned().unwrap_or(RuntimeValue::Null)
                } else {
                    arguments.get(2).cloned().unwrap_or(RuntimeValue::Null)
                }
            }
            "random" => {
                // SplitMix64: portable, bounded and driven only by the host's
                // view-load seed. This deliberately replaces ambient Math.random.
                self.random_state = self.random_state.wrapping_add(0x9e3779b97f4a7c15);
                let mut bits = self.random_state;
                bits = (bits ^ (bits >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
                bits = (bits ^ (bits >> 27)).wrapping_mul(0x94d049bb133111eb);
                bits ^= bits >> 31;
                RuntimeValue::Number((bits >> 11) as f64 / 9_007_199_254_740_992.0)
            }
            "escapeHTML" => match first {
                RuntimeValue::Null => RuntimeValue::Null,
                value if string_data(&value).is_some() => {
                    RuntimeValue::String(escape_html(string_data(&value).unwrap()))
                }
                _ => RuntimeValue::Error("type\0escapeHTML() requires text".into()),
            },
            "date" => match first {
                RuntimeValue::Null | RuntimeValue::Date(_) => first,
                value if string_data(&value).is_some() => {
                    parse_date(string_data(&value).unwrap(), &self.timezone)
                        .map(RuntimeValue::Date)
                        .unwrap_or(RuntimeValue::Null)
                }
                _ => RuntimeValue::Error("type\0date() requires text or Date".into()),
            },
            "duration" => match first {
                RuntimeValue::Null => RuntimeValue::Null,
                value if string_data(&value).is_some() => {
                    parse_duration(string_data(&value).unwrap())
                        .map(RuntimeValue::Duration)
                        .unwrap_or(RuntimeValue::Null)
                }
                _ => RuntimeValue::Error("type\0duration() requires text".into()),
            },

            "file" => match &first {
                RuntimeValue::Null => RuntimeValue::Null,
                RuntimeValue::File(_) => first,
                RuntimeValue::Link(link) if !link.external => self.file_from_link(link),
                RuntimeValue::Link(link) if link.external => RuntimeValue::Null,
                value if string_data(value).is_some() => {
                    self.file_from_target(string_data(value).unwrap())
                }
                _ => RuntimeValue::Error("type\0file() requires text, Link or File".into()),
            },
            "html" | "icon" => match first {
                RuntimeValue::Null => RuntimeValue::Null,
                value if string_data(&value).is_some() => {
                    let value = string_data(&value).unwrap().to_owned();
                    if name == "html" {
                        RuntimeValue::Html(value)
                    } else {
                        RuntimeValue::Icon(value)
                    }
                }
                _ => RuntimeValue::Error(format!("type\0{name}() requires text")),
            },
            "image" => match first {
                RuntimeValue::Null => RuntimeValue::Null,
                RuntimeValue::File(file) => RuntimeValue::Image(file.path),
                RuntimeValue::Link(link) if link.external => RuntimeValue::Image(link.path),
                RuntimeValue::Link(link) => match self.file_from_link(&link) {
                    RuntimeValue::File(file) => RuntimeValue::Image(file.path),
                    value => value,
                },
                value if string_data(&value).is_some() => {
                    RuntimeValue::Image(string_data(&value).unwrap().to_owned())
                }
                _ => RuntimeValue::Error("type\0image() requires text, Link, URL or File".into()),
            },
            "link" => match first {
                RuntimeValue::Null => RuntimeValue::Null,
                RuntimeValue::File(file) => RuntimeValue::Link(BasesLink {
                    raw_destination: Some(file.path.clone()),
                    source_path: Some(String::new()),
                    subpath: None,
                    path: file.path.clone(),
                    target: file.witness.clone(),
                    display: arguments.get(1).map(plain_string),
                    display_value: arguments.get(1).cloned().map(Box::new),
                    resolved_path: Some(Some(file.path.clone())),
                    external: false,
                }),
                value if string_data(&value).is_some() => {
                    self.make_link(string_data(&value).unwrap(), arguments.get(1).cloned())
                }
                _ => RuntimeValue::Error("type\0link() requires text, URL or File".into()),
            },
            "list" => match first {
                RuntimeValue::List(_) | RuntimeValue::TagList(_) | RuntimeValue::Null => first,
                value => RuntimeValue::List(vec![value]),
            },
            "max" | "min" => {
                let mut selected: Option<f64> = None;
                for value in arguments {
                    match value {
                        RuntimeValue::Null => {}
                        RuntimeValue::Number(value) => {
                            selected = Some(selected.map_or(*value, |current| {
                                if name == "max" {
                                    current.max(*value)
                                } else {
                                    current.min(*value)
                                }
                            }))
                        }
                        _ => {
                            return RuntimeValue::Error(format!("type\0{name}() requires numbers"))
                        }
                    }
                }
                selected
                    .map(RuntimeValue::Number)
                    .unwrap_or(RuntimeValue::Null)
            }
            "now" => RuntimeValue::Date(self.now.clone()),
            "number" => match first {
                value if string_data(&value).is_some() => {
                    parse_number_prefix(string_data(&value).unwrap())
                        .map(RuntimeValue::Number)
                        .unwrap_or_else(|| RuntimeValue::Error("type\0Invalid number".into()))
                }
                RuntimeValue::Bool(value) => RuntimeValue::Number(if value { 1.0 } else { 0.0 }),
                RuntimeValue::Number(value) => RuntimeValue::Number(value),
                RuntimeValue::Date(value) => RuntimeValue::Number(value.millis as f64),
                RuntimeValue::Null => RuntimeValue::Null,
                _ => RuntimeValue::Error("type\0Cannot convert value to number".into()),
            },
            "today" => {
                let now = self.now.clone();
                start_of_day(&now, &mut |work| self.charge(work))
                    .map(RuntimeValue::Date)
                    .unwrap_or_else(|error| error)
            }
            _ => RuntimeValue::Error(format!("unknown-function\0Cannot find function \"{name}\"")),
        }
    }

    fn tag_shape(
        &mut self,
        value: &RuntimeValue,
        _depth: usize,
        reserve: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
    ) -> Result<Option<TagShape>, RuntimeValue> {
        capture_runtime_shape(
            value,
            &mut |work| self.charge(work).map_err(runtime_diagnostic),
            reserve,
        )
        .map_err(|error| RuntimeValue::Error(format!("{}\0{}", error.code, error.message)))
    }
    fn restore_tags(
        &mut self,
        value: &mut RuntimeValue,
        shape: &TagShape,
        _depth: usize,
    ) -> Result<(), RuntimeValue> {
        restore_runtime_shape(value, shape, &mut |work| {
            self.charge(work).map_err(runtime_diagnostic)
        })
        .map_err(|error| RuntimeValue::Error(format!("{}\0{}", error.code, error.message)))
    }
    /// Pay each repeated callback capture before cloning its full value tree.
    /// Includes File metadata and Link identity/display data, unlike a rendered
    /// payload estimate. Checkpoints make wide/deep capture cancellation visible.
    fn charge_copy(&mut self, value: &RuntimeValue, depth: usize) -> Result<(), RuntimeValue> {
        self.charge(1)?;
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Callback capture exceeds depth budget".into(),
            ));
        }
        match value {
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
            | RuntimeValue::Error(value)
            | RuntimeValue::ErrorValue(value) => self.charge(value.len() / 16 + 1)?,
            RuntimeValue::Regex(pattern, flags, _) => {
                self.charge((pattern.len() + flags.len()) / 16 + 1)?
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                for value in values {
                    self.charge_copy(value, depth + 1)?;
                }
            }
            RuntimeValue::Object(values) => {
                for (key, value) in values {
                    self.charge(key.len() / 16 + 1)?;
                    self.charge_copy(value, depth + 1)?;
                }
            }
            RuntimeValue::Link(link) => self.charge_link_copy(link, depth)?,
            RuntimeValue::File(file) => {
                self.charge(
                    (file.path.len()
                        + file.name.len()
                        + file.basename.len()
                        + file.folder.len()
                        + file.extension.len()
                        + file.ctime.as_ref().map_or(0, String::len)
                        + file.mtime.as_ref().map_or(0, String::len)
                        + file
                            .witness
                            .as_ref()
                            .map_or(0, |w| w.entry_id.as_str().len() + w.revision.as_str().len()))
                        / 16
                        + 1,
                )?;
                for tag in &file.tags {
                    self.charge(tag.len() / 16 + 1)?;
                }
                for (key, value) in &file.properties {
                    self.charge(key.len() / 16 + 1)?;
                    self.charge_copy(value, depth + 1)?;
                }
                for link in file.links.iter().chain(&file.embeds).chain(&file.backlinks) {
                    self.charge_link_copy(link, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn charge_link_copy(&mut self, link: &BasesLink, depth: usize) -> Result<(), RuntimeValue> {
        self.charge(
            (link.path.len()
                + link.raw_destination.as_ref().map_or(0, String::len)
                + link.source_path.as_ref().map_or(0, String::len)
                + link.subpath.as_ref().map_or(0, String::len)
                + link.display.as_ref().map_or(0, String::len)
                + link
                    .resolved_path
                    .as_ref()
                    .and_then(Option::as_ref)
                    .map_or(0, String::len)
                + link
                    .target
                    .as_ref()
                    .map_or(0, |w| w.entry_id.as_str().len() + w.revision.as_str().len()))
                / 16
                + 1,
        )?;
        if let Some(value) = &link.display_value {
            self.charge_copy(value, depth + 1)?;
        }
        Ok(())
    }
    /// Mixed-case lookups use the ordinary eager registry implementation. Only
    /// exact lowercase spellings are intercepted as callback AST operations.
    fn ordinary_collection_callback(
        &mut self,
        receiver: RuntimeValue,
        name: &str,
        arguments: &[RuntimeValue],
        scope: &Scope,
    ) -> RuntimeValue {
        match receiver {
            RuntimeValue::Object(values) if name == "map" => {
                self.object_method(values, "map", &[], scope, Some(arguments))
            }
            receiver => receiver,
        }
    }

    fn object_entries<'v>(
        &mut self,
        values: &'v IndexMap<String, RuntimeValue>,
    ) -> Result<Vec<(Option<u32>, usize, &'v String, &'v RuntimeValue)>, RuntimeValue> {
        type Entry<'a> = (Option<u32>, usize, &'a String, &'a RuntimeValue);
        if values
            .len()
            .saturating_mul(std::mem::size_of::<Entry<'_>>())
            > 8 * 1024 * 1024
        {
            return Err(RuntimeValue::Error(
                "budget\0Object enumeration exceeds byte budget".into(),
            ));
        }
        self.charge(values.len())?;
        let mut numeric = false;
        let mut entries = Vec::with_capacity(values.len());
        for (ordinal, (key, value)) in values.iter().enumerate() {
            self.charge(key.len() / 16 + 1)?;
            let index = key
                .parse::<u32>()
                .ok()
                .filter(|index| *index < u32::MAX && index.to_string() == *key);
            numeric |= index.is_some();
            entries.push((index, ordinal, key, value));
        }
        if numeric {
            self.charge(
                entries
                    .len()
                    .saturating_mul((usize::BITS - entries.len().max(1).leading_zeros()) as usize),
            )?;
            entries.sort_unstable_by(|a, b| match (a.0, b.0) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.1.cmp(&b.1),
            });
        }
        Ok(entries)
    }
    fn object_method(
        &mut self,
        values: IndexMap<String, RuntimeValue>,
        name: &str,
        arguments: &[Expr],
        scope: &Scope,
        validated: Option<&[RuntimeValue]>,
    ) -> RuntimeValue {
        if validated.is_some() {
            if name == "map" {
                return self.object_method(values, "values", &[], scope, Some(&[]));
            }
            if name == "filter" {
                return RuntimeValue::Object(values);
            }
        }
        if !["keys", "values", "map", "filter"].contains(&name) {
            return method_not_found("Object", name);
        }
        if ["map", "filter"].contains(&name) && arguments.len() != 1 {
            return arity_error(name, 1);
        }
        let entries = match self.object_entries(&values) {
            Ok(entries) => entries,
            Err(error) => return error,
        };
        if name == "keys" {
            let mut bytes = 0usize;
            let mut result = Vec::new();
            for (_, _, key, _) in entries {
                if let Err(error) = self.charge(key.len() / 16 + 1) {
                    return error;
                }
                bytes = bytes.saturating_add(key.len() + 16);
                if bytes > 8 * 1024 * 1024 {
                    return RuntimeValue::Error("budget\0Object keys exceed byte budget".into());
                }
                result.push(RuntimeValue::String(key.clone()));
            }
            return RuntimeValue::List(result);
        }
        if name == "values" {
            let mut bytes = 0usize;
            let mut result = Vec::new();
            for (_, _, _, value) in entries {
                if let Err(error) = self.charge_copy(value, 0) {
                    return error;
                }
                bytes = bytes.saturating_add(value_bytes(value).unwrap_or(usize::MAX));
                if bytes > 8 * 1024 * 1024 {
                    return RuntimeValue::Error("budget\0Object values exceed byte budget".into());
                }
                result.push(value.clone());
            }
            return RuntimeValue::List(result);
        }
        let mut mapped = Vec::new();
        let mut filtered = IndexMap::new();
        let mut bytes = 0usize;
        for (_, _, key, value) in entries {
            // Preserve parent index/acc/key/value unless explicitly shadowed.
            // Charge before each scope clone, not once for all iterations.
            for (name, capture) in scope {
                if let Err(error) = self
                    .charge(name.len() / 16 + 1)
                    .and_then(|_| self.charge_copy(capture, 0))
                {
                    return error;
                }
            }
            if let Err(error) = self
                .charge(key.len() / 16 + 1)
                .and_then(|_| self.charge_copy(value, 0))
            {
                return error;
            }
            let mut nested = scope.clone();
            nested.insert("key".into(), RuntimeValue::String(key.clone()));
            nested.insert("value".into(), value.clone());
            let result = self.evaluate(&arguments[0], &nested);
            if matches!(result, RuntimeValue::Error(_)) {
                return result;
            }
            if name == "map" {
                if let Err(error) = self.charge_copy(&result, 0) {
                    return error;
                }
                bytes = bytes.saturating_add(value_bytes(&result).unwrap_or(usize::MAX));
                if bytes > 8 * 1024 * 1024 {
                    return RuntimeValue::Error("budget\0Object map exceeds byte budget".into());
                }
                mapped.push(result);
            } else if is_truthy(&result) {
                if let Err(error) = self.charge_copy(value, 0) {
                    return error;
                }
                bytes = bytes
                    .saturating_add(key.len() + 32)
                    .saturating_add(value_bytes(value).unwrap_or(usize::MAX));
                if bytes > 8 * 1024 * 1024 {
                    return RuntimeValue::Error("budget\0Object filter exceeds byte budget".into());
                }
                filtered.insert(key.clone(), value.clone());
            }
        }
        if name == "map" {
            RuntimeValue::List(mapped)
        } else {
            RuntimeValue::Object(filtered)
        }
    }
    fn membership_checked(
        &mut self,
        values: &[RuntimeValue],
        needle: &RuntimeValue,
        tag_list: bool,
    ) -> Result<bool, RuntimeValue> {
        if !tag_list {
            return self.contains_checked(values, needle);
        }
        self.comparison_preflight(needle)?;
        for value in values {
            self.comparison_preflight(value)?;
        }
        let Some(query) = string_data(needle) else {
            return Ok(false);
        };
        for value in values {
            if let RuntimeValue::Tag(tag) = value {
                self.charge((tag.len() + query.len()) / 16 + 1)?;
                if tag_matches(tag, query) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    fn method(
        &mut self,
        receiver: RuntimeValue,
        raw_name: &str,
        arguments: &[Expr],
        scope: &Scope,
    ) -> RuntimeValue {
        if matches!(receiver, RuntimeValue::Error(_)) {
            return receiver;
        }
        let Some(signature) = call_signatures::method(&receiver, raw_name) else {
            return if matches!(receiver, RuntimeValue::Null) {
                RuntimeValue::Null
            } else {
                method_not_found(value_type(&receiver), raw_name)
            };
        };
        let callback_arity = call_signatures::special_callback_arity(&receiver, raw_name);
        if let Some(expected) = callback_arity {
            if arguments.len() != expected {
                return arity_error(raw_name, expected);
            }
        }
        let name = canonical_function_name(raw_name);
        let work = match &receiver {
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => values.len(),
            RuntimeValue::Object(values) => values.len(),
            RuntimeValue::File(file) if name == "hasLink" => file.links.len(),
            RuntimeValue::ErrorValue(message) => message.len() / 256,
            value => string_data(value).map_or(0, |data| data.len() / 256),
        };
        if let Err(error) = self.charge(work) {
            return error;
        }
        let validated = if callback_arity.is_some() {
            None
        } else {
            match self.registered_arguments(signature, raw_name, arguments, scope) {
                Ok(Some(values)) => Some(values),
                Ok(None) => return RuntimeValue::Null,
                Err(error) => return error,
            }
        };
        let values = validated.as_deref().unwrap_or(&[]);
        match name {
            "isTruthy" => return RuntimeValue::Bool(is_truthy(&receiver)),
            "isEmpty" => return RuntimeValue::Bool(is_empty(&receiver)),
            "toString" => return RuntimeValue::String(stringify(&receiver)),
            "isType" => {
                return RuntimeValue::Bool(call_signatures::is_type(
                    &receiver,
                    &plain_string(&values[0]),
                ))
            }
            _ => {}
        }
        if callback_arity.is_none()
            && ["map", "filter", "reduce"].contains(&name)
            && matches!(
                &receiver,
                RuntimeValue::List(_) | RuntimeValue::TagList(_) | RuntimeValue::Object(_)
            )
        {
            return self.ordinary_collection_callback(receiver, name, values, scope);
        }
        match receiver {
            RuntimeValue::Null => RuntimeValue::Null,
            RuntimeValue::Tag(value) if name == "matches" => {
                let query = string_data(&values[0]).expect("String signature validated");
                if let Err(error) = self.charge((value.len() + query.len()) / 16 + 1) {
                    return error;
                }
                RuntimeValue::Bool(tag_matches(&value, query))
            }
            RuntimeValue::Tag(value)
            | RuntimeValue::String(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value) => self.string_method(&value, name, values),
            RuntimeValue::Number(value) => self.number_method(value, name, values),
            RuntimeValue::Date(value) => self.date_method(&value, name, values),
            RuntimeValue::List(items) => {
                self.list_method(&items, name, arguments, scope, false, validated.as_deref())
            }
            RuntimeValue::TagList(items) => {
                self.list_method(&items, name, arguments, scope, true, validated.as_deref())
            }
            RuntimeValue::Object(object) => {
                self.object_method(object, name, arguments, scope, validated.as_deref())
            }
            RuntimeValue::Regex(pattern, flags, _) if name == "matches" => {
                match regex_is_match(&pattern, &flags, &plain_string(&values[0])) {
                    Ok(matches) => RuntimeValue::Bool(matches),
                    Err(error) => RuntimeValue::Error(error),
                }
            }
            RuntimeValue::File(file) => self.file_method(&file, name, values),
            RuntimeValue::Link(link) => self.link_method(&link, name, values),
            value => method_not_found(value_type(&value), name),
        }
    }

    fn string_method(
        &mut self,
        value: &str,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        let first = arguments.first().cloned().unwrap_or(RuntimeValue::Null);
        match name {
            "contains" => RuntimeValue::Bool(
                !plain_string(&first).is_empty()
                    && value
                        .to_lowercase()
                        .contains(&plain_string(&first).to_lowercase()),
            ),
            "containsAll" | "containsAny" => {
                let haystack = value.to_lowercase();
                let all = name == "containsAll";
                for argument in arguments {
                    let needle = plain_string(argument).to_lowercase();
                    if let Err(error) = self.charge(haystack.len() / 16 + needle.len() / 16 + 1) {
                        return error;
                    }
                    if haystack.contains(&needle) != all {
                        return RuntimeValue::Bool(!all);
                    }
                }
                RuntimeValue::Bool(all)
            }
            "endsWith" => RuntimeValue::Bool(value.ends_with(&plain_string(&first))),
            "lower" => RuntimeValue::String(value.to_lowercase()),
            "replace" => {
                let replacement = arguments.get(1).map(plain_string).unwrap_or_default();
                match first {
                    RuntimeValue::Regex(pattern, flags, _) => {
                        regex_replace(value, &pattern, &flags, &replacement, &mut |work| {
                            self.charge(work)
                        })
                        .map(RuntimeValue::String)
                        .unwrap_or_else(|error| error)
                    }
                    other => {
                        literal_replace(value, &plain_string(&other), &replacement, &mut |work| {
                            self.charge(work)
                        })
                        .map(RuntimeValue::String)
                        .unwrap_or_else(|error| error)
                    }
                }
            }
            "repeat" => {
                let count = self.number(&first).unwrap_or(0.0);
                if !count.is_finite()
                    || count < 0.0
                    || count > 1_000_000.0
                    || (value.len() as f64 * count) > 1_048_576.0
                {
                    RuntimeValue::Error("budget\0Repeated string exceeds byte budget".into())
                } else {
                    RuntimeValue::String(value.repeat(count as usize))
                }
            }
            "reverse" => RuntimeValue::String(value.chars().rev().collect()),
            "slice" => string_slice(
                value,
                self.number(&first).unwrap_or(0.0) as isize,
                arguments
                    .get(1)
                    .and_then(|item| self.number(item).ok())
                    .map(|value| value as isize),
            ),
            "split" => string_split(
                value,
                &first,
                arguments
                    .get(1)
                    .and_then(|item| self.number(item).ok())
                    .map(js_uint32),
                &mut |work| self.charge(work),
            ),
            "startsWith" => RuntimeValue::Bool(value.starts_with(&plain_string(&first))),
            "title" => RuntimeValue::String(title_case(value)),
            "trim" => RuntimeValue::String(value.trim_matches(ecmascript_whitespace).to_string()),
            _ => method_not_found("String", name),
        }
    }

    fn number_method(&self, value: f64, name: &str, arguments: &[RuntimeValue]) -> RuntimeValue {
        match name {
            "abs" => RuntimeValue::Number(value.abs()),
            "ceil" => RuntimeValue::Number(value.ceil()),
            "floor" => RuntimeValue::Number(value.floor()),
            "round" => {
                let digits = arguments
                    .first()
                    .and_then(|item| self.number(item).ok())
                    .unwrap_or(0.0);
                let factor = if digits > 0.0 {
                    10_f64.powf(digits)
                } else {
                    1.0
                };
                {
                    let scaled = value * factor;
                    let lower = scaled.floor();
                    let rounded = if scaled - lower < 0.5 {
                        lower
                    } else {
                        lower + 1.0
                    };
                    RuntimeValue::Number(if rounded == 0.0 && scaled < 0.0 {
                        -0.0
                    } else {
                        rounded / factor
                    })
                }
            }
            "toFixed" => {
                let digits = arguments
                    .first()
                    .and_then(|item| self.number(item).ok())
                    .unwrap_or(0.0);
                fixed_number(value, digits)
                    .map(RuntimeValue::String)
                    .unwrap_or_else(|error| error)
            }
            _ => method_not_found("Number", name),
        }
    }

    fn date_method(
        &mut self,
        value: &DateValue,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        match name {
            "date" => start_of_day(value, &mut |work| self.charge(work))
                .map(RuntimeValue::Date)
                .unwrap_or_else(|error| error),
            "format" => try_format_date(
                value,
                &arguments.first().map(plain_string).unwrap_or_default(),
            )
            .map(RuntimeValue::String)
            .unwrap_or_else(RuntimeValue::Error),
            "time" => RuntimeValue::String(format_date(value, "HH:mm:ss")),
            "relative" => RuntimeValue::String(relative_date(value, &self.now)),
            _ => method_not_found("Date", name),
        }
    }

    fn list_method(
        &mut self,
        values: &[RuntimeValue],
        name: &str,
        arguments: &[Expr],
        scope: &Scope,
        tag_list: bool,
        validated: Option<&[RuntimeValue]>,
    ) -> RuntimeValue {
        let eager = validated.unwrap_or(&[]);
        let eager = if ["containsAll", "containsAny"].contains(&name) && eager.len() == 1 {
            match &eager[0] {
                RuntimeValue::List(values) | RuntimeValue::TagList(values) => values.as_slice(),
                _ => eager,
            }
        } else {
            eager
        };
        let extra = match name {
            "containsAll" | "containsAny" => {
                values.len().saturating_mul(eager.len().saturating_sub(1))
            }
            "sort" => values
                .len()
                .saturating_mul((usize::BITS - values.len().max(1).leading_zeros()) as usize)
                .saturating_sub(values.len()),
            _ => 0,
        };
        if let Err(error) = self.charge(extra) {
            return error;
        }
        match name {
            "contains" => {
                let needle = eager.first().cloned().unwrap_or(RuntimeValue::Null);
                self.membership_checked(values, &needle, tag_list)
                    .map(RuntimeValue::Bool)
                    .unwrap_or_else(|error| error)
            }
            "containsAll" | "containsAny" => {
                for needle in eager {
                    if let Err(error) = self.comparison_preflight(needle) {
                        return error;
                    }
                }
                for value in values {
                    if let Err(error) = self.comparison_preflight(value) {
                        return error;
                    }
                }
                let all = name == "containsAll";
                for needle in eager {
                    match self.membership_checked(values, needle, tag_list) {
                        Ok(found) if found != all => return RuntimeValue::Bool(!all),
                        Ok(_) => {}
                        Err(error) => return error,
                    }
                }
                RuntimeValue::Bool(all)
            }
            "filter" => {
                let mut result = Vec::new();
                for (index, value) in values.iter().enumerate() {
                    let mut nested = scope.clone();
                    nested.insert("value".into(), value.clone());
                    nested.insert("index".into(), RuntimeValue::Number(index as f64));
                    let condition = arguments
                        .first()
                        .map(|expression| self.evaluate(expression, &nested))
                        .unwrap_or(RuntimeValue::Null);
                    if matches!(condition, RuntimeValue::Error(_)) {
                        return condition;
                    }
                    if is_truthy(&condition) {
                        result.push(value.clone());
                    }
                }
                RuntimeValue::List(result)
            }
            "flat" => flatten_values(values, &mut |work| self.charge(work))
                .map(RuntimeValue::List)
                .unwrap_or_else(|error| error),
            "join" => {
                let separator = eager.first().map(plain_string).unwrap_or_default();
                let content = values.iter().try_fold(0usize, |total, value| {
                    value_bytes(value).map(|bytes| total.saturating_add(bytes))
                });
                if content
                    .unwrap_or(usize::MAX)
                    .saturating_add(separator.len().saturating_mul(values.len()))
                    > 8 * 1024 * 1024
                {
                    return RuntimeValue::Error("budget\0Joined text exceeds byte budget".into());
                }
                RuntimeValue::String(
                    values
                        .iter()
                        .map(stringify)
                        .collect::<Vec<_>>()
                        .join(&separator),
                )
            }
            "map" => {
                let mut result = Vec::new();
                let mut bytes = 0usize;
                for (index, value) in values.iter().enumerate() {
                    let mut nested = scope.clone();
                    nested.insert("value".into(), value.clone());
                    nested.insert("index".into(), RuntimeValue::Number(index as f64));
                    let value = arguments
                        .first()
                        .map(|expression| self.evaluate(expression, &nested))
                        .unwrap_or(RuntimeValue::Null);
                    if matches!(value, RuntimeValue::Error(_)) {
                        return value;
                    }
                    bytes = bytes.saturating_add(value_bytes(&value).unwrap_or(usize::MAX));
                    if bytes > 8 * 1024 * 1024 {
                        return RuntimeValue::Error(
                            "budget\0Mapped list exceeds byte budget".into(),
                        );
                    }
                    result.push(value);
                }
                RuntimeValue::List(result)
            }
            "reduce" => {
                let mut accumulator = arguments
                    .get(1)
                    .map(|value| self.evaluate(value, scope))
                    .unwrap_or(RuntimeValue::Null);
                if matches!(accumulator, RuntimeValue::Error(_)) {
                    return accumulator;
                }
                for (index, value) in values.iter().enumerate() {
                    let mut nested = scope.clone();
                    nested.insert("acc".to_string(), accumulator);
                    nested.insert("value".to_string(), value.clone());
                    nested.insert("index".to_string(), RuntimeValue::Number(index as f64));
                    accumulator = arguments
                        .first()
                        .map(|expression| self.evaluate(expression, &nested))
                        .unwrap_or(RuntimeValue::Null);
                    if matches!(accumulator, RuntimeValue::Error(_)) {
                        return accumulator;
                    }
                }
                accumulator
            }
            "reverse" => RuntimeValue::List(values.iter().cloned().rev().collect()),
            "slice" => {
                let start = eager
                    .first()
                    .and_then(|value| self.number(value).ok())
                    .unwrap_or(0.0) as isize;
                let end = eager
                    .get(1)
                    .and_then(|value| self.number(value).ok())
                    .map(|value| value as isize);
                RuntimeValue::List(slice_values(values, start, end))
            }
            "sort" => {
                let mut output = values.to_vec();
                output.sort_by(compare_sort_keys);
                RuntimeValue::List(output)
            }
            "unique" => unique_values(values, &mut |work| self.charge(work))
                .map(RuntimeValue::List)
                .unwrap_or_else(|error| error),
            "sum" | "mean" | "min" | "max" | "median" | "stddev" => {
                // Numeric collection functions select actual numbers. They do
                // not coerce null, booleans or numeric-looking strings. Mean's
                // divisor is the original list length, matching the reference.
                let mut numbers = values
                    .iter()
                    .filter_map(|value| match value {
                        RuntimeValue::Number(value) => Some(*value),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                if numbers.is_empty() {
                    return RuntimeValue::Null;
                }
                if name == "median" {
                    let work = numbers.len().saturating_mul(
                        (usize::BITS - numbers.len().max(1).leading_zeros()) as usize,
                    );
                    if let Err(error) = self.charge(work) {
                        return error;
                    }
                    numbers.sort_by(f64::total_cmp);
                }
                let sum = numbers.iter().sum::<f64>();
                let result = match name {
                    "sum" => sum,
                    "mean" => sum / values.len() as f64,
                    "min" => numbers.into_iter().reduce(f64::min).unwrap(),
                    "max" => numbers.into_iter().reduce(f64::max).unwrap(),
                    "median" => {
                        let middle = numbers.len() / 2;
                        if numbers.len() % 2 == 0 {
                            (numbers[middle - 1] + numbers[middle]) / 2.0
                        } else {
                            numbers[middle]
                        }
                    }
                    "stddev" => {
                        let mean = sum / numbers.len() as f64;
                        (numbers
                            .iter()
                            .map(|value| (value - mean).powi(2))
                            .sum::<f64>()
                            / numbers.len() as f64)
                            .sqrt()
                    }
                    _ => unreachable!(),
                };
                RuntimeValue::Number(result)
            }
            "earliest" | "latest" => {
                let dates = values.iter().filter_map(|value| match value {
                    RuntimeValue::Date(value) => Some(value.millis),
                    RuntimeValue::String(value) | RuntimeValue::Tag(value) => {
                        parse_date(value, &self.timezone).map(|date| date.millis)
                    }
                    _ => None,
                });
                let selected = dates.reduce(if name == "earliest" {
                    i64::min
                } else {
                    i64::max
                });
                selected
                    .map(|millis| {
                        RuntimeValue::Date(DateValue {
                            millis,
                            date_only: false,
                            timezone: self.timezone.clone(),
                        })
                    })
                    .unwrap_or(RuntimeValue::Null)
            }
            _ => method_not_found("List", name),
        }
    }

    fn file_method(
        &mut self,
        file: &BasesFile,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        if file.metadata_unavailable && matches!(name, "hasProperty" | "hasTag") {
            return RuntimeValue::Error(
                "unavailable\0Property metadata is unavailable for this revision".into(),
            );
        }
        match name {
            "hasLink" => {
                let Some(graph) = self.context.relationships else {
                    return RuntimeValue::Error(
                        "unavailable\0Relationship metadata not supplied".into(),
                    );
                };
                let target = arguments.first().map(plain_string).unwrap_or_default();
                let mut check = |work: usize| {
                    if self
                        .context
                        .cancellation
                        .as_ref()
                        .is_some_and(|c| c.stop_reason().is_some())
                    {
                        return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
                    }
                    self.remaining_work =
                        self.remaining_work.checked_sub(work).ok_or_else(|| {
                            ExpressionDiagnostic::new(
                                "budget",
                                "Relationship resolver exceeds work budget",
                            )
                        })?;
                    Ok(())
                };
                match graph.has_link(file, &target, &mut check) {
                    Ok(value) => RuntimeValue::Bool(value),
                    Err(error) => RuntimeValue::Error(format!("{}\0{}", error.code, error.message)),
                }
            }
            "asLink" => RuntimeValue::Link(BasesLink {
                raw_destination: Some(file.path.clone()),
                source_path: Some(String::new()),
                subpath: None,
                path: file.path.clone(),
                display: arguments.first().map(plain_string),
                display_value: arguments.first().cloned().map(Box::new),
                resolved_path: Some(Some(file.path.clone())),
                external: false,
                target: file.witness.clone(),
            }),
            "hasProperty" => RuntimeValue::Bool(
                arguments
                    .first()
                    .is_some_and(|value| file.properties.contains_key(&plain_string(value))),
            ),
            "hasTag" => {
                let needles = arguments
                    .iter()
                    .map(|value| normalize_tag(&plain_string(value)))
                    .collect::<Vec<_>>();
                RuntimeValue::Bool(needles.iter().any(|needle| {
                    file.tags
                        .iter()
                        .map(|tag| normalize_tag(tag))
                        .any(|tag| tag == *needle || tag.starts_with(&format!("{needle}/")))
                }))
            }
            "inFolder" => {
                let folder = arguments
                    .first()
                    .map(plain_string)
                    .unwrap_or_default()
                    .trim_end_matches('/')
                    .to_string();
                RuntimeValue::Bool(
                    file.folder == folder || file.folder.starts_with(&format!("{folder}/")),
                )
            }
            _ => method_not_found("File", name),
        }
    }

    fn link_method(
        &mut self,
        link: &BasesLink,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        match name {
            "asFile" if !link.external => self.file_from_link(link),
            "linksTo" if !link.external => {
                let Some(target) = arguments.first() else {
                    return RuntimeValue::Error("type\0linksTo() requires a File".into());
                };
                match target {
                    RuntimeValue::Null => RuntimeValue::Null,
                    RuntimeValue::File(target) => match self.file_from_link(link) {
                        RuntimeValue::File(file) => {
                            RuntimeValue::Bool(match (&file.witness, &target.witness) {
                                (Some(a), Some(b)) => a.entry_id == b.entry_id,
                                _ => file.path == target.path,
                            })
                        }
                        RuntimeValue::Null => RuntimeValue::Bool(false),
                        value => value,
                    },
                    _ => RuntimeValue::Error("type\0linksTo() requires a File".into()),
                }
            }
            // Obsidian applies string functions to a link's path, e.g. `link.replace(...)`.
            _ => self.string_method(&link.path, name, arguments),
        }
    }

    fn property(&self, object: RuntimeValue, property: &str) -> RuntimeValue {
        match object {
            RuntimeValue::Null => RuntimeValue::Null,
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
                if property.eq_ignore_ascii_case("length") =>
            {
                RuntimeValue::Number(value.chars().count() as f64)
            }
            RuntimeValue::Link(value) if property.eq_ignore_ascii_case("length") => {
                RuntimeValue::Number(value.path.chars().count() as f64)
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values)
                if property.eq_ignore_ascii_case("length") =>
            {
                RuntimeValue::Number(values.len() as f64)
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => property
                .parse::<isize>()
                .ok()
                .and_then(|index| index_value(&values, index))
                .unwrap_or_else(|| member_not_found("List", property)),
            RuntimeValue::Object(values) => values
                .get(own_key(&values, property).unwrap_or(property))
                .cloned()
                .unwrap_or(RuntimeValue::Null),
            RuntimeValue::Date(value) => date_property(&value, &property.to_lowercase()),
            RuntimeValue::Duration(value) => {
                let name = property.to_ascii_lowercase();
                if !duration_dependency::is_unit(&name) {
                    return member_not_found("Duration", property);
                }
                duration_semantics::property(&value, &name, &self.now)
                    .map(RuntimeValue::Number).unwrap_or_else(RuntimeValue::Error)
            }
            RuntimeValue::File(value) => {
                if value.metadata_unavailable
                    && ["tags", "properties"]
                        .iter()
                        .any(|name| property.eq_ignore_ascii_case(name))
                {
                    return RuntimeValue::Error(
                        "unavailable\0Property metadata is unavailable for this revision".into(),
                    );
                }
                if ["links", "embeds", "backlinks"].contains(&property.to_lowercase().as_str())
                    && !self
                        .context
                        .relationships
                        .is_some_and(|graph| graph.complete())
                {
                    RuntimeValue::Error(
                        "unavailable\0Relationship metadata is unavailable or incomplete".into(),
                    )
                } else {
                    file_property(&value, &property.to_lowercase(), &self.timezone)
                }
            }
            RuntimeValue::Error(message) => RuntimeValue::Error(message),
            value => member_not_found(value_type(&value), property),
        }
    }

    fn formula(&mut self, name: &str) -> RuntimeValue {
        if self.formula_stack.len() >= 128 {
            return RuntimeValue::Error("budget\0Formula depth exceeds 128".into());
        }
        let name = own_key(&self.context.formulas, name).unwrap_or(name);
        if let Some(value) = self.formula_cache.get(name) {
            return value.clone();
        }
        let Some(expression) = self.context.formulas.get(name) else {
            return RuntimeValue::Null;
        };
        if !self.formula_stack.insert(name.to_string()) {
            return RuntimeValue::Error(format!("cycle\0Circular formula reference {name}"));
        }
        let parsed = if let Some(prepared) = &self.context.preparsed_formulas {
            match prepared.expressions.get(name) {
                Some((source, parsed)) => {
                    // Compare exact admitted source before using the retained
                    // AST. Formula names alone cannot authorize stale syntax.
                    match self.charge(source.len() / 16 + expression.len() / 16 + 1) {
                        Ok(()) if source == expression => {
                            if let Err(message) = parsed {
                                if let Err(error) = self.charge(message.len() / 16 + 1) {
                                    self.formula_stack.remove(name);
                                    return error;
                                }
                            }
                            parsed.clone()
                        }
                        Ok(()) => Err("unavailable\0Prepared formula source does not match current definition".into()),
                        Err(RuntimeValue::Error(message)) => Err(message),
                        Err(_) => unreachable!(),
                    }
                }
                None => Err("unavailable\0Prepared formula definition is missing".into()),
            }
        } else {
            parse_cached_scoped(expression, Some(name))
        };
        let value = match parsed {
            Ok(expression) => match self.admit_literals(&expression) {
                Ok(()) => self.evaluate(expression.as_ref(), &BTreeMap::new()),
                Err(error) => error,
            },
            Err(message) => RuntimeValue::Error(message),
        };
        self.formula_stack.remove(name);
        self.formula_cache.insert(name.to_string(), value.clone());
        value
    }

    fn number(&self, value: &RuntimeValue) -> Result<f64, String> {
        match value {
            RuntimeValue::Number(value) => Ok(*value),
            RuntimeValue::Bool(value) => Ok(if *value { 1.0 } else { 0.0 }),
            RuntimeValue::String(value) | RuntimeValue::Tag(value) => value
                .parse()
                .map_err(|_| format!("Unable to parse {value:?} as a number.")),
            RuntimeValue::Date(value) => Ok(value.millis as f64),
            RuntimeValue::Duration(value) => duration_semantics::elapsed(value, &self.now),
            RuntimeValue::Null => Ok(0.0),
            value => Err(format!("Cannot convert {} to number", value_type(value))),
        }
    }

    fn comparison_preflight(&mut self, value: &RuntimeValue) -> Result<(), RuntimeValue> {
        self.charge(1)?;
        match value {
            RuntimeValue::Error(message) => {
                self.charge(message.len() / 16)?;
                return Err(RuntimeValue::Error(message.clone()));
            }
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
            | RuntimeValue::ErrorValue(value) => self.charge(value.len() / 16)?,
            RuntimeValue::Link(link) => self.charge(
                link.path.len().saturating_add(
                    link.resolved_path
                        .as_ref()
                        .and_then(Option::as_ref)
                        .map_or(0, String::len),
                ) / 16,
            )?,
            RuntimeValue::File(file) => self.charge(file.path.len() / 16)?,
            RuntimeValue::Regex(pattern, flags, _) => {
                self.charge(pattern.len().saturating_add(flags.len()) / 16)?
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                for value in values {
                    self.comparison_preflight(value)?;
                }
            }
            RuntimeValue::Object(values) => {
                for (key, value) in values {
                    self.charge(key.len() / 16 + 1)?;
                    self.comparison_preflight(value)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn contains_checked(
        &mut self,
        values: &[RuntimeValue],
        needle: &RuntimeValue,
    ) -> Result<bool, RuntimeValue> {
        // Validate diagnostic operands before membership short-circuiting.
        self.comparison_preflight(needle)?;
        for value in values {
            self.comparison_preflight(value)?;
        }
        for value in values {
            if self.equals_prechecked(value, needle)? {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// Shared loose comparison may resolve wiki-shaped String operands from
    /// vault root. Propagate work/cancellation/unavailable errors to every caller
    /// instead of converting them into absent membership.
    fn equals_checked(
        &mut self,
        left: &RuntimeValue,
        right: &RuntimeValue,
    ) -> Result<bool, RuntimeValue> {
        self.comparison_preflight(left)?;
        self.comparison_preflight(right)?;
        self.equals_prechecked(left, right)
    }
    fn equals_prechecked(
        &mut self,
        left: &RuntimeValue,
        right: &RuntimeValue,
    ) -> Result<bool, RuntimeValue> {
        self.charge(1)?;
        if let RuntimeValue::Tag(value) = left {
            self.charge(value.len() / 16 + 1)?;
            return self.equals_prechecked(&RuntimeValue::String(value.clone()), right);
        }
        if let RuntimeValue::Tag(value) = right {
            self.charge(value.len() / 16 + 1)?;
            return self.equals_prechecked(left, &RuntimeValue::String(value.clone()));
        }
        match (left, right) {
            (RuntimeValue::Duration(left), RuntimeValue::Duration(right)) => {
                let elapsed = |value| duration_semantics::elapsed(value, &self.now).map_err(RuntimeValue::Error);
                Ok(elapsed(left)? == elapsed(right)?)
            }
            (RuntimeValue::Object(_), RuntimeValue::Object(_)) => {
                strict_values_equal(left, right, &mut |work| self.charge(work))
            }
            (
                RuntimeValue::List(a) | RuntimeValue::TagList(a),
                RuntimeValue::List(b) | RuntimeValue::TagList(b),
            ) => {
                if a.len() != b.len() {
                    return Ok(false);
                }
                for (a, b) in a.iter().zip(b) {
                    if !self.equals_prechecked(a, b)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            (RuntimeValue::List(values), other) | (other, RuntimeValue::List(values))
                if values.len() == 1 =>
            {
                self.equals_prechecked(&values[0], other)
            }
            (RuntimeValue::Regex(_, _, a), RuntimeValue::Regex(_, _, b)) => Ok(Arc::ptr_eq(a, b)),
            (RuntimeValue::Regex(_, _, _), _) | (_, RuntimeValue::Regex(_, _, _)) => Ok(false),
            (RuntimeValue::Duration(duration), other) | (other, RuntimeValue::Duration(duration)) => {
                let Some(other) = string_data(other).and_then(parse_duration) else { return Ok(false); };
                let elapsed = |value| duration_semantics::elapsed(value, &self.now).map_err(RuntimeValue::Error);
                Ok(elapsed(duration)? == elapsed(&other)?)
            }
            (RuntimeValue::Link(link), RuntimeValue::String(text))
            | (RuntimeValue::String(text), RuntimeValue::Link(link))
                if !link.external =>
            {
                self.charge(text.len() / 16 + 1)?;
                let Some(inner) = text
                    .strip_prefix("[[")
                    .and_then(|value| value.strip_suffix("]]"))
                else {
                    // The String-side primitive fallback can match a Link's
                    // exact raw data even when it is not wiki-shaped.
                    return Ok(link.path == *text);
                };
                // xK.parseFromString uses the last alias delimiter. No path or
                // note metadata is supplied by this String; authority comes
                // only from the immutable namespace below.
                let path = inner.rsplit_once('|').map_or(inner, |(path, _)| path);
                let mut parsed = BasesLink {
                    path: path.into(),
                    subpath: link_subpath(path),
                    ..Default::default()
                };
                let graph = self.context.relationships.ok_or_else(|| {
                    RuntimeValue::Error(
                        "unavailable\0Wiki String equality requires a captured namespace".into(),
                    )
                })?;
                if !graph.complete() {
                    return Err(RuntimeValue::Error(
                        "unavailable\0Wiki String equality requires a complete captured namespace"
                            .into(),
                    ));
                }
                let resolved = self.resolve_target(path)?;
                parsed.target = resolved.as_ref().map(|(_, witness)| witness.clone());
                parsed.resolved_path = Some(resolved.map(|(path, _)| path));
                Ok(links_loosely_equal(link, &parsed) || link.path == *text)
            }
            _ => {
                // Scalar fallback may materialize plain values. Membership
                // reuses a needle across pairs, so its upfront validation
                // cannot pay for these repeated copies. Charge each pair's
                // complete fallback trees before invoking the converter.
                self.comparison_preflight(left)?;
                self.comparison_preflight(right)?;
                Ok(self.equals(left, right))
            }
        }
    }

    fn equals(&self, left: &RuntimeValue, right: &RuntimeValue) -> bool {
        match (left, right) {
            (RuntimeValue::ErrorValue(left), RuntimeValue::ErrorValue(right)) => {
                error_message(left) == error_message(right)
            }
            (RuntimeValue::ErrorValue(_), _) | (_, RuntimeValue::ErrorValue(_)) => false,
            (RuntimeValue::Link(left), RuntimeValue::Link(right)) => {
                links_loosely_equal(left, right)
            }
            (RuntimeValue::Link(left), RuntimeValue::File(right)) => {
                left.path == right.path
                    || self
                        .link_resolved(left)
                        .is_some_and(|path| path == right.path)
            }
            (RuntimeValue::File(left), RuntimeValue::Link(right)) => {
                left.path == right.path
                    || self
                        .link_resolved(right)
                        .is_some_and(|path| path == left.path)
            }
            (RuntimeValue::Date(left), RuntimeValue::Date(right)) => {
                dates_loosely_equal(left, right)
            }
            (RuntimeValue::Date(date), RuntimeValue::String(text))
            | (RuntimeValue::String(text), RuntimeValue::Date(date)) => {
                parse_frontmatter_date(text, &self.context.timezone)
                    .is_some_and(|other| dates_loosely_equal(date, &other))
            }
            (RuntimeValue::Date(date), RuntimeValue::Link(link))
            | (RuntimeValue::Link(link), RuntimeValue::Date(date)) => {
                parse_frontmatter_date(&link.path, &self.context.timezone)
                    .is_some_and(|other| dates_loosely_equal(date, &other))
            }
            (RuntimeValue::Null, RuntimeValue::Null) => true,
            (RuntimeValue::Null, _) | (_, RuntimeValue::Null) => false,
            (
                RuntimeValue::List(a) | RuntimeValue::TagList(a),
                RuntimeValue::List(b) | RuntimeValue::TagList(b),
            ) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| self.equals(a, b)),
            (RuntimeValue::List(a) | RuntimeValue::TagList(a), b) if a.len() == 1 => {
                self.equals(&a[0], b)
            }
            (a, RuntimeValue::List(b) | RuntimeValue::TagList(b)) if b.len() == 1 => {
                self.equals(a, &b[0])
            }
            (RuntimeValue::Regex(_, _, a), RuntimeValue::Regex(_, _, b)) => Arc::ptr_eq(a, b),
            (RuntimeValue::Regex(_, _, _), _) | (_, RuntimeValue::Regex(_, _, _)) => false,
            (RuntimeValue::String(a), RuntimeValue::Number(b))
            | (RuntimeValue::Number(b), RuntimeValue::String(a)) => {
                loose_numeric_text(a) == Some(*b)
            }
            (RuntimeValue::Link(link), RuntimeValue::Number(number))
            | (RuntimeValue::Number(number), RuntimeValue::Link(link)) => {
                loose_numeric_text(&link.path) == Some(*number)
            }
            (RuntimeValue::Link(link), RuntimeValue::Bool(boolean))
            | (RuntimeValue::Bool(boolean), RuntimeValue::Link(link)) => {
                loose_numeric_text(&link.path) == Some(if *boolean { 1.0 } else { 0.0 })
            }
            (RuntimeValue::Bool(a), RuntimeValue::Number(b))
            | (RuntimeValue::Number(b), RuntimeValue::Bool(a)) => {
                (if *a { 1.0 } else { 0.0 }) == *b
            }
            (RuntimeValue::Bool(a), RuntimeValue::String(b))
            | (RuntimeValue::String(b), RuntimeValue::Bool(a)) => {
                loose_numeric_text(b) == Some(if *a { 1.0 } else { 0.0 })
            }
            _ => to_plain(left) == to_plain(right),
        }
    }

    fn compare(
        &self,
        left: &RuntimeValue,
        right: &RuntimeValue,
        operator: &str,
    ) -> Result<bool, String> {
        // Duration comparison uses the same captured calendar anchor as fields
        // and loose equality. Only the right String is duration-coerced here,
        // matching the reference's asymmetric relational dispatch.
        if matches!(left, RuntimeValue::Duration(_)) || matches!(right, RuntimeValue::Duration(_)) {
            let numeric = |value: &RuntimeValue| -> Result<f64, String> {
                match value {
                    RuntimeValue::Duration(value) => duration_semantics::elapsed(value, &self.now),
                    RuntimeValue::Date(value) => Ok(value.millis as f64),
                    RuntimeValue::Number(value) => Ok(*value),
                    value => Ok(loose_numeric_text(&plain_string(value)).unwrap_or(f64::NAN)),
                }
            };
            let a = numeric(left)?;
            let b = if matches!(left, RuntimeValue::Duration(_)) {
                match string_data(right).and_then(parse_duration) {
                    Some(value) => duration_semantics::elapsed(&value, &self.now)?,
                    None => numeric(right)?,
                }
            } else {numeric(right)?};
            return Ok(match operator {">" => a > b, "<" => a < b, ">=" => a >= b, _ => a <= b});
        }
        let ordering = if let (
            RuntimeValue::String(left) | RuntimeValue::Tag(left),
            RuntimeValue::String(right) | RuntimeValue::Tag(right),
        ) = (left, right)
        {
            left.cmp(right)
        } else {
            self.number(left)?
                .partial_cmp(&self.number(right)?)
                .unwrap_or(std::cmp::Ordering::Equal)
        };
        Ok(match operator {
            ">" => ordering.is_gt(),
            "<" => ordering.is_lt(),
            ">=" => !ordering.is_lt(),
            _ => !ordering.is_gt(),
        })
    }

    fn make_link(&mut self, target: &str, display: Option<RuntimeValue>) -> RuntimeValue {
        let (path, parsed_display) = parse_link_text(target);
        // A parsed wiki constructor is returned directly by the registration;
        // its embedded alias wins even when a display argument was supplied.
        let display = if target.starts_with("[[") && target.ends_with("]]") {
            parsed_display.clone().map(RuntimeValue::String)
        } else {
            display
        };
        let external = is_external(&path);
        let resolved = if external || self.context.relationships.is_none() {
            None
        } else {
            match self.resolve_target(&path) {
                Ok(value) => value,
                Err(error) => return error,
            }
        };
        RuntimeValue::Link(BasesLink {
            raw_destination: Some(path.clone()),
            source_path: Some(String::new()),
            subpath: link_subpath(&path),
            target: resolved.as_ref().map(|(_, witness)| witness.clone()),
            resolved_path: if external || self.context.relationships.is_some() {
                Some(resolved.map(|(path, _)| path))
            } else {
                None
            },
            external,
            path,
            display: display.as_ref().map(plain_string).or(parsed_display),
            display_value: display.map(Box::new),
        })
    }

    fn resolve_target(
        &mut self,
        target: &str,
    ) -> Result<Option<(String, super::RecordWitness)>, RuntimeValue> {
        let Some(graph) = self.context.relationships else {
            return Err(RuntimeValue::Error(
                "unavailable\0File resolution requires immutable generation metadata".into(),
            ));
        };
        let mut check = |work: usize| {
            if self
                .context
                .cancellation
                .as_ref()
                .is_some_and(|c| c.stop_reason().is_some())
            {
                return Err(ExpressionDiagnostic::new("cancelled", "Query cancelled"));
            }
            self.remaining_work = self.remaining_work.checked_sub(work).ok_or_else(|| {
                ExpressionDiagnostic::new("budget", "File resolver exceeds work budget")
            })?;
            Ok(())
        };
        graph
            .resolve_target(&BasesFile::default(), target, &mut check)
            .map_err(|error| RuntimeValue::Error(format!("{}\0{}", error.code, error.message)))
    }

    fn file_from_target(&mut self, target: &str) -> RuntimeValue {
        let (target, _) = parse_link_text(target);
        match self.resolve_target(&target) {
            Ok(None) => RuntimeValue::Null,
            Err(error) => error,
            Ok(Some((path, witness))) => self.hydrated_file(&path, Some(&witness)),
        }
    }

    fn hydrated_file(&self, path: &str, witness: Option<&super::RecordWitness>) -> RuntimeValue {
        match self.context.files.by_path(path) {
            Some(file)
                if witness.is_none_or(|expected| file.witness.as_ref() == Some(expected)) =>
            {
                RuntimeValue::File(Box::new(file.clone()))
            }
            _ => RuntimeValue::Error(
                "unavailable\0Resolved file metadata is unavailable for this generation".into(),
            ),
        }
    }

    fn file_from_link(&mut self, link: &BasesLink) -> RuntimeValue {
        if link.external {
            return RuntimeValue::Null;
        }
        // Witnessed links keep captured identity even after a BaseValue
        // roundtrip has lost the original runtime-only resolution path.
        if let Some(witness) = &link.target {
            return match self.context.files.by_witness(witness) {
                Some(file) => RuntimeValue::File(Box::new(file.clone())),
                None => RuntimeValue::Error(
                    "unavailable\0Witnessed link metadata is unavailable in this snapshot".into(),
                ),
            };
        }
        // A resolved edge carries immutable identity and revision. Never fabricate
        // empty properties for an existing target or re-resolve an explicitly broken edge.
        match &link.resolved_path {
            Some(Some(path)) => self.hydrated_file(path, link.target.as_ref()),
            Some(None) => RuntimeValue::Null,
            None => self.file_from_target(&link.path),
        }
    }

    fn resolve_link(&self, _target: &str) -> Option<String> {
        // Legacy equality helpers never resolve raw text through ambient state.
        None
    }

    fn link_resolved(&self, link: &BasesLink) -> Option<String> {
        link.resolved_path.clone().flatten()
    }

    fn link_identity(&self, link: &BasesLink) -> String {
        self.link_resolved(link)
            .map(|path| format!("file:{path}"))
            .unwrap_or_else(|| format!("link:{}", link.path))
    }

    fn link_matches(&self, link: &BasesLink, target: &RuntimeValue) -> bool {
        let target_path = match target {
            RuntimeValue::File(file) => file.path.clone(),
            RuntimeValue::Link(link) => link.path.clone(),
            value => parse_link_text(&plain_string(value)).0,
        };
        if link.path == target_path {
            return true;
        }
        if self.link_is_broken(link) || self.target_is_broken(target, &target_path) {
            return false;
        }
        let left = self.link_resolved(link);
        let right = match target {
            RuntimeValue::File(file) => Some(file.path.clone()),
            RuntimeValue::Link(link) => self.link_resolved(link),
            _ => self.resolve_link(&target_path),
        };
        match (left, right) {
            (Some(left), Some(right)) => left == right,
            _ => same_markdown_variant(&link.path, &target_path),
        }
    }

    fn link_is_broken(&self, link: &BasesLink) -> bool {
        if link.resolved_path == Some(None) {
            return true;
        }
        link_resolution_keys(&link.path)
            .into_iter()
            .any(|candidate| {
                self.context.link_resolutions.get(&candidate) == Some(&None)
                    || self.context.link_resolutions.get(&candidate.to_lowercase()) == Some(&None)
            })
    }

    fn target_is_broken(&self, target: &RuntimeValue, target_path: &str) -> bool {
        match target {
            RuntimeValue::File(_) => false,
            RuntimeValue::Link(link) => self.link_is_broken(link),
            _ => link_resolution_keys(target_path)
                .into_iter()
                .any(|candidate| {
                    self.context.link_resolutions.get(&candidate) == Some(&None)
                        || self.context.link_resolutions.get(&candidate.to_lowercase())
                            == Some(&None)
                }),
        }
    }
}

fn numeric_pair(
    _evaluator: &Evaluator<'_>,
    left: &RuntimeValue,
    right: &RuntimeValue,
    operation: impl Fn(f64, f64) -> f64,
) -> RuntimeValue {
    match (left, right) {
        (RuntimeValue::Number(a), RuntimeValue::Number(b)) => {
            RuntimeValue::Number(operation(*a, *b))
        }
        _ => RuntimeValue::Error("type\0Arithmetic operands must be numbers".into()),
    }
}

fn from_json(value: &Value, _hint: Option<&str>) -> RuntimeValue {
    if let Some(link) = runtime_link_from_json(value) {
        return RuntimeValue::Link(link);
    }
    match value {
        Value::Null => RuntimeValue::Null,
        Value::Bool(value) => RuntimeValue::Bool(*value),
        Value::Number(value) => RuntimeValue::Number(value.as_f64().unwrap_or(f64::NAN)),
        Value::String(value) => RuntimeValue::String(value.clone()),
        Value::Array(values) => {
            RuntimeValue::List(values.iter().map(|value| from_json(value, None)).collect())
        }
        Value::Object(values) => RuntimeValue::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), from_json(value, None)))
                .collect(),
        ),
    }
}

fn runtime_link_from_json(value: &Value) -> Option<BasesLink> {
    let object = value.as_object()?;
    if object.get("type").and_then(Value::as_str) != Some("Link") {
        return None;
    }
    let link = object.get("value")?.as_object()?;
    let path = link.get("path")?.as_str()?;
    // A legacy structured Link path has no raw-destination provenance. Never
    // guess its fragment: literal # filenames are valid identity paths.
    let subpath = match link.get("subpath") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.starts_with('#') => Some(value.clone()),
        _ => return None,
    };
    Some(BasesLink {
        raw_destination: None,
        source_path: None,
        subpath,
        target: None,
        path: path.to_string(),
        display: link.get("display").map(runtime_display_string),
        display_value: None,
        resolved_path: link
            .get("resolvedPath")
            .map(|value| value.as_str().map(String::from)),
        external: link
            .get("external")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn runtime_display_string(value: &Value) -> String {
    value
        .as_object()
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("String"))
        .and_then(|value| value.get("value"))
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| plain_string(&from_json(value, None)))
}

fn to_plain(value: &RuntimeValue) -> Value {
    match value {
        RuntimeValue::Null => Value::Null,
        RuntimeValue::Bool(value) => Value::Bool(*value),
        RuntimeValue::Number(value) => number_json(*value),
        RuntimeValue::String(value)
        | RuntimeValue::Tag(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Icon(value)
        | RuntimeValue::Image(value) => Value::String(value.clone()),
        RuntimeValue::Date(value) => Value::String(format_date(
            value,
            if value.date_only {
                "YYYY-MM-DD"
            } else {
                "YYYY-MM-DDTHH:mm:ss"
            },
        )),
        RuntimeValue::Duration(value) => Value::String(format_duration(value)),
        RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
            Value::Array(values.iter().map(to_plain).collect())
        }
        RuntimeValue::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), to_plain(value)))
                .collect(),
        ),
        RuntimeValue::File(value) => Value::String(value.path.clone()),
        RuntimeValue::Link(value) => Value::String(value.path.clone()),
        RuntimeValue::Regex(pattern, flags, _) => Value::String(regex_string(pattern, flags)),
        RuntimeValue::Error(message) | RuntimeValue::ErrorValue(message) => Value::Object(
            Map::from_iter([("error".to_string(), Value::String(message.clone()))]),
        ),
    }
}

fn plain_string(value: &RuntimeValue) -> String {
    match value {
        RuntimeValue::Null => "null".to_string(),
        RuntimeValue::Bool(value) => value.to_string(),
        RuntimeValue::Number(value) => format_number(*value),
        RuntimeValue::String(value)
        | RuntimeValue::Tag(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Icon(value) => value.clone(),
        RuntimeValue::Date(value) => format_date(
            value,
            if value.date_only {
                "YYYY-MM-DD"
            } else {
                "YYYY-MM-DDTHH:mm:ss"
            },
        ),
        RuntimeValue::Duration(value) => format_duration(value),
        RuntimeValue::List(values) | RuntimeValue::TagList(values) => values
            .iter()
            .map(plain_string)
            .collect::<Vec<_>>()
            .join(", "),
        RuntimeValue::Object(_) => serde_json::to_string(&to_plain(value)).unwrap_or_default(),
        RuntimeValue::File(value) => value.path.clone(),
        RuntimeValue::Link(value) if value.external => value.path.clone(),
        RuntimeValue::Link(value) => {
            // Raw destinations already contain their fragment. Resolved
            // relation projections carry a canonical file path plus explicit
            // destination metadata; restore that metadata exactly once.
            let data = if value.resolved_path.as_ref().and_then(Option::as_deref)
                == Some(value.path.as_str())
            {
                value
                    .subpath
                    .as_ref()
                    .map(|subpath| format!("{}{subpath}", value.path))
            } else {
                None
            };
            let data = data.as_deref().unwrap_or(&value.path);
            value
                .display
                .as_ref()
                .map(|display| format!("[[{data}|{display}]]"))
                .unwrap_or_else(|| format!("[[{data}]]"))
        }
        RuntimeValue::Regex(pattern, flags, _) => regex_string(pattern, flags),
        RuntimeValue::Image(value) => super::order::image_text(value),
        RuntimeValue::ErrorValue(message) => format!("Error: {}", error_message(message)),
        RuntimeValue::Error(message) => message.clone(),
    }
}

fn stringify(value: &RuntimeValue) -> String {
    plain_string(value)
}

fn is_truthy(value: &RuntimeValue) -> bool {
    match value {
        RuntimeValue::Null | RuntimeValue::Error(_) | RuntimeValue::ErrorValue(_) => false,
        RuntimeValue::Bool(value) => *value,
        RuntimeValue::Number(value) => *value != 0.0 && !value.is_nan(),
        RuntimeValue::String(value)
        | RuntimeValue::Tag(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Image(value)
        | RuntimeValue::Icon(value) => !value.is_empty(),
        RuntimeValue::Link(link) if link.external => !link.path.is_empty(),
        RuntimeValue::List(value) | RuntimeValue::TagList(value) => !value.is_empty(),
        RuntimeValue::Object(value) => !value.is_empty(),
        RuntimeValue::Duration(value) => [value.years, value.months, value.weeks, value.days,
            value.hours, value.minutes, value.seconds, value.milliseconds].iter().any(|part| *part != 0.0),
        _ => true,
    }
}

fn is_empty(value: &RuntimeValue) -> bool {
    match value {
        RuntimeValue::Null => true,
        RuntimeValue::String(value)
        | RuntimeValue::Tag(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Image(value)
        | RuntimeValue::Icon(value) => value.is_empty(),
        RuntimeValue::Link(link) => link.path.is_empty(),
        RuntimeValue::Number(value) => value.is_nan(),
        RuntimeValue::List(values) | RuntimeValue::TagList(values) => values.is_empty(),
        RuntimeValue::Object(values) => values.is_empty(),
        _ => false,
    }
}

fn value_type(value: &RuntimeValue) -> &'static str {
    match value {
        RuntimeValue::Null => "Null",
        RuntimeValue::Bool(_) => "Boolean",
        RuntimeValue::Number(_) => "Number",
        RuntimeValue::String(_) | RuntimeValue::Tag(_) => "String",
        RuntimeValue::Date(_) => "Date",
        RuntimeValue::Duration(_) => "Duration",
        RuntimeValue::List(_) | RuntimeValue::TagList(_) => "List",
        RuntimeValue::Object(_) => "Object",
        RuntimeValue::File(_) => "File",
        RuntimeValue::Link(value) if value.external => "URL",
        RuntimeValue::Link(_) => "Link",
        RuntimeValue::Regex(_, _, _) => "RegExp",
        RuntimeValue::Html(_) => "HTML",
        RuntimeValue::Image(_) => "Image",
        RuntimeValue::Icon(_) => "Icon",
        RuntimeValue::Error(_) | RuntimeValue::ErrorValue(_) => "Error",
    }
}

fn member_not_found(kind: &str, property: &str) -> RuntimeValue {
    RuntimeValue::Error(format!("access\0Cannot find \"{property}\" on type {kind}"))
}
fn method_not_found(kind: &str, method: &str) -> RuntimeValue {
    RuntimeValue::Error(format!(
        "unknown-function\0Cannot find function \"{method}\" on type {kind}"
    ))
}

fn number_json(value: f64) -> Value {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value <= i64::MAX as f64
    {
        return Value::Number((value as i64).into());
    }
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn format_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    if value.abs() >= 1e21 || value.abs() < 1e-6 {
        let text = format!("{value:e}");
        text.split_once('e')
            .map(|(mantissa, exponent)| {
                format!(
                    "{mantissa}e{}{exponent}",
                    if exponent.starts_with('-') { "" } else { "+" }
                )
            })
            .unwrap_or(text)
    } else {
        // Shortest round-trip decimal, rather than expanding the exact binary
        // integer; e.g.1000000000000000100 is not rendered as...0128.
        value.to_string()
    }
}

fn fixed_number(value: f64, precision: f64) -> Result<String, RuntimeValue> {
    let precision = precision.trunc();
    if precision < 0.0 {
        return Err(RuntimeValue::Error(
            "type\0Numeric precision must be nonnegative".into(),
        ));
    }
    if precision > 100.0 {
        return Err(RuntimeValue::Error(
            "budget\0Numeric precision exceeds 100".into(),
        ));
    }
    let digits = precision as usize;
    if value.abs() >= 1e21 {
        let text = format!("{value:e}");
        return Ok(text
            .split_once('e')
            .map(|(mantissa, exponent)| {
                format!(
                    "{mantissa}e{}{exponent}",
                    if exponent.starts_with('-') { "" } else { "+" }
                )
            })
            .unwrap_or(text));
    }
    let magnitude = value.abs();
    let mut text = format!("{magnitude:.digits$}");
    // The formatter rounds the exact binary value ties-to-even; JS toFixed
    // selects the larger integer at an exact positive tie. After removing the
    // mantissa's powers of two, an exact half has exponent -1. Multiplying by
    // 5^digits leaves its value modulo four unchanged, identifying the ties
    // the formatter rounded down without an imprecise floating multiplication.
    let bits = magnitude.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1_u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1_u64 << 52 };
    if mantissa != 0 {
        let zeros = mantissa.trailing_zeros();
        let binary_exponent = if exponent == 0 {
            -1074
        } else {
            exponent - 1023 - 52
        };
        if binary_exponent + digits as i32 + zeros as i32 == -1 && (mantissa >> zeros) & 3 == 1 {
            let mut bytes = text.into_bytes();
            let mut carry = true;
            for digit in bytes.iter_mut().rev() {
                if *digit == b'.' {
                    continue;
                }
                if *digit == b'9' {
                    *digit = b'0';
                } else {
                    *digit += 1;
                    carry = false;
                    break;
                }
            }
            if carry {
                bytes.insert(0, b'1');
            }
            text = String::from_utf8(bytes).expect("formatted decimal digits");
        }
    }
    // A negative input may round to zero, but negative zero itself prints as0.
    if value < 0.0 {
        text.insert(0, '-');
    }
    Ok(text)
}

fn parse_timezone_offset(value: &str) -> Option<FixedOffset> {
    let sign = match value.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let (hours, minutes) = value.get(1..)?.split_once(':')?;
    // Keep the existing accepted component spelling, but never let an
    // untrusted offset overflow before chrono can reject its range.
    let hours = hours.parse::<i32>().ok()?.checked_mul(3_600)?;
    let minutes = minutes.parse::<i32>().ok()?.checked_mul(60)?;
    let seconds = hours.checked_add(minutes)?.checked_mul(sign)?;
    FixedOffset::east_opt(seconds)
}

/// Numeric conversion for primitive loose equality follows the String side's
/// Number semantics, including empty/whitespace and unsigned radix literals.
/// It is intentionally separate from explicit number() and parseFloat().
fn ecmascript_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn loose_numeric_text(value: &str) -> Option<f64> {
    let value = value.trim_matches(ecmascript_whitespace);
    if value.is_empty() {
        return Some(0.0);
    }
    let radix = if value.starts_with("0x") || value.starts_with("0X") {
        Some(16)
    } else if value.starts_with("0b") || value.starts_with("0B") {
        Some(2)
    } else if value.starts_with("0o") || value.starts_with("0O") {
        Some(8)
    } else {
        None
    };
    if let Some(radix) = radix {
        let digits = &value[2..];
        if digits.is_empty() {
            return None;
        }
        // Round the binary integer once, as Number(string) does. Repeated
        // floating multiply/add can discard a low bit before a later digit
        // crosses the halfway boundary (even for ordinary 16-digit hex).
        let width = match radix {
            2 => 1,
            8 => 3,
            16 => 4,
            _ => unreachable!(),
        };
        let (mut bits, mut significand, mut guard, mut sticky) = (0usize, 0u64, false, false);
        for digit in digits.chars() {
            let digit = digit.to_digit(radix)?;
            for shift in (0..width).rev() {
                let bit = (digit >> shift) & 1;
                if bits == 0 && bit == 0 {
                    continue;
                }
                bits = bits.saturating_add(1);
                if bits <= 53 {
                    significand = (significand << 1) | u64::from(bit);
                } else if bits == 54 {
                    guard = bit != 0;
                } else {
                    sticky |= bit != 0;
                }
            }
        }
        if bits <= 53 {
            return Some(significand as f64);
        }
        if bits > 1024 {
            return Some(f64::INFINITY);
        }
        if guard && (sticky || significand & 1 != 0) {
            significand += 1;
        }
        return Some((significand as f64) * 2.0f64.powi((bits - 53) as i32));
    }
    static DECIMAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$")
            .expect("loose numeric shape")
    });
    DECIMAL
        .is_match(value)
        .then(|| value.parse::<f64>().ok())
        .flatten()
}

fn links_loosely_equal(left: &BasesLink, right: &BasesLink) -> bool {
    match (
        left.resolved_path.as_ref().and_then(Option::as_deref),
        right.resolved_path.as_ref().and_then(Option::as_deref),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => left.path == right.path,
    }
}

fn dates_loosely_equal(left: &DateValue, right: &DateValue) -> bool {
    if left.date_only || right.date_only {
        left.timezone.local_datetime(left.millis).date()
            == right.timezone.local_datetime(right.millis).date()
    } else {
        left.millis == right.millis
    }
}
/// Frontmatter and loose Date/String equality recognize only the shipped
/// date-shaped syntax. Explicit date() additionally accepts compact forms.
fn parse_frontmatter_date(value: &str, timezone: &BasesTimezone) -> Option<DateValue> {
    static SHAPE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)$").expect("frontmatter date shape")
    });
    if value.len() > 40 || !SHAPE.is_match(value) {
        return None;
    }
    parse_date(value, timezone)
}

fn parse_date(value: &str, timezone: &BasesTimezone) -> Option<DateValue> {
    if let Ok(date) = NaiveDate::parse_from_str(
        value,
        if value.len() == 8 && value.bytes().all(|b| b.is_ascii_digit()) {
            "%Y%m%d"
        } else {
            "%Y-%m-%d"
        },
    ) {
        let local = date.and_hms_opt(0, 0, 0)?;
        return Some(DateValue {
            millis: timezone.try_millis_from_local(local)?,
            date_only: true,
            timezone: timezone.clone(),
        });
    }
    if let Ok(value) = DateTime::parse_from_rfc3339(value) {
        return Some(DateValue {
            millis: value.timestamp_millis(),
            date_only: false,
            timezone: timezone.clone(),
        });
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f%#z",
        "%Y-%m-%dT%H:%M:%S%.f%#z",
        "%Y-%m-%d %H:%M%#z",
        "%Y-%m-%dT%H:%M%#z",
    ] {
        if let Ok(date) = DateTime::parse_from_str(value, format) {
            return Some(DateValue {
                millis: date.timestamp_millis(),
                date_only: false,
                timezone: timezone.clone(),
            });
        }
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y%m%d%H%M",
        "%Y%m%d",
    ] {
        if let Ok(value) = NaiveDateTime::parse_from_str(value, format) {
            return Some(DateValue {
                millis: timezone.try_millis_from_local(value)?,
                date_only: false,
                timezone: timezone.clone(),
            });
        }
    }
    None
}

fn civil_day_start(
    timezone: &BasesTimezone,
    date: NaiveDate,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<i64, RuntimeValue> {
    let candidate = timezone.midnight_forward(date, None, check)?;
    check(1)?;
    candidate
        .filter(|millis| timezone.local_datetime(*millis).date() == date)
        .ok_or_else(|| {
            RuntimeValue::Error(
                "invalid-local-time\0Civil date has no representable instant".into(),
            )
        })
}

fn start_of_day(
    value: &DateValue,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<DateValue, RuntimeValue> {
    check(1)?;
    if DateTime::<Utc>::from_timestamp_millis(value.millis).is_none() {
        return Err(RuntimeValue::Error(
            "invalid-local-time\0Invalid day-truncation instant".into(),
        ));
    }
    check(1)?;
    let date = value.timezone.local_datetime(value.millis).date();
    let millis = civil_day_start(&value.timezone, date, check)?;
    Ok(DateValue {
        millis,
        date_only: true,
        timezone: value.timezone.clone(),
    })
}

#[cfg(test)]
mod civil_day_value_tests {
    use super::*;

    fn evaluate(
        source: &str,
        clock_ms: i64,
        timezone: &str,
    ) -> Result<BaseValue, ExpressionDiagnostic> {
        crate::evaluate_expression(
            source,
            &crate::DetachedRecord::default(),
            &crate::EvaluationOptions {
                clock_ms,
                timezone: timezone.into(),
                ..Default::default()
            },
        )
        .map(|result| result.value)
    }

    #[test]
    fn valid_sao_paulo_instant_truncates_to_same_day_after_midnight_gap() {
        // 2018-11-04T03:30Z is01:30-02; that day's first local instant is01:00.
        for source in [
            "today()",
            "date('2018-11-04T03:30:00Z').date()",
            "today().date()",
        ] {
            assert_eq!(
                evaluate(source, 1_541_302_200_000, "America/Sao_Paulo").unwrap(),
                BaseValue::Date {
                    timestamp: 1_541_300_400_000,
                    has_time: false
                },
                "{source}"
            );
        }
        assert_eq!(
            evaluate("today().toString()", 1_541_302_200_000, "America/Sao_Paulo").unwrap(),
            BaseValue::String {
                value: "2018-11-04".into()
            }
        );
        assert_eq!(
            evaluate("today() == now()", 1_541_302_200_000, "America/Sao_Paulo").unwrap(),
            BaseValue::Boolean { value: true }
        );
    }

    #[test]
    fn late_havana_fold_keeps_earliest_midnight_even_when_it_precedes_clock() {
        // Captured00:30-05 follows both midnights; retain the first,00:00-04.
        for source in ["today()", "date('2024-11-03T05:30:00Z').date()"] {
            assert_eq!(
                evaluate(source, 1_730_611_800_000, "America/Havana").unwrap(),
                BaseValue::Date {
                    timestamp: 1_730_606_400_000,
                    has_time: false
                },
                "{source}"
            );
        }
        assert_eq!(
            evaluate("today().toString()", 1_730_611_800_000, "America/Havana").unwrap(),
            BaseValue::String {
                value: "2024-11-03".into()
            }
        );
    }

    #[test]
    fn skipped_civil_input_and_nonunique_local_arithmetic_keep_strict_policy() {
        // A valid Apia clock is alreadyDec31; no instant belonged toDec30.
        assert_eq!(
            evaluate("today()", 1_325_241_000_000, "Pacific/Apia").unwrap(),
            BaseValue::Date {
                timestamp: 1_325_239_200_000,
                has_time: false
            }
        );
        for (source, zone) in [
            ("date('2011-12-30')", "Pacific/Apia"),
            ("date('2018-11-04')", "America/Sao_Paulo"),
            ("date('2024-11-03')", "America/Havana"),
            ("date('2024-03-10T02:30:00')", "America/Toronto"),
            ("date('2024-11-03T01:30:00')", "America/Toronto"),
        ] {
            assert_eq!(
                evaluate(source, 1_541_302_200_000, zone).unwrap(),
                BaseValue::Null,
                "{source}"
            );
        }
        assert_eq!(
            evaluate(
                "date('2018-11-03') + duration('1d')",
                1_541_302_200_000,
                "America/Sao_Paulo"
            )
            .unwrap_err()
            .code,
            "invalid-local-time"
        );
        let record = crate::DetachedRecord {
            properties: vec![(
                "plan".into(),
                crate::PropertyValue::String("2011-12-30".into()),
            )],
            property_types: vec![("plan".into(), crate::PropertyType::Date)],
            ..Default::default()
        };
        assert_eq!(
            crate::evaluate_expression(
                "plan",
                &record,
                &crate::EvaluationOptions {
                    clock_ms: 1_325_241_000_000,
                    timezone: "Pacific/Apia".into(),
                    ..Default::default()
                }
            )
            .unwrap()
            .value,
            BaseValue::Null
        );
    }

    #[test]
    fn ordinary_utc_fixed_and_named_day_values_are_preserved() {
        for (zone, expected) in [
            ("UTC", 1_705_276_800_000),
            ("+05:30", 1_705_257_000_000),
            ("America/Toronto", 1_705_294_800_000),
        ] {
            assert_eq!(
                evaluate("today()", 1_705_314_030_000, zone).unwrap(),
                BaseValue::Date {
                    timestamp: expected,
                    has_time: false
                },
                "{zone}"
            );
            assert_eq!(
                evaluate(
                    "date('2024-01-15T10:20:30Z').date()",
                    1_705_314_030_000,
                    zone
                )
                .unwrap(),
                BaseValue::Date {
                    timestamp: expected,
                    has_time: false
                },
                "{zone}"
            );
        }
    }

    #[test]
    fn row_day_guard_rejects_skipped_date_but_deadline_can_cross_it() {
        let zone = BasesTimezone::from_setting(Some("Pacific/Apia")).unwrap();
        let skipped = NaiveDate::from_ymd_opt(2011, 12, 30).unwrap();
        let error = civil_day_start(&zone, skipped, &mut |_| Ok(())).unwrap_err();
        let RuntimeValue::Error(message) = error else {
            panic!("expected structured error")
        };
        assert_eq!(
            message,
            "invalid-local-time\0Civil date has no representable instant"
        );
        assert_eq!(
            refresh_deadline(
                crate::query::BaseClockDependency::Day,
                1_325_160_000_000,
                "Pacific/Apia",
                &mut |_| Ok(())
            )
            .unwrap(),
            Some(("Pacific/Apia".into(), Some(1_325_239_200_000)))
        );
        let error = civil_day_start(&zone, skipped, &mut |_| {
            Err(RuntimeValue::Error("cancelled\0stop".into()))
        })
        .unwrap_err();
        let RuntimeValue::Error(message) = error else {
            panic!("expected cancellation")
        };
        assert_eq!(message, "cancelled\0stop");
    }
}

fn format_date(value: &DateValue, pattern: &str) -> String {
    try_format_date(value, pattern).unwrap_or_default()
}
fn try_format_date(value: &DateValue, pattern: &str) -> Result<String, String> {
    date_format::format(value, pattern)
}

fn date_property(value: &DateValue, property: &str) -> RuntimeValue {
    let date = value.timezone.local_datetime(value.millis);
    let number = match property {
        "year" => date.year() as f64,
        "month" => date.month() as f64,
        "day" => date.day() as f64,
        "hour" => date.hour() as f64,
        "minute" => date.minute() as f64,
        "second" => date.second() as f64,
        "millisecond" => date.and_utc().timestamp_subsec_millis() as f64,
        _ => return member_not_found("Date", property),
    };
    RuntimeValue::Number(number)
}

fn parse_duration(value: &str) -> Option<DurationValue> {
    duration_semantics::parse(value)
}

fn duration_millis(value: &DurationValue) -> f64 {
    value.milliseconds
        + value.seconds * 1_000.0
        + value.minutes * 60_000.0
        + value.hours * 3_600_000.0
        + value.days * 86_400_000.0
        + value.weeks * 604_800_000.0
}

fn add_duration(value: &DateValue, duration: &DurationValue, direction: f64) -> Result<DateValue, String> {
    duration_semantics::add(value, duration, direction)
}

fn duration_finite(value: &DurationValue) -> bool {
    [
        value.years,
        value.months,
        value.weeks,
        value.days,
        value.hours,
        value.minutes,
        value.seconds,
        value.milliseconds,
    ]
    .iter()
    .all(|value| value.is_finite())
}

fn add_durations(left: &DurationValue, right: &DurationValue) -> DurationValue {
    DurationValue {
        years: left.years + right.years,
        months: left.months + right.months,
        weeks: left.weeks + right.weeks,
        days: left.days + right.days,
        hours: left.hours + right.hours,
        minutes: left.minutes + right.minutes,
        seconds: left.seconds + right.seconds,
        milliseconds: left.milliseconds + right.milliseconds,
    }
}
fn scale_duration(value: &DurationValue, scale: f64) -> DurationValue {
    DurationValue {
        years: value.years * scale,
        months: value.months * scale,
        weeks: value.weeks * scale,
        days: value.days * scale,
        hours: value.hours * scale,
        minutes: value.minutes * scale,
        seconds: value.seconds * scale,
        milliseconds: value.milliseconds * scale,
    }
}
fn coerce_duration(value: &RuntimeValue) -> Option<DurationValue> {
    match value {
        RuntimeValue::Duration(value) => Some(value.clone()),
        RuntimeValue::String(value) | RuntimeValue::Tag(value) => parse_duration(value),
        _ => None,
    }
}

fn format_duration(value: &DurationValue) -> String {
    let millis = duration_millis(value).abs();
    if value.years.abs() >= 1.0 {
        if value.years.abs() < 1.5 {
            "a year".to_string()
        } else {
            pluralize(value.years, "year")
        }
    } else if value.months.abs() >= 1.0 {
        if value.months.abs() < 1.5 {
            "a month".to_string()
        } else {
            pluralize(value.months, "month")
        }
    } else if millis >= 548.0 * 86_400_000.0 {
        pluralize(millis / (365.25 * 86_400_000.0), "year")
    } else if millis >= 320.0 * 86_400_000.0 {
        "a year".to_string()
    } else if millis >= 45.0 * 86_400_000.0 {
        pluralize(millis / (30.0 * 86_400_000.0), "month")
    } else if millis >= 26.0 * 86_400_000.0 {
        "a month".to_string()
    } else if millis >= 36.0 * 3_600_000.0 {
        pluralize(millis / 86_400_000.0, "day")
    } else if millis >= 22.0 * 3_600_000.0 {
        "a day".to_string()
    } else if millis >= 90.0 * 60_000.0 {
        pluralize(millis / 3_600_000.0, "hour")
    } else if millis >= 45.0 * 60_000.0 {
        "an hour".to_string()
    } else if millis >= 90_000.0 {
        pluralize(millis / 60_000.0, "minute")
    } else if millis >= 45_000.0 {
        "a minute".to_string()
    } else {
        "a few seconds".to_string()
    }
}

fn pluralize(value: f64, unit: &str) -> String {
    let rounded = value.round();
    format!(
        "{} {unit}{}",
        format_number(rounded),
        if rounded.abs() == 1.0 { "" } else { "s" }
    )
}

fn relative_date(value: &DateValue, now: &DateValue) -> String {
    let delta = value.millis - now.millis;
    let future = delta > 0;
    let amount = delta.unsigned_abs() as f64;
    let phrase = if amount < 45_000.0 {
        "a few seconds".to_string()
    } else if amount < 90_000.0 {
        "a minute".to_string()
    } else if amount < 45.0 * 60_000.0 {
        format!("{} minutes", (amount / 60_000.0).round())
    } else if amount < 90.0 * 60_000.0 {
        "an hour".to_string()
    } else if amount < 22.0 * 3_600_000.0 {
        format!("{} hours", (amount / 3_600_000.0).round())
    } else if amount < 36.0 * 3_600_000.0 {
        "a day".to_string()
    } else if amount < 26.0 * 86_400_000.0 {
        format!("{} days", (amount / 86_400_000.0).round())
    } else if amount < 45.0 * 86_400_000.0 {
        "a month".to_string()
    } else if amount < 320.0 * 86_400_000.0 {
        format!("{} months", (amount / (30.0 * 86_400_000.0)).round())
    } else if amount < 548.0 * 86_400_000.0 {
        "a year".to_string()
    } else {
        format!("{} years", (amount / (365.25 * 86_400_000.0)).round())
    };
    if future {
        format!("in {phrase}")
    } else {
        format!("{phrase} ago")
    }
}

fn file_defaults(path: &str) -> BasesFile {
    let name = path.rsplit('/').next().unwrap_or(path).to_string();
    let (basename, extension) = name
        .rsplit_once('.')
        .map(|(base, extension)| (base.to_string(), extension.to_string()))
        .unwrap_or((name.clone(), String::new()));
    BasesFile {
        path: path.to_string(),
        name,
        basename,
        folder: path
            .rsplit_once('/')
            .map(|(folder, _)| folder.to_string())
            .unwrap_or_default(),
        extension,
        ..Default::default()
    }
}

fn file_property(file: &BasesFile, property: &str, timezone: &BasesTimezone) -> RuntimeValue {
    match property {
        "name" => RuntimeValue::String(file.name.clone()),
        "basename" => RuntimeValue::String(file.basename.clone()),
        "fullname" => RuntimeValue::String(file.path.rsplit('/').next().unwrap_or_default().into()),
        "path" => RuntimeValue::String(file.path.clone()),
        "folder" => RuntimeValue::String(file.folder.clone()),
        "ext" => RuntimeValue::String(file.extension.clone()),
        "size" => file
            .size
            .map(|size| RuntimeValue::Number(size as f64))
            .unwrap_or(RuntimeValue::Null),
        "properties" => RuntimeValue::Object(file.properties.clone()),
        "tags" => RuntimeValue::TagList(
            file.tags
                .iter()
                .filter({
                    let mut seen = HashSet::new();
                    move |value| seen.insert(value.as_str())
                })
                .map(|value| RuntimeValue::Tag(tag_text(value)))
                .collect(),
        ),
        "links" => RuntimeValue::List(file.links.iter().cloned().map(RuntimeValue::Link).collect()),
        "embeds" => RuntimeValue::List(
            file.embeds
                .iter()
                .cloned()
                .map(RuntimeValue::Link)
                .collect(),
        ),
        "backlinks" => RuntimeValue::List(
            file.backlinks
                .iter()
                .cloned()
                .map(RuntimeValue::Link)
                .collect(),
        ),
        "ctime" => file
            .ctime
            .as_deref()
            .and_then(|value| parse_date(value, timezone))
            .map(RuntimeValue::Date)
            .unwrap_or(RuntimeValue::Null),
        "mtime" => file
            .mtime
            .as_deref()
            .and_then(|value| parse_date(value, timezone))
            .map(RuntimeValue::Date)
            .unwrap_or(RuntimeValue::Null),
        "file" => RuntimeValue::File(Box::new(file.clone())),
        _ => member_not_found("File", property),
    }
}

fn normalize_tag(value: &str) -> String {
    value.trim_start_matches('#').to_lowercase()
}
fn is_external(value: &str) -> bool {
    // Obsidian's QC delegates to the WHATWG URL constructor. Use the existing
    // locked portable parser rather than a scheme-only regex accepting malformed
    // HTTP hosts/ports. Parsing does not fetch or resolve the URL.
    url::Url::parse(value).is_ok()
}

/// The destination is already semantic text. Match the shared resolver's
/// literal-fragment-before-percent-decoding rule; `%23` is part of a filename.
pub(crate) fn link_subpath(destination: &str) -> Option<String> {
    destination
        .find('#')
        .map(|index| destination[index..].to_owned())
}
pub(super) fn strip_subpath(value: &str) -> String {
    value
        .split_once('#')
        .map(|(path, _)| path)
        .unwrap_or(value)
        .to_string()
}
pub(super) fn ensure_markdown_extension(value: &str) -> String {
    let (head, tail) = value
        .split_once('#')
        .map(|(head, tail)| (head, format!("#{tail}")))
        .unwrap_or((value, String::new()));
    if head
        .rsplit('/')
        .next()
        .is_some_and(|name| name.contains('.'))
    {
        value.to_string()
    } else {
        format!("{head}.md{tail}")
    }
}
pub(super) fn strip_markdown_extension(value: &str) -> String {
    value.strip_suffix(".md").unwrap_or(value).to_string()
}
pub(super) fn normalize_path(value: &str) -> String {
    value.replace('\\', "/").trim_start_matches('/').to_string()
}
fn same_markdown_variant(left: &str, right: &str) -> bool {
    normalize_path(&strip_markdown_extension(&strip_subpath(left)))
        == normalize_path(&strip_markdown_extension(&strip_subpath(right)))
}
fn link_resolution_keys(target: &str) -> Vec<String> {
    let base = strip_subpath(target);
    let candidates = [
        target.to_string(),
        base.clone(),
        ensure_markdown_extension(target),
        ensure_markdown_extension(&base),
        strip_markdown_extension(target),
        strip_markdown_extension(&base),
    ];
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}
/// A link for a value that is exactly one wikilink, such as `[[Note|Alias]]`.
pub(super) fn wikilink(value: &str) -> Option<BasesLink> {
    let inner = value.trim().strip_prefix("[[")?.strip_suffix("]]")?;
    if inner.is_empty() || inner.contains("]]") || inner.contains("[[") {
        return None;
    }
    let (path, display) = parse_link_text(value);
    Some(BasesLink {
        subpath: link_subpath(&path),
        path,
        display,
        ..Default::default()
    })
}

fn parse_link_text(value: &str) -> (String, Option<String>) {
    let value = value
        .trim()
        .strip_prefix('!')
        .unwrap_or(value.trim())
        .trim();
    let value = value
        .strip_prefix("[[")
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(value);
    value
        .split_once('|')
        .map(|(target, display)| (target.to_string(), Some(display.to_string())))
        .unwrap_or((value.to_string(), None))
}

fn index_value(values: &[RuntimeValue], index: isize) -> Option<RuntimeValue> {
    let index = if index < 0 {
        values.len() as isize + index
    } else {
        index
    };
    (index >= 0)
        .then(|| values.get(index as usize).cloned())
        .flatten()
}
fn slice_values(values: &[RuntimeValue], start: isize, end: Option<isize>) -> Vec<RuntimeValue> {
    let len = values.len() as isize;
    let start = if start < 0 {
        (len + start).max(0)
    } else {
        start.min(len)
    };
    let end = end
        .map(|end| {
            if end < 0 {
                (len + end).max(0)
            } else {
                end.min(len)
            }
        })
        .unwrap_or(len);
    if end <= start {
        Vec::new()
    } else {
        values[start as usize..end as usize].to_vec()
    }
}
fn string_slice(value: &str, start: isize, end: Option<isize>) -> RuntimeValue {
    let len = value.chars().count() as isize;
    let start = if start < 0 {
        len.saturating_add(start).max(0)
    } else {
        start.min(len)
    };
    let end = end
        .map(|end| {
            if end < 0 {
                len.saturating_add(end).max(0)
            } else {
                end.min(len)
            }
        })
        .unwrap_or(len);
    RuntimeValue::String(
        value
            .chars()
            .skip(start as usize)
            .take(end.saturating_sub(start).max(0) as usize)
            .collect(),
    )
}
/// Size a pending deep copy while polling every traversed value/metadata item.
/// The ordinary result guard remains separate; new collection work cannot pay
/// for a large File clone only after silently walking all of its properties.
fn charged_value_bytes(
    value: &RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<usize, RuntimeValue> {
    fn add(
        bytes: &mut usize,
        length: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(length / 16 + 1)?;
        *bytes = bytes.saturating_add(length);
        if *bytes > 8 * 1024 * 1024 {
            return Err(RuntimeValue::Error(
                "budget\0Collection copy exceeds byte budget".into(),
            ));
        }
        Ok(())
    }
    fn link(
        link: &BasesLink,
        depth: usize,
        bytes: &mut usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        add(bytes, 32, check)?;
        add(bytes, link.path.len(), check)?;
        for text in [
            &link.raw_destination,
            &link.source_path,
            &link.subpath,
            &link.display,
        ] {
            if let Some(text) = text {
                add(bytes, text.len(), check)?;
            }
        }
        if let Some(Some(path)) = &link.resolved_path {
            add(bytes, path.len(), check)?;
        }
        if let Some(witness) = &link.target {
            add(
                bytes,
                witness.entry_id.as_str().len() + witness.revision.as_str().len(),
                check,
            )?;
        }
        if let Some(value) = link.display_value.as_deref() {
            visit(value, depth + 1, bytes, check)?;
        }
        Ok(())
    }
    fn visit(
        value: &RuntimeValue,
        depth: usize,
        bytes: &mut usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Collection copy nesting exceeds 128".into(),
            ));
        }
        add(bytes, 16, check)?;
        match value {
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
            | RuntimeValue::Error(value)
            | RuntimeValue::ErrorValue(value) => add(bytes, value.len(), check)?,
            RuntimeValue::Regex(pattern, flags, _) => {
                add(bytes, pattern.len() + flags.len() + 8, check)?
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                for value in values {
                    visit(value, depth + 1, bytes, check)?;
                }
            }
            RuntimeValue::Object(values) => {
                for (key, value) in values {
                    add(bytes, key.len(), check)?;
                    visit(value, depth + 1, bytes, check)?;
                }
            }
            RuntimeValue::Link(value) => link(value, depth, bytes, check)?,
            RuntimeValue::File(file) => {
                for text in [
                    &file.path,
                    &file.name,
                    &file.basename,
                    &file.folder,
                    &file.extension,
                ] {
                    add(bytes, text.len(), check)?;
                }
                for text in [&file.ctime, &file.mtime] {
                    if let Some(text) = text {
                        add(bytes, text.len(), check)?;
                    }
                }
                if let Some(witness) = &file.witness {
                    add(
                        bytes,
                        witness.entry_id.as_str().len() + witness.revision.as_str().len(),
                        check,
                    )?;
                }
                for tag in &file.tags {
                    add(bytes, tag.len(), check)?;
                }
                for (key, value) in &file.properties {
                    add(bytes, key.len(), check)?;
                    visit(value, depth + 1, bytes, check)?;
                }
                for value in file.links.iter().chain(&file.embeds).chain(&file.backlinks) {
                    link(value, depth + 1, bytes, check)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut bytes = 0;
    visit(value, 0, &mut bytes, check)?;
    Ok(bytes)
}

fn flatten_values(
    values: &[RuntimeValue],
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<Vec<RuntimeValue>, RuntimeValue> {
    fn visit(
        values: &[RuntimeValue],
        depth: usize,
        output: &mut Vec<RuntimeValue>,
        bytes: &mut usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Flatten nesting exceeds 128".into(),
            ));
        }
        for value in values {
            check(1)?;
            if let RuntimeValue::List(nested) | RuntimeValue::TagList(nested) = value {
                visit(nested, depth + 1, output, bytes, check)?;
            } else {
                let size = charged_value_bytes(value, check)?;
                *bytes = bytes.saturating_add(size);
                if *bytes > 8 * 1024 * 1024 || output.len() >= 100_000 {
                    return Err(RuntimeValue::Error(
                        "budget\0Flatten result exceeds budget".into(),
                    ));
                }
                output.push(value.clone());
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(values, 0, &mut output, &mut 0, check)?;
    Ok(output)
}

fn js_uint32(value: f64) -> usize {
    if !value.is_finite() || value == 0.0 {
        0
    } else {
        value.trunc().rem_euclid(4_294_967_296.0) as usize
    }
}

fn string_split(
    value: &str,
    separator: &RuntimeValue,
    limit: Option<usize>,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> RuntimeValue {
    fn run(
        value: &str,
        separator: &RuntimeValue,
        limit: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<Vec<RuntimeValue>, RuntimeValue> {
        let mut output = Vec::new();
        if limit == 0 {
            return Ok(output);
        }
        check(value.len() / 16 + 1)?;
        let mut bytes = 0usize;
        let mut push = |value: Option<&str>| -> Result<bool, RuntimeValue> {
            let size = value.map_or(0, str::len).saturating_add(16);
            check(size / 16 + 1)?;
            bytes = bytes.saturating_add(size);
            if output.len() >= 100_000 || bytes > 8 * 1024 * 1024 {
                return Err(RuntimeValue::Error(
                    "budget\0Split result exceeds item budget".into(),
                ));
            }
            output.push(
                value
                    .map(|value| RuntimeValue::String(value.into()))
                    .unwrap_or(RuntimeValue::Null),
            );
            Ok(output.len() == limit)
        };
        if let RuntimeValue::Regex(pattern, flags, _) = separator {
            let regex = compile_regex(pattern, flags).map_err(RuntimeValue::Error)?;
            if value.is_empty() {
                if !regex.is_match(value) {
                    push(Some(value))?;
                }
                return Ok(output);
            }
            let mut end = 0;
            for captures in regex.captures_iter(value) {
                let matched = captures.get(0).expect("full regex match");
                // JS split omits zero-width separators at either boundary and
                // advances a Unicode scalar under the accepted string policy.
                if matched.is_empty() && (matched.end() == end || matched.start() == value.len()) {
                    continue;
                }
                if push(Some(&value[end..matched.start()]))? {
                    return Ok(output);
                }
                for capture in captures.iter().skip(1) {
                    if push(capture.map(|capture| capture.as_str()))? {
                        return Ok(output);
                    }
                }
                end = matched.end();
            }
            push(Some(&value[end..]))?;
        } else {
            let separator = plain_string(separator);
            if separator.is_empty() {
                for character in value.chars() {
                    let mut buffer = [0; 4];
                    if push(Some(character.encode_utf8(&mut buffer)))? {
                        break;
                    }
                }
            } else {
                for part in value.split(&separator) {
                    if push(Some(part))? {
                        break;
                    }
                }
            }
        }
        Ok(output)
    }
    run(value, separator, limit.unwrap_or(usize::MAX), check)
        .map(RuntimeValue::List)
        .unwrap_or_else(|error| error)
}
fn compare_sort_keys(left: &RuntimeValue, right: &RuntimeValue) -> std::cmp::Ordering {
    match (left, right) {
        (RuntimeValue::Number(left), RuntimeValue::Number(right)) => {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        }
        _ => plain_string(left).cmp(&plain_string(right)),
    }
}
fn js_array_index(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|index| *index < u32::MAX && index.to_string() == key)
}

/// Constructor-strict recursive equality shared by unique and Object values.
/// File/Link authority is never reconstructed from a presentation DTO.
pub(crate) fn strict_values_equal(
    left: &RuntimeValue,
    right: &RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<bool, RuntimeValue> {
    fn admit(
        value: &RuntimeValue,
        depth: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(1)?;
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Strict comparison nesting exceeds 128".into(),
            ));
        }
        match value {
            RuntimeValue::Error(message) => return Err(RuntimeValue::Error(message.clone())),
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                for value in values {
                    admit(value, depth + 1, check)?;
                }
            }
            RuntimeValue::Object(values) => {
                for (key, value) in values {
                    check(key.len() / 16 + 1)?;
                    admit(value, depth + 1, check)?;
                }
            }
            RuntimeValue::Link(link) => {
                check(
                    (link.path.len()
                        + link.raw_destination.as_ref().map_or(0, String::len)
                        + link.source_path.as_ref().map_or(0, String::len)
                        + link.display.as_ref().map_or(0, String::len))
                        / 16
                        + 1,
                )?;
                if let Some(value) = link.display_value.as_deref() {
                    admit(value, depth + 1, check)?;
                }
            }
            RuntimeValue::File(file) => check(
                (file.path.len()
                    + file.witness.as_ref().map_or(0, |witness| {
                        witness.entry_id.as_str().len() + witness.revision.as_str().len()
                    }))
                    / 16
                    + 1,
            )?,
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
            | RuntimeValue::ErrorValue(value) => check(value.len() / 16 + 1)?,
            _ => {}
        }
        Ok(())
    }
    fn display(
        left: &BasesLink,
        right: &BasesLink,
        depth: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<bool, RuntimeValue> {
        match (
            left.display_value.as_deref(),
            right.display_value.as_deref(),
        ) {
            (Some(left), Some(right)) => compare(left, right, depth + 1, check),
            (Some(RuntimeValue::Null), None) => Ok(right.display.is_none()),
            (None, Some(RuntimeValue::Null)) => Ok(left.display.is_none()),
            (Some(RuntimeValue::String(left)), None) => Ok(right.display.as_ref() == Some(left)),
            (None, Some(RuntimeValue::String(right))) => Ok(left.display.as_ref() == Some(right)),
            (None, None) => Ok(left.display == right.display),
            _ => Ok(false),
        }
    }
    fn compare(
        left: &RuntimeValue,
        right: &RuntimeValue,
        depth: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<bool, RuntimeValue> {
        check(1)?;
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Strict comparison nesting exceeds 128".into(),
            ));
        }
        Ok(match (left, right) {
            (RuntimeValue::Null, RuntimeValue::Null) => true,
            (RuntimeValue::Bool(a), RuntimeValue::Bool(b)) => a == b,
            (RuntimeValue::ErrorValue(a), RuntimeValue::ErrorValue(b)) => {
                error_message(a) == error_message(b)
            }
            (RuntimeValue::Number(a), RuntimeValue::Number(b)) => a == b,
            (RuntimeValue::String(a), RuntimeValue::String(b))
            | (RuntimeValue::Tag(a), RuntimeValue::Tag(b))
            | (RuntimeValue::Html(a), RuntimeValue::Html(b))
            | (RuntimeValue::Image(a), RuntimeValue::Image(b))
            | (RuntimeValue::Icon(a), RuntimeValue::Icon(b)) => a == b,
            (RuntimeValue::Date(a), RuntimeValue::Date(b)) => {
                a.millis == b.millis && a.date_only == b.date_only
            }
            (RuntimeValue::Duration(a), RuntimeValue::Duration(b)) => {
                [
                    a.years,
                    a.months,
                    a.weeks,
                    a.days,
                    a.hours,
                    a.minutes,
                    a.seconds,
                    a.milliseconds,
                ] == [
                    b.years,
                    b.months,
                    b.weeks,
                    b.days,
                    b.hours,
                    b.minutes,
                    b.seconds,
                    b.milliseconds,
                ]
            }
            (RuntimeValue::Regex(_, _, a), RuntimeValue::Regex(_, _, b)) => Arc::ptr_eq(a, b),
            (RuntimeValue::List(a), RuntimeValue::List(b))
            | (RuntimeValue::TagList(a), RuntimeValue::TagList(b)) => {
                if a.len() != b.len() {
                    return Ok(false);
                }
                for (a, b) in a.iter().zip(b) {
                    if !compare(a, b, depth + 1, check)? {
                        return Ok(false);
                    }
                }
                true
            }
            (RuntimeValue::Object(a), RuntimeValue::Object(b)) => {
                if a.len() != b.len() {
                    return Ok(false);
                }
                for (key, a) in a {
                    let Some(b) = b.get(key) else {
                        return Ok(false);
                    };
                    if !compare(a, b, depth + 1, check)? {
                        return Ok(false);
                    }
                }
                true
            }
            (RuntimeValue::File(a), RuntimeValue::File(b)) => {
                let (Some(a_witness), Some(b_witness)) = (&a.witness, &b.witness) else {
                    return Err(RuntimeValue::Error(
                        "unavailable\0Strict File equality requires captured identity".into(),
                    ));
                };
                a_witness == b_witness && a.path == b.path
            }
            (RuntimeValue::Link(a), RuntimeValue::Link(b)) => {
                if a.external != b.external {
                    return Ok(false);
                }
                if a.external {
                    a.path == b.path && display(a, b, depth, check)?
                } else {
                    let (Some(a_raw), Some(b_raw), Some(a_source), Some(b_source)) = (
                        &a.raw_destination,
                        &b.raw_destination,
                        &a.source_path,
                        &b.source_path,
                    ) else {
                        return Err(RuntimeValue::Error("unavailable\0Strict Link equality requires original destination and source".into()));
                    };
                    a_raw == b_raw && a_source == b_source && display(a, b, depth, check)?
                }
            }
            _ => false,
        })
    }
    admit(left, 0, check)?;
    admit(right, 0, check)?;
    compare(left, right, 0, check)
}

/// Reference toString bucket keys; unlike JSON value serialization, Object
/// values become ordered JSON strings of their children's strings. This helper
/// can also serve the ordinary converter after its independent signature audit.
pub(crate) fn unique_bucket_key(
    value: &RuntimeValue,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    fn json_text(
        output: &mut String,
        text: &str,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(text.len() / 16 + 1)?;
        append_text(output, "\"", check)?;
        let mut start = 0;
        for (at, character) in text.char_indices() {
            let escaped = match character {
                '"' => Some("\\\""),
                '\\' => Some("\\\\"),
                '\u{8}' => Some("\\b"),
                '\u{c}' => Some("\\f"),
                '\n' => Some("\\n"),
                '\r' => Some("\\r"),
                '\t' => Some("\\t"),
                _ => None,
            };
            if escaped.is_some() || character < '\u{20}' {
                append_text(output, &text[start..at], check)?;
                if let Some(escaped) = escaped {
                    append_text(output, escaped, check)?;
                } else {
                    append_text(output, &format!("\\u{:04x}", character as u32), check)?;
                }
                start = at + character.len_utf8();
            }
        }
        append_text(output, &text[start..], check)?;
        append_text(output, "\"", check)
    }
    fn render(
        value: &RuntimeValue,
        depth: usize,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<String, RuntimeValue> {
        check(1)?;
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Unique key nesting exceeds 128".into(),
            ));
        }
        let mut output = String::new();
        match value {
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        append_text(&mut output, ", ", check)?;
                    }
                    append_text(&mut output, &render(value, depth + 1, check)?, check)?;
                }
            }
            RuntimeValue::Object(values) => {
                let levels = (usize::BITS - values.len().max(1).leading_zeros()) as usize;
                let mut max_key_bytes = 0usize;
                for key in values.keys() {
                    check(key.len() / 16 + 1)?;
                    max_key_bytes = max_key_bytes.max(key.len());
                }
                check(
                    values
                        .len()
                        .saturating_mul(max_key_bytes / 16 + 1)
                        .saturating_mul(levels.saturating_mul(2) + 1),
                )?;
                let mut entries = values
                    .iter()
                    .enumerate()
                    .map(|(ordinal, (key, value))| (js_array_index(key), ordinal, key, value))
                    .collect::<Vec<_>>();
                entries.sort_unstable_by(|a, b| match (a.0, b.0) {
                    (Some(a), Some(b)) => a.cmp(&b),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    (None, None) => a.1.cmp(&b.1),
                });
                append_text(&mut output, "{", check)?;
                for (index, (_, _, key, value)) in entries.into_iter().enumerate() {
                    if index > 0 {
                        append_text(&mut output, ",", check)?;
                    }
                    json_text(&mut output, key, check)?;
                    append_text(&mut output, ":", check)?;
                    json_text(&mut output, &render(value, depth + 1, check)?, check)?;
                }
                append_text(&mut output, "}", check)?;
            }
            RuntimeValue::Link(link) if !link.external => {
                let (Some(raw), Some(_)) = (&link.raw_destination, &link.source_path) else {
                    return Err(RuntimeValue::Error(
                        "unavailable\0Unique Link key requires original destination and source"
                            .into(),
                    ));
                };
                append_text(&mut output, "[[", check)?;
                append_text(&mut output, raw, check)?;
                let display = match link.display_value.as_deref() {
                    Some(RuntimeValue::Null) => None,
                    Some(value) => Some(render(value, depth + 1, check)?),
                    None => link.display.clone(),
                };
                if let Some(display) = display {
                    append_text(&mut output, "|", check)?;
                    append_text(&mut output, &display, check)?;
                }
                append_text(&mut output, "]]", check)?;
            }
            RuntimeValue::Error(message) => return Err(RuntimeValue::Error(message.clone())),
            _ => {
                let length = match value {
                    RuntimeValue::File(file) => file.path.len(),
                    RuntimeValue::Link(link) => link.path.len(),
                    RuntimeValue::Regex(pattern, flags, _) => pattern.len() + flags.len(),
                    RuntimeValue::ErrorValue(message) => message.len(),
                    value => string_data(value).map_or(64, str::len),
                };
                check(length / 16 + 1)?;
                append_text(&mut output, &plain_string(value), check)?;
            }
        }
        Ok(output)
    }
    render(value, 0, check)
}

/// A single query's private regex encounter registry. Ordinals distinguish
/// actual AST-owned objects only within that query; they are not persisted
/// object identities and never contain allocation addresses or ambient state.
#[derive(Default)]
pub(crate) struct StrictIdentityContext {
    regex_tokens: Vec<Arc<()>>,
}
impl StrictIdentityContext {
    fn regex_ordinal(
        &mut self,
        token: &Arc<()>,
        reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<usize, RuntimeValue> {
        check(1)?;
        for (ordinal, prior) in self.regex_tokens.iter().enumerate() {
            check(1)?;
            if Arc::ptr_eq(prior, token) {
                return Ok(ordinal);
            }
        }
        let needed = self.regex_tokens.len().saturating_add(1);
        if needed > 100_000
            || needed.saturating_mul(std::mem::size_of::<Arc<()>>()) > 8 * 1024 * 1024
        {
            return Err(RuntimeValue::Error(
                "budget\0Strict identity registry exceeds byte/item budget".into(),
            ));
        }
        check(std::mem::size_of::<Arc<()>>() / 16 + 1)?;
        if needed > self.regex_tokens.capacity() {
            let capacity = needed.next_power_of_two();
            let growth = (capacity - self.regex_tokens.capacity())
                .saturating_mul(std::mem::size_of::<Arc<()>>());
            reserve(growth)?;
            self.regex_tokens
                .try_reserve_exact(capacity - self.regex_tokens.len())
                .map_err(|_| {
                    RuntimeValue::Error("budget\0Strict identity registry allocation failed".into())
                })?;
        }
        let ordinal = self.regex_tokens.len();
        self.regex_tokens.push(Arc::clone(token));
        Ok(ordinal)
    }
}

/// Constructor-sensitive canonical components for strict Object group IDs.
/// One context must be shared across every key in the query, including nested
/// Regex values. File/Link origin is actual private runtime provenance only.
pub(crate) fn strict_runtime_identity_key(
    value: &RuntimeValue,
    identities: &mut StrictIdentityContext,
    reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    fn put(
        output: &mut String,
        text: &str,
        reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(text.len() / 16 + 1)?;
        let needed = output.len().saturating_add(text.len());
        if needed > 8 * 1024 * 1024 {
            return Err(RuntimeValue::Error(
                "budget\0Strict identity output exceeds byte budget".into(),
            ));
        }
        if needed > output.capacity() {
            let capacity = needed.next_power_of_two().min(8 * 1024 * 1024);
            reserve(capacity - output.capacity())?;
            output
                .try_reserve_exact(capacity - output.len())
                .map_err(|_| {
                    RuntimeValue::Error("budget\0Strict identity output allocation failed".into())
                })?;
        }
        output.push_str(text);
        Ok(())
    }
    fn part(
        output: &mut String,
        value: &str,
        reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        put(output, &format!("{}:", value.len()), reserve, check)?;
        put(output, value, reserve, check)
    }
    fn number(
        output: &mut String,
        value: f64,
        reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        if !value.is_finite() {
            return Err(RuntimeValue::Error(
                "numeric-domain\0Nonfinite strict identity component".into(),
            ));
        }
        put(
            output,
            &format!("{:016x}", if value == 0.0 { 0 } else { value.to_bits() }),
            reserve,
            check,
        )
    }
    fn label(
        output: &mut String,
        link: &BasesLink,
        depth: usize,
        identities: &mut StrictIdentityContext,
        reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        match link.display_value.as_deref() {
            Some(RuntimeValue::Null) => put(output, "A", reserve, check),
            Some(value) => {
                put(output, "P", reserve, check)?;
                render(output, value, depth + 1, identities, reserve, check)
            }
            None => {
                if let Some(text) = &link.display {
                    put(output, "PS", reserve, check)?;
                    part(output, text, reserve, check)
                } else {
                    put(output, "A", reserve, check)
                }
            }
        }
    }
    fn render(
        output: &mut String,
        value: &RuntimeValue,
        depth: usize,
        identities: &mut StrictIdentityContext,
        reserve: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
        check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
    ) -> Result<(), RuntimeValue> {
        check(1)?;
        if depth > 128 {
            return Err(RuntimeValue::Error(
                "budget\0Strict identity nesting exceeds 128".into(),
            ));
        }
        match value {
            RuntimeValue::Null => put(output, "0", reserve, check)?,
            RuntimeValue::Bool(value) => {
                put(output, if *value { "B1" } else { "B0" }, reserve, check)?
            }
            RuntimeValue::Number(value) => {
                put(output, "N", reserve, check)?;
                number(output, *value, reserve, check)?;
            }
            RuntimeValue::String(text)
            | RuntimeValue::Tag(text)
            | RuntimeValue::Html(text)
            | RuntimeValue::Image(text)
            | RuntimeValue::Icon(text) => {
                let tag = match value {
                    RuntimeValue::String(_) => "S",
                    RuntimeValue::Tag(_) => "G",
                    RuntimeValue::Html(_) => "H",
                    RuntimeValue::Image(_) => "I",
                    RuntimeValue::Icon(_) => "C",
                    _ => unreachable!(),
                };
                put(output, tag, reserve, check)?;
                part(output, text, reserve, check)?;
            }
            RuntimeValue::Date(value) => {
                put(
                    output,
                    if value.date_only { "D0" } else { "D1" },
                    reserve,
                    check,
                )?;
                part(output, &value.millis.to_string(), reserve, check)?;
            }
            RuntimeValue::Duration(value) => {
                put(output, "U", reserve, check)?;
                for value in [
                    value.years,
                    value.months,
                    value.weeks,
                    value.days,
                    value.hours,
                    value.minutes,
                    value.seconds,
                    value.milliseconds,
                ] {
                    number(output, value, reserve, check)?;
                }
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => {
                put(
                    output,
                    if matches!(value, RuntimeValue::TagList(_)) {
                        "T"
                    } else {
                        "L"
                    },
                    reserve,
                    check,
                )?;
                part(output, &values.len().to_string(), reserve, check)?;
                for value in values {
                    render(output, value, depth + 1, identities, reserve, check)?;
                }
            }
            RuntimeValue::Object(values) => {
                put(output, "O", reserve, check)?;
                part(output, &values.len().to_string(), reserve, check)?;
                let levels = (usize::BITS - values.len().max(1).leading_zeros()) as usize;
                let mut max_key_bytes = 0usize;
                for key in values.keys() {
                    check(key.len() / 16 + 1)?;
                    max_key_bytes = max_key_bytes.max(key.len());
                }
                check(
                    values
                        .len()
                        .saturating_mul(max_key_bytes / 16 + 1)
                        .saturating_mul(levels.saturating_mul(2) + 1),
                )?;
                reserve(
                    values
                        .len()
                        .saturating_mul(std::mem::size_of::<(&String, &RuntimeValue)>()),
                )?;
                let mut entries = values.iter().collect::<Vec<_>>();
                entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
                for (key, value) in entries {
                    part(output, key, reserve, check)?;
                    render(output, value, depth + 1, identities, reserve, check)?;
                }
            }
            RuntimeValue::File(file) => {
                let Some(witness) = &file.witness else {
                    return Err(RuntimeValue::Error(
                        "unavailable\0Strict File identity requires captured witness".into(),
                    ));
                };
                put(output, "F", reserve, check)?;
                part(output, witness.entry_id.as_str(), reserve, check)?;
                part(output, witness.revision.as_str(), reserve, check)?;
                part(output, &file.path, reserve, check)?;
            }
            RuntimeValue::Link(link) => {
                if link.external {
                    put(output, "W", reserve, check)?;
                    part(output, &link.path, reserve, check)?;
                } else {
                    let (Some(raw), Some(source)) = (&link.raw_destination, &link.source_path)
                    else {
                        return Err(RuntimeValue::Error("unavailable\0Strict Link identity requires original destination and source".into()));
                    };
                    put(output, "K", reserve, check)?;
                    part(output, raw, reserve, check)?;
                    part(output, source, reserve, check)?;
                }
                label(output, link, depth, identities, reserve, check)?;
            }
            RuntimeValue::Regex(_, _, token) => {
                put(output, "R", reserve, check)?;
                part(
                    output,
                    &identities.regex_ordinal(token, reserve, check)?.to_string(),
                    reserve,
                    check,
                )?;
            }
            RuntimeValue::ErrorValue(message) => {
                put(output, "E", reserve, check)?;
                part(output, error_message(message), reserve, check)?;
            }
            RuntimeValue::Error(message) => return Err(RuntimeValue::Error(message.clone())),
        }
        Ok(())
    }
    // Temporary integer/hex formatting is bounded to64 bytes at any point.
    check(1)?;
    reserve(64)?;
    let mut output = String::new();
    render(&mut output, value, 0, identities, reserve, check)?;
    Ok(output)
}

fn unique_values(
    values: &[RuntimeValue],
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<Vec<RuntimeValue>, RuntimeValue> {
    let mut buckets = IndexMap::<String, Vec<&RuntimeValue>>::new();
    let mut bytes = 0usize;
    let mut count = 0usize;
    for value in values {
        check(1)?;
        let key = unique_bucket_key(value, check)?;
        if !buckets.contains_key(&key) {
            bytes = bytes.saturating_add(key.len() + 32);
        }
        let bucket = buckets.entry(key).or_default();
        let mut seen = false;
        for prior in bucket.iter() {
            if strict_values_equal(prior, value, check)? {
                seen = true;
                break;
            }
        }
        if !seen {
            let size = charged_value_bytes(value, check)?;
            bytes = bytes.saturating_add(size);
            count += 1;
            if bytes > 8 * 1024 * 1024 || count > 100_000 {
                return Err(RuntimeValue::Error(
                    "budget\0Unique result exceeds budget".into(),
                ));
            }
            bucket.push(value);
        }
    }
    check(
        buckets
            .len()
            .saturating_mul((usize::BITS - buckets.len().max(1).leading_zeros()) as usize),
    )?;
    let mut ordered = buckets
        .into_iter()
        .enumerate()
        .map(|(ordinal, (key, values))| (js_array_index(&key), ordinal, values))
        .collect::<Vec<_>>();
    ordered.sort_unstable_by(|a, b| match (a.0, b.0) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.1.cmp(&b.1),
    });
    let mut output = Vec::with_capacity(count);
    for (_, _, values) in ordered {
        for value in values {
            check(0)?;
            output.push(value.clone());
        }
    }
    Ok(output)
}

/// Expressions run once per record, so each pattern is compiled once and reused.
/// RegExp.toString for a validated runtime literal. Construction preadmits
/// six times the source bytes plus flags/delimiters, bounding escaped output.
/// Private runtime-shape restoration must retain that actual constructor proof.
pub(crate) fn regex_string(pattern: &str, flags: &str) -> String {
    let mut output = String::from("/");
    if pattern.is_empty() {
        output.push_str("(?:)");
    } else {
        let mut escaped = false;
        for character in pattern.chars() {
            match character {
                '/' if !escaped => output.push_str("\\/"),
                '\n' => output.push_str("\\n"),
                '\r' => output.push_str("\\r"),
                '\u{2028}' => output.push_str("\\u2028"),
                '\u{2029}' => output.push_str("\\u2029"),
                other => output.push(other),
            }
            escaped = character == '\\' && !escaped;
        }
    }
    output.push('/');
    for flag in "gimsu".chars() {
        if flags.contains(flag) {
            output.push(flag);
        }
    }
    output
}

fn canonical_regex_flags(flags: &str) -> Result<String, String> {
    if flags.chars().collect::<HashSet<_>>().len() != flags.chars().count()
        || flags.chars().any(|flag| !"dgimsuvy".contains(flag))
        || (flags.contains('u') && flags.contains('v'))
    {
        return Err("parse\0Invalid regular expression flags".into());
    }
    if flags.chars().any(|flag| !"gimsu".contains(flag)) {
        return Err("unsupported\0Unsupported regular expression flags".into());
    }
    Ok("gimsu"
        .chars()
        .filter(|flag| flags.contains(*flag))
        .collect())
}

fn compile_regex(pattern: &str, flags: &str) -> Result<Regex, String> {
    const MAX_ENTRIES: usize = 8; // <= 8 MiB compiled regex budget plus bounded pattern keys
    type Compiled = Result<Regex, String>;
    static CACHE: OnceLock<RwLock<HashMap<(String, String), Compiled>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    let key = (pattern.to_string(), flags.to_string());
    if let Some(compiled) = cache.read().ok().and_then(|cache| cache.get(&key).cloned()) {
        return compiled;
    }
    canonical_regex_flags(flags)?;
    let mut builder = RegexBuilder::new(pattern);
    builder.size_limit(1_048_576).dfa_size_limit(1_048_576);
    builder
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'));
    let compiled = builder.build().map_err(|error| match error {
        regex::Error::CompiledTooBig(_) => {
            "budget\0Regular expression exceeds compiled-size budget".into()
        }
        regex::Error::Syntax(message) => {
            // Rust's Syntax category also includes valid JavaScript features
            // such as lookaround/backreferences and different escape/class
            // dialects. Only known malformed common syntax is called invalid.
            // Read the diagnostic reason, never text inside the user pattern.
            let reason = message
                .lines()
                .last()
                .and_then(|line| line.strip_prefix("error: "));
            if matches!(
                reason,
                Some(
                    "unclosed group"
                        | "unopened group"
                        | "repetition operator missing expression"
                        | "invalid repetition count range, the start must be <= the end"
                )
            ) {
                format!("parse\0Invalid regular expression: {message}")
            } else {
                format!("unsupported\0Unsupported regular expression: {message}")
            }
        }
        error => format!("unsupported\0Unsupported regular expression: {error}"),
    });
    if let Ok(mut cache) = cache.write() {
        if cache.len() >= MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(key, compiled.clone());
    }
    compiled
}
fn regex_is_match(pattern: &str, flags: &str, value: &str) -> Result<bool, String> {
    compile_regex(pattern, flags).map(|regex| regex.is_match(value))
}
fn regex_replace(
    value: &str,
    pattern: &str,
    flags: &str,
    replacement: &str,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    check(value.len() / 16 + pattern.len() / 16 + 1)?;
    let regex = compile_regex(pattern, flags).map_err(RuntimeValue::Error)?;
    let named = regex.capture_names().any(|name| name.is_some());
    let mut output = String::new();
    let mut end = 0;
    let mut cursor = 0usize;
    while cursor <= value.len() {
        check(1)?;
        let Some(captures) = regex.captures_at(value, cursor) else {
            break;
        };
        let matched = captures.get(0).expect("full regex match");
        append_text(&mut output, &value[end..matched.start()], check)?;
        replacement_text(&mut output, replacement, value, &captures, named, check)?;
        end = matched.end();
        if !flags.contains('g') {
            break;
        }
        cursor = if matched.is_empty() {
            let Some(character) = value[matched.end()..].chars().next() else {
                break;
            };
            matched.end() + character.len_utf8()
        } else {
            matched.end()
        };
    }
    append_text(&mut output, &value[end..], check)?;
    Ok(output)
}

fn append_text(
    output: &mut String,
    text: &str,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<(), RuntimeValue> {
    check(text.len() / 16 + 1)?;
    if output.len().saturating_add(text.len()) > 8 * 1024 * 1024 {
        return Err(RuntimeValue::Error(
            "budget\0Replacement exceeds byte budget".into(),
        ));
    }
    output.push_str(text);
    Ok(())
}

fn literal_replace(
    value: &str,
    pattern: &str,
    replacement: &str,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<String, RuntimeValue> {
    check(value.len() / 16 + 1)?;
    if pattern.is_empty() {
        return Ok(value.into());
    }
    let mut output = String::new();
    let mut end = 0;
    for (start, _) in value.match_indices(pattern) {
        append_text(&mut output, &value[end..start], check)?;
        // Literal replacement is split/join in the shipped registration, so
        // dollar templates are deliberately interpreted only for RegExp.
        append_text(&mut output, replacement, check)?;
        end = start + pattern.len();
    }
    append_text(&mut output, &value[end..], check)?;
    Ok(output)
}

/// ECMAScript GetSubstitution for the supported, stateless regex subset.
/// Captures absent from an alternative become empty text in a replacement;
/// split retains them as Null instead. Named syntax is literal without any
/// named capture group, and numeric captures use the longest valid index.
fn replacement_text(
    output: &mut String,
    replacement: &str,
    input: &str,
    captures: &regex::Captures<'_>,
    named: bool,
    check: &mut impl FnMut(usize) -> Result<(), RuntimeValue>,
) -> Result<(), RuntimeValue> {
    let matched = captures.get(0).expect("full regex match");
    let mut at = 0;
    while let Some(next) = replacement[at..].find('$') {
        let dollar = at + next;
        append_text(output, &replacement[at..dollar], check)?;
        let suffix = &replacement[dollar + 1..];
        let mut consumed = 1;
        let text = match suffix.as_bytes().first().copied() {
            Some(b'$') => {
                consumed = 2;
                Some("$")
            }
            Some(b'&') => {
                consumed = 2;
                Some(matched.as_str())
            }
            Some(b'`') => {
                consumed = 2;
                Some(&input[..matched.start()])
            }
            Some(b'\'') => {
                consumed = 2;
                Some(&input[matched.end()..])
            }
            Some(first @ b'0'..=b'9') => {
                let mut index = usize::from(first - b'0');
                if let Some(second @ b'0'..=b'9') = suffix.as_bytes().get(1).copied() {
                    let pair = index * 10 + usize::from(second - b'0');
                    if pair > 0 && pair < captures.len() {
                        index = pair;
                        consumed = 3;
                    }
                }
                if index > 0 && index < captures.len() {
                    if consumed == 1 {
                        consumed = 2;
                    }
                    Some(captures.get(index).map_or("", |capture| capture.as_str()))
                } else {
                    None
                }
            }
            Some(b'<') if named => {
                if let Some(end) = suffix.find('>') {
                    consumed = end + 2;
                    Some(
                        captures
                            .name(&suffix[1..end])
                            .map_or("", |capture| capture.as_str()),
                    )
                } else {
                    None
                }
            }
            _ => None,
        };
        append_text(output, text.unwrap_or("$"), check)?;
        at = dollar + consumed;
    }
    append_text(output, &replacement[at..], check)
}
fn title_case(value: &str) -> String {
    static WORD: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\p{L}+").expect("word expression"));
    WORD.replace_all(value, |captures: &regex::Captures<'_>| {
        let word = &captures[0];
        let mut chars = word.chars();
        chars
            .next()
            .map(|first| format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()))
            .unwrap_or_default()
    })
    .to_string()
}
fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn own_key<'a, T>(values: &'a IndexMap<String, T>, name: &str) -> Option<&'a str> {
    values
        .get_key_value(name)
        .map(|(key, _)| key.as_str())
        .or_else(|| {
            values
                .keys()
                .find(|key| key.to_lowercase() == name.to_lowercase())
                .map(String::as_str)
        })
}
fn parse_number_prefix(value: &str) -> Option<f64> {
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)")
            .expect("numeric prefix")
    });
    PREFIX
        .find(value.trim_start_matches(ecmascript_whitespace))
        .and_then(|found| found.as_str().parse().ok())
}
fn check_ast_depth(expression: &Expr, depth: usize) -> Result<(), String> {
    if depth > 128 {
        return Err("Expression AST depth exceeds 128".into());
    }
    match expression {
        Expr::Unary(_, value) => check_ast_depth(value, depth + 1)?,
        Expr::Binary(_, left, right) => {
            check_ast_depth(left, depth + 1)?;
            check_ast_depth(right, depth + 1)?;
        }
        Expr::Array(values) => {
            for value in values {
                check_ast_depth(value, depth + 1)?;
            }
        }
        Expr::Member(value, member) => {
            check_ast_depth(value, depth + 1)?;
            if let Member::Computed(value) = member {
                check_ast_depth(value, depth + 1)?;
            }
        }
        Expr::Call(value, args) => {
            check_ast_depth(value, depth + 1)?;
            for value in args {
                check_ast_depth(value, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(crate) fn typed_result(value: RuntimeValue) -> Result<BaseValue, ExpressionDiagnostic> {
    let mut bytes = 0;
    let value = typed_value(value, 0, &mut bytes)?;
    if bytes > 8 * 1024 * 1024 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Result exceeds byte budget",
        ));
    }
    Ok(value)
}
fn typed_value(
    value: RuntimeValue,
    depth: usize,
    bytes: &mut usize,
) -> Result<BaseValue, ExpressionDiagnostic> {
    if depth > 128 || *bytes > 8 * 1024 * 1024 {
        return Err(ExpressionDiagnostic::new(
            "budget",
            "Result exceeds depth/byte budget",
        ));
    }
    *bytes = bytes.saturating_add(16);
    Ok(match value {
        RuntimeValue::Null => BaseValue::Null,
        RuntimeValue::Bool(value) => BaseValue::Boolean { value },
        RuntimeValue::Number(value) if value.is_finite() => BaseValue::Number { value },
        RuntimeValue::Number(_) => {
            return Err(ExpressionDiagnostic::new(
                "numeric-domain",
                "Nonfinite numeric result",
            ))
        }
        RuntimeValue::String(value) | RuntimeValue::Tag(value) => {
            *bytes = bytes.saturating_add(value.len());
            BaseValue::String { value }
        }
        RuntimeValue::Regex(pattern, flags, _) => {
            let maximum = pattern
                .len()
                .saturating_mul(6)
                .saturating_add(flags.len() + 3);
            if bytes.saturating_add(maximum) > 8 * 1024 * 1024 {
                return Err(ExpressionDiagnostic::new(
                    "budget",
                    "RegExp result exceeds byte budget",
                ));
            }
            let value = regex_string(&pattern, &flags);
            *bytes = bytes.saturating_add(value.len());
            BaseValue::String { value }
        }
        RuntimeValue::Html(value) => {
            *bytes = bytes.saturating_add(value.len());
            BaseValue::Html { value }
        }
        RuntimeValue::Image(value) => {
            *bytes = bytes.saturating_add(value.len());
            BaseValue::Image { value }
        }
        RuntimeValue::Icon(value) => {
            *bytes = bytes.saturating_add(value.len());
            BaseValue::Icon { value }
        }
        RuntimeValue::List(values) | RuntimeValue::TagList(values) => BaseValue::List {
            value: values
                .into_iter()
                .map(|value| typed_value(value, depth + 1, bytes))
                .collect::<Result<_, _>>()?,
        },
        RuntimeValue::Object(values) => BaseValue::Object {
            value: values
                .into_iter()
                .map(|(key, value)| {
                    *bytes = bytes.saturating_add(key.len());
                    typed_value(value, depth + 1, bytes).map(|value| (key, value))
                })
                .collect::<Result<_, _>>()?,
        },
        RuntimeValue::Date(value) => BaseValue::Date {
            timestamp: value.millis,
            has_time: !value.date_only,
        },
        RuntimeValue::Duration(value) => BaseValue::Duration {
            years: value.years,
            months: value.months,
            weeks: value.weeks,
            days: value.days,
            hours: value.hours,
            minutes: value.minutes,
            seconds: value.seconds,
            milliseconds: value.milliseconds,
        },
        RuntimeValue::File(value) => {
            *bytes = bytes.saturating_add(value.path.len());
            BaseValue::File { path: value.path }
        }
        RuntimeValue::Link(value) => {
            *bytes = bytes.saturating_add(
                value.path.len()
                    + value.subpath.as_ref().map_or(0, String::len)
                    + value.display.as_ref().map_or(0, String::len),
            );
            BaseValue::Link {
                path: value.path,
                subpath: value.subpath,
                target: value.target,
                display: value.display,
                display_value: value
                    .display_value
                    .map(|value| typed_value(*value, depth + 1, bytes).map(Box::new))
                    .transpose()?,
                external: value.external,
            }
        }
        RuntimeValue::ErrorValue(encoded) => {
            let (code, message) = encoded
                .split_once('\0')
                .unwrap_or(("error", encoded.as_str()));
            *bytes = bytes.saturating_add(code.len() + message.len());
            BaseValue::Error {
                code: code.to_owned(),
                message: message.to_owned(),
            }
        }
        RuntimeValue::Error(message) => {
            let (code, message) = message
                .split_once('\0')
                .unwrap_or(("type", message.as_str()));
            return Err(ExpressionDiagnostic::new(code, message));
        }
        _ => {
            return Err(ExpressionDiagnostic::new(
                "unsupported",
                "Unsupported expression result type",
            ))
        }
    })
}

fn value_bytes(value: &RuntimeValue) -> Option<usize> {
    let mut work = vec![value];
    let mut bytes = 0usize;
    while let Some(value) = work.pop() {
        bytes = bytes.saturating_add(16);
        match value {
            RuntimeValue::String(value)
            | RuntimeValue::Tag(value)
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
            | RuntimeValue::Error(value)
            | RuntimeValue::ErrorValue(value) => bytes = bytes.saturating_add(value.len()),
            RuntimeValue::Link(link) => {
                bytes = bytes.saturating_add(
                    link.path.len()
                        + link.raw_destination.as_ref().map_or(0, String::len)
                        + link.source_path.as_ref().map_or(0, String::len)
                        + link.subpath.as_ref().map_or(0, String::len)
                        + link.display.as_ref().map_or(0, String::len),
                );
                if let Some(display) = link.display_value.as_deref() {
                    work.push(display);
                }
            }
            RuntimeValue::File(file) => {
                bytes = bytes.saturating_add(
                    file.path.len()
                        + file.name.len()
                        + file.basename.len()
                        + file.folder.len()
                        + file.tags.iter().map(String::len).sum::<usize>(),
                );
                for (key, value) in &file.properties {
                    bytes = bytes.saturating_add(key.len());
                    work.push(value);
                }
                for link in file.links.iter().chain(&file.embeds).chain(&file.backlinks) {
                    bytes = bytes.saturating_add(
                        32 + link.path.len()
                            + link.raw_destination.as_ref().map_or(0, String::len)
                            + link.source_path.as_ref().map_or(0, String::len)
                            + link.subpath.as_ref().map_or(0, String::len)
                            + link.display.as_ref().map_or(0, String::len),
                    );
                    if let Some(display) = link.display_value.as_deref() {
                        work.push(display);
                    }
                }
            }
            RuntimeValue::List(values) | RuntimeValue::TagList(values) => work.extend(values),
            RuntimeValue::Regex(pattern, flags, _) => {
                bytes = bytes.saturating_add(pattern.len() + flags.len() + 8);
            }
            RuntimeValue::Object(values) => {
                for (key, value) in values {
                    bytes = bytes.saturating_add(key.len());
                    work.push(value);
                }
            }
            _ => {}
        }
        if bytes > 8 * 1024 * 1024 {
            return None;
        }
    }
    Some(bytes)
}

pub(crate) fn duration_scalar(
    value: &BaseValue,
    clock: i64,
    timezone: &str,
) -> Result<f64, ExpressionDiagnostic> {
    let BaseValue::Duration {
        years,
        months,
        weeks,
        days,
        hours,
        minutes,
        seconds,
        milliseconds,
    } = value
    else {
        return Err(ExpressionDiagnostic::new("type", "Expected duration"));
    };
    let timezone = BasesTimezone::from_setting(Some(timezone))
        .map_err(|message| ExpressionDiagnostic::new("input", message))?;
    let now = DateValue {
        millis: clock,
        date_only: false,
        timezone,
    };
    let duration = DurationValue {
        years: *years,
        months: *months,
        weeks: *weeks,
        days: *days,
        hours: *hours,
        minutes: *minutes,
        seconds: *seconds,
        milliseconds: *milliseconds,
    };
    add_duration(&now, &duration, 1.0)
        .map(|date| (date.millis as f64) - (clock as f64))
        .map_err(|message| {
            let (code, text) = message
                .split_once('\0')
                .unwrap_or(("numeric-domain", message.as_str()));
            ExpressionDiagnostic::new(code, text)
        })
}

pub(crate) fn display_date(
    timestamp: i64,
    has_time: bool,
    timezone: &str,
) -> Result<String, ExpressionDiagnostic> {
    let timezone = BasesTimezone::from_setting(Some(timezone))
        .map_err(|message| ExpressionDiagnostic::new("input", message))?;
    if DateTime::<Utc>::from_timestamp_millis(timestamp).is_none() {
        return Err(ExpressionDiagnostic::new(
            "numeric-domain",
            "Invalid timestamp",
        ));
    }
    try_format_date(
        &DateValue {
            millis: timestamp,
            date_only: !has_time,
            timezone,
        },
        if has_time {
            "YYYY-MM-DDTHH:mm:ss"
        } else {
            "YYYY-MM-DD"
        },
    )
    .map_err(|message| {
        let (code, text) = message
            .split_once('\0')
            .unwrap_or(("unsupported", message.as_str()));
        ExpressionDiagnostic::new(code, text)
    })
}

/// Pure interpretation of bounded raw frontmatter values. Resolution is a
/// separate checked stage using the owning file's immutable source witness.
/// Explicit property definitions may opt out before calling this helper.
pub(crate) fn infer_frontmatter_property(
    name: &str,
    value: RuntimeValue,
    timezone: &BasesTimezone,
) -> RuntimeValue {
    infer_frontmatter_value(
        if name.eq_ignore_ascii_case("tags") {
            frontmatter_tags(value)
        } else {
            value
        },
        timezone,
    )
}
/// Preserve only an actually captured frontmatter TagList across a compatible
/// scalar-definition replacement. Other lists/scalars never gain tag ancestry.
pub(crate) fn preserve_frontmatter_tag_list(
    original: Option<&RuntimeValue>,
    replacement: RuntimeValue,
) -> RuntimeValue {
    if matches!(original, Some(RuntimeValue::TagList(_))) {
        if let RuntimeValue::List(values) = replacement {
            if values
                .iter()
                .all(|value| matches!(value, RuntimeValue::String(_)))
            {
                return RuntimeValue::TagList(
                    values
                        .into_iter()
                        .map(|value| {
                            let RuntimeValue::String(value) = value else {
                                unreachable!()
                            };
                            RuntimeValue::Tag(tag_text(&value))
                        })
                        .collect(),
                );
            }
            return RuntimeValue::List(values);
        }
    }
    replacement
}
fn frontmatter_tags(value: RuntimeValue) -> RuntimeValue {
    match value {
        RuntimeValue::String(value) => {
            RuntimeValue::TagList(vec![RuntimeValue::Tag(tag_text(&value))])
        }
        RuntimeValue::List(values)
            if values
                .iter()
                .all(|v| matches!(v, RuntimeValue::String(_) | RuntimeValue::Null)) =>
        {
            let mut tags = Vec::with_capacity(values.len());
            for value in values {
                let RuntimeValue::String(value) = value else {
                    return RuntimeValue::Error("type\0Tag arrays require string members".into());
                };
                tags.push(RuntimeValue::Tag(tag_text(&value)));
            }
            RuntimeValue::TagList(tags)
        }
        value => value,
    }
}
pub(crate) fn infer_frontmatter_value(
    value: RuntimeValue,
    timezone: &BasesTimezone,
) -> RuntimeValue {
    fn infer(value: RuntimeValue, timezone: &BasesTimezone, depth: usize) -> RuntimeValue {
        if depth > 128 {
            return RuntimeValue::Error(
                "budget\0Frontmatter inference exceeds depth budget".into(),
            );
        }
        match value {
            RuntimeValue::String(value) => {
                if value.starts_with("[[") && value.ends_with("]]") {
                    if let Some(link) = wikilink(&value) {
                        return RuntimeValue::Link(link);
                    }
                }
                if !value.contains(' ') && is_external(&value) {
                    return RuntimeValue::Link(BasesLink {
                        subpath: link_subpath(&value),
                        path: value,
                        external: true,
                        ..Default::default()
                    });
                }
                // Compact numeric forms belong to explicit date(), rather than
                // reinterpreting arbitrary eight/twelve-digit property text.
                if let Some(date) = parse_frontmatter_date(&value, timezone) {
                    return RuntimeValue::Date(date);
                }
                RuntimeValue::String(value)
            }
            RuntimeValue::List(values) => RuntimeValue::List(
                values
                    .into_iter()
                    .map(|value| infer(value, timezone, depth + 1))
                    .collect(),
            ),
            RuntimeValue::Object(values) => RuntimeValue::Object(
                values
                    .into_iter()
                    .map(|(key, value)| {
                        let value = if key.eq_ignore_ascii_case("tags") {
                            frontmatter_tags(value)
                        } else {
                            value
                        };
                        (key, infer(value, timezone, depth + 1))
                    })
                    .collect(),
            ),
            value => value,
        }
    }
    infer(value, timezone, 0)
}

pub(crate) fn apply_property_type(
    value: RuntimeValue,
    hint: &crate::PropertyType,
    timezone: &BasesTimezone,
) -> RuntimeValue {
    if matches!(
        hint,
        crate::PropertyType::Date | crate::PropertyType::Datetime
    ) {
        match value {
            RuntimeValue::String(value) => parse_date(&value, timezone)
                .map(RuntimeValue::Date)
                .unwrap_or(RuntimeValue::Null),
            RuntimeValue::Null => RuntimeValue::Null,
            _ => RuntimeValue::Error("type\0Date property must contain date text".into()),
        }
    } else {
        value
    }
}

#[cfg(test)]
mod rich_expression_tests {
    use super::*;

    fn eval(source: &str) -> Result<BaseValue, ExpressionDiagnostic> {
        evaluate(source, &BasesEvaluationContext::default()).map(|result| result.value)
    }

    #[test]
    fn rich_outputs_retain_type_inert_payload_and_recursive_display() {
        for (source, expected) in [
            (
                "html('<b>Read</b><script>never execute</script>')",
                BaseValue::Html {
                    value: "<b>Read</b><script>never execute</script>".into(),
                },
            ),
            (
                "image('https://example.test/cover.png')",
                BaseValue::Image {
                    value: "https://example.test/cover.png".into(),
                },
            ),
            (
                "icon('book-open')",
                BaseValue::Icon {
                    value: "book-open".into(),
                },
            ),
        ] {
            assert_eq!(eval(source).unwrap(), expected);
            assert_eq!(
                runtime_from_base_value(&expected, &BasesTimezone::Utc)
                    .and_then(typed_result)
                    .unwrap(),
                expected
            );
        }
        let value = eval("link('https://example.test', icon('book'))").unwrap();
        let BaseValue::Link {
            external,
            display_value,
            ..
        } = &value
        else {
            panic!("expected URL")
        };
        assert!(*external);
        assert_eq!(
            display_value.as_deref(),
            Some(&BaseValue::Icon {
                value: "book".into()
            })
        );
        let round_trip = runtime_from_base_value(&value, &BasesTimezone::Utc)
            .and_then(typed_result)
            .unwrap();
        assert_eq!(round_trip, value);
    }

    #[test]
    fn image_string_representation_matches_internal_and_external_resource_forms() {
        assert_eq!(
            eval("image('covers/Dune.png').toString()").unwrap(),
            BaseValue::String {
                value: "![[covers/Dune.png]]".into()
            }
        );
        assert_eq!(
            eval("image('https://example.test/cover.png').toString()").unwrap(),
            BaseValue::String {
                value: "![](https://example.test/cover.png)".into()
            }
        );
    }

    #[test]
    fn wrappers_follow_reference_null_and_string_inheritance() {
        for source in [
            "html(null)",
            "image(null)",
            "icon(null)",
            "file(null)",
            "link(null)",
        ] {
            assert_eq!(eval(source).unwrap(), BaseValue::Null, "{source}");
        }
        for source in [
            "html(3)",
            "icon(false)",
            "image([1])",
            "file(5)",
            "link([1])",
        ] {
            assert_eq!(eval(source).unwrap_err().code, "type", "{source}");
        }
        for source in [
            "link('https://example.test').isType('url')",
            "link('https://example.test').isType('string')",
            "icon('book').isType('icon') == false",
            "icon('book').isType('string')",
            "html('').isEmpty()",
            "image('').isEmpty()",
            "icon('').isTruthy() == false",
            "icon('book').LENGTH == 4",
        ]
        .into_iter()
        {
            assert_eq!(
                eval(source).unwrap(),
                BaseValue::Boolean { value: true },
                "{source}"
            );
        }
        assert_eq!(
            eval("icon('Book').lower()").unwrap(),
            BaseValue::String {
                value: "book".into()
            }
        );
        assert_eq!(
            eval("image('cover.png').length").unwrap(),
            BaseValue::Number { value: 9.0 }
        );
        assert_eq!(
            eval("html('abc').upper()").unwrap_err().code,
            "unknown-function"
        );
    }

    #[test]
    fn built_in_dispatch_is_case_insensitive_and_string_subclasses_convert() {
        for source in [
            "IF(true, 2, 3) == 2",
            "DATE('2024-01-01').FORMAT('YYYY') == '2024'",
            "'Hello'.CONTAINS('ell')",
            "ICON('BOOK').LOWER() == 'book'",
            "LINK(LINK('Note')).isType('link')",
            "escapeHTML(icon('<')) == '&lt;'",
            "duration('invalid') == null",
            "escapeHTML(null) == null",
            "date('20240121') == date('2024-01-21')",
        ] {
            assert_eq!(
                eval(source).unwrap(),
                BaseValue::Boolean { value: true },
                "{source}"
            );
        }
        assert_eq!(
            clock_dependency("TODAY()", &mut |_| Some(())),
            crate::query::BaseClockDependency::Day
        );
        assert!(uses_relationships(
            "LINK('Note').ASFILE().properties.rating"
        ));
        assert!(uses_file_ctime("FILE.CTIME"));
    }

    #[test]
    fn file_round_trip_never_fabricates_metadata_for_missing_target() {
        let mut file = file_defaults("Books/Dune.md");
        file.properties
            .insert("rating".into(), RuntimeValue::Number(5.0));
        let context = BasesEvaluationContext {
            file: file.clone(),
            files: Arc::new(super::super::files::BasesFiles::new(vec![file])),
            ..Default::default()
        };
        assert_eq!(
            evaluate("file.asLink().asFile().properties.rating", &context)
                .unwrap()
                .value,
            BaseValue::Number { value: 5.0 }
        );
        assert_eq!(
            evaluate("file.asLink().linksTo(file)", &context)
                .unwrap()
                .value,
            BaseValue::Boolean { value: true }
        );
        assert_eq!(
            evaluate("file.asLink().linksTo('Books/Dune.md')", &context)
                .unwrap_err()
                .code,
            "type"
        );
        let missing = BasesEvaluationContext {
            files: Arc::default(),
            ..context
        };
        assert_eq!(
            evaluate("file.asLink().asFile()", &missing)
                .unwrap_err()
                .code,
            "unavailable"
        );
        assert_eq!(eval("file('Dune')").unwrap_err().code, "unavailable");
    }

    #[test]
    fn random_is_bounded_seeded_row_specific_and_not_clock_dependent() {
        let evaluate_seed = |seed, path: &str| {
            evaluate(
                "[random(),random()]",
                &BasesEvaluationContext {
                    random_seed: Some(seed),
                    file: file_defaults(path),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
        };
        let values = evaluate_seed(14, "A.md");
        assert_eq!(values, evaluate_seed(14, "A.md"));
        assert_ne!(values, evaluate_seed(15, "A.md"));
        assert_ne!(values, evaluate_seed(14, "B.md"));
        let BaseValue::List { value } = values else {
            panic!("expected list")
        };
        assert_ne!(value[0], value[1]);
        for value in value {
            let BaseValue::Number { value } = value else {
                panic!("expected number")
            };
            assert!((0.0..1.0).contains(&value));
        }
        assert_eq!(
            clock_dependency("random()", &mut |_| Some(())),
            crate::query::BaseClockDependency::None
        );
    }

    #[test]
    fn rich_summary_preserves_value_types_and_enforces_depth_and_bytes() {
        let icon = BaseValue::Icon {
            value: "book".into(),
        };
        let result = evaluate_summary(
            "values[0]",
            &[&icon],
            &[],
            None,
            &crate::EvaluationOptions::default(),
            None,
            None,
            |_| unreachable!(),
        )
        .unwrap();
        assert_eq!(result.value, icon);
        let oversized = BaseValue::Html {
            value: "a".repeat(8 * 1024 * 1024),
        };
        assert_eq!(
            runtime_from_base_value(&oversized, &BasesTimezone::Utc)
                .unwrap_err()
                .code,
            "budget"
        );
        let mut nested = BaseValue::Icon {
            value: "book".into(),
        };
        for _ in 0..130 {
            nested = BaseValue::List {
                value: vec![nested],
            };
        }
        assert_eq!(
            runtime_from_base_value(&nested, &BasesTimezone::Utc)
                .unwrap_err()
                .code,
            "budget"
        );
    }

    #[test]
    fn reference_scalar_conversions_and_missing_aggregates_are_typed() {
        assert_eq!(
            eval("number(date('1970-01-02'))").unwrap(),
            BaseValue::Number {
                value: 86_400_000.0
            }
        );
        assert_eq!(
            eval("date(date('2025-01-01')) == date('2025-01-01')").unwrap(),
            BaseValue::Boolean { value: true }
        );
        for source in ["max()", "min()", "max(null,null)"] {
            assert_eq!(eval(source).unwrap(), BaseValue::Null, "{source}");
        }
        assert_eq!(eval("max(null,2,4)").unwrap(), BaseValue::Null);
        assert_eq!(eval("min('3',4)").unwrap_err().code, "type");
    }
    #[test]
    fn ordinary_frontmatter_infers_links_urls_dates_recursively_without_a_registry() {
        let input = RuntimeValue::Object(IndexMap::from([
            (
                "author".into(),
                RuntimeValue::String("[[Authors/Ada|Ada]]".into()),
            ),
            (
                "mixed".into(),
                RuntimeValue::List(vec![
                    RuntimeValue::String("https://example.test".into()),
                    RuntimeValue::String("2024-01-21 14:30".into()),
                    RuntimeValue::String("20240121".into()),
                ]),
            ),
        ]));
        let RuntimeValue::Object(values) = infer_frontmatter_value(input, &BasesTimezone::Utc)
        else {
            panic!("object")
        };
        let RuntimeValue::Link(link) = &values["author"] else {
            panic!("link")
        };
        assert_eq!(link.path, "Authors/Ada");
        assert_eq!(link.display.as_deref(), Some("Ada"));
        assert_eq!(link.resolved_path, None);
        assert!(link.target.is_none());
        let RuntimeValue::List(mixed) = &values["mixed"] else {
            panic!("list")
        };
        assert!(matches!(&mixed[0],RuntimeValue::Link(link) if link.external));
        assert!(matches!(&mixed[1], RuntimeValue::Date(_)));
        assert!(matches!(&mixed[2],RuntimeValue::String(value) if value=="20240121"));
        for source in ["[[Authors/Ada]] ", " [[Authors/Ada]]", "2024-99-99"] {
            assert!(matches!(
                infer_frontmatter_value(RuntimeValue::String(source.into()), &BasesTimezone::Utc),
                RuntimeValue::String(_)
            ));
        }
    }

    #[test]
    fn url_classification_matches_url_constructor_and_frontmatter_space_guard() {
        for value in [
            "https://example.test",
            "http:example.test",
            "mailto:a@example.test",
            "obsidian://open?vault=Test",
            "data:text/plain,hello",
        ] {
            assert!(is_external(value), "{value}");
            assert!(
                matches!(infer_frontmatter_value(RuntimeValue::String(value.into()),&BasesTimezone::Utc),RuntimeValue::Link(link) if link.external),
                "{value}"
            );
        }
        for value in [
            "https://",
            "http://[invalid]",
            "https://example.test:999999",
            "ordinary text",
            "Project: Draft",
        ] {
            assert!(
                matches!(
                    infer_frontmatter_value(
                        RuntimeValue::String(value.into()),
                        &BasesTimezone::Utc
                    ),
                    RuntimeValue::String(_)
                ),
                "{value}"
            );
        }
        assert!(is_external("Project: Draft")); // Valid opaque URL, deliberately not frontmatter auto-link text.
        assert!(!is_external("https://"));
    }

    #[test]
    fn current_context_detection_uses_ast_reads_not_substring_matching() {
        for source in [
            "this.file.path == file.path",
            "THIS.author == 'Ada'",
            "note[this.field]",
            "[1].map(this.author)",
        ] {
            assert!(uses_current_context(source), "{source}");
        }
        for source in [
            "note.this == 'this'",
            "note['this'] == 'this'",
            "'this.file'",
            "/this/.matches('text')",
            "file.path == 'this.md'",
        ] {
            assert!(!uses_current_context(source), "{source}");
        }
    }
}

#[cfg(test)]
mod loose_group_reference_tests {
    use super::*;
    // Literal oracle cases transcribed from shipped Date.looseEquals and
    // List.toString rules; no source artifact is embedded in the repository.
    #[test]
    fn date_string_loose_equality_uses_strict_shapes_and_civil_days() {
        let context = BasesEvaluationContext::default();
        for (source, expected) in [
            ("date('2026-01-01') == '2026-01-01T12:00:00Z'", true),
            ("'2026-01-01T12:00:00Z' == date('2026-01-01')", true),
            ("date('2026-01-01T12:00:00Z') == '2026-01-01'", true),
            (
                "date('2026-01-01T12:00:00Z') == '2026-01-01T18:00:00Z'",
                false,
            ),
            ("date('2026-01-01') == '20260101'", false),
            ("date('2026-01-01') == '2026-1-1'", false),
            (
                "date('2026-01-01') == '2026-01-01T12:00:00.1234567890Z'",
                false,
            ),
            ("date('2026-01-01') == 'invalid'", false),
            ("[date('2026-01-01')] == ['2026-01-01T12:00:00Z']", true),
            ("date('2026-01-01') == ['2026-01-01T12:00:00Z']", true),
        ] {
            assert_eq!(
                evaluate(source, &context).unwrap().value,
                BaseValue::Boolean { value: expected },
                "{source}"
            );
        }
    }
    #[test]
    fn list_tostring_matches_manual_group_fallback() {
        let value = RuntimeValue::List(vec![
            RuntimeValue::Number(1.0),
            RuntimeValue::List(vec![RuntimeValue::Number(2.0), RuntimeValue::Number(3.0)]),
        ]);
        assert_eq!(stringify(&value), "1, 2, 3");
        assert!(group_values_match(
            &RuntimeValue::String("1, 2, 3".into()),
            &value,
            true,
            &BasesTimezone::Utc,
            None,
            &crate::EvaluationOptions::default(),
            &mut |_| Ok(())
        )
        .unwrap());
        let mut charged = 0usize;
        assert_eq!(
            group_values_match(
                &RuntimeValue::String("1, 2, 3".into()),
                &value,
                true,
                &BasesTimezone::Utc,
                None,
                &crate::EvaluationOptions::default(),
                &mut |work| {
                    charged += work;
                    if charged > 3 {
                        Err(ExpressionDiagnostic::new("budget", "test comparison limit"))
                    } else {
                        Ok(())
                    }
                }
            )
            .unwrap_err()
            .code,
            "budget"
        );
    }
}
#[cfg(test)]
#[path = "link_subpath_tests.rs"]
mod link_subpath_tests;

#[cfg(test)]
mod group_link_spelling_tests {
    use super::*;
    #[test]
    fn canonical_relations_restore_explicit_fragment_once_and_file_identity_has_none() {
        for (path, subpath, resolved, expected) in [
            (
                "People/A#B.md",
                Some("#Heading"),
                Some("People/A#B.md"),
                "[[People/A#B.md#Heading|Alias]]",
            ),
            (
                "People/A#B.md",
                Some("#^block-id"),
                Some("People/A#B.md"),
                "[[People/A#B.md#^block-id|Alias]]",
            ),
            (
                "../People/A%23B.md#Heading",
                Some("#Heading"),
                Some("People/A#B.md"),
                "[[../People/A%23B.md#Heading|Alias]]",
            ),
            (
                "People/A#B.md",
                None,
                Some("People/A#B.md"),
                "[[People/A#B.md|Alias]]",
            ),
            (
                "Missing#Heading",
                Some("#Heading"),
                None,
                "[[Missing#Heading|Alias]]",
            ),
        ] {
            let value = RuntimeValue::Link(BasesLink {
                path: path.into(),
                subpath: subpath.map(str::to_string),
                resolved_path: Some(resolved.map(str::to_string)),
                display: Some("Alias".into()),
                ..Default::default()
            });
            assert_eq!(stringify(&value), expected);
        }
    }
}

#[cfg(test)]
mod loose_link_reference_tests {
    use super::*;
    #[test]
    fn reciprocal_primitives_and_dates_preserve_link_raw_data_rules() {
        let context = BasesEvaluationContext::default();
        for (source, expected) in [
            ("link('Missing') == 'Missing'", true),
            ("link('Missing') == '42'", false),
            ("link('Missing') == ' [[Missing]] '", false),
            ("[link('Missing')].containsAll('Missing','Missing')", true),
            ("[link('Missing')].containsAny('Other','Missing')", true),
            ("link('2') == 2", true),
            ("2 == link('2')", true),
            ("link('false') == false", false),
            ("link('0') == false", true),
            ("link('') == false", true),
            ("link('1') == true", true),
            ("link('') == null", false),
            ("null == link('null')", false),
            ("date('2026-01-01') == link('2026-01-01T12:00:00Z')", true),
            ("link('2026-01-01') == date('2026-01-01T12:00:00Z')", true),
            ("date('2026-01-01') == link('20260101')", false),
            ("date('2026-01-01') == 1767225600000", false),
            ("'' == 0", true),
            ("'  ' == 0", true),
            ("'0x10' == 16", true),
            ("'0b10' == 2", true),
            ("'0o10' == 8", true),
            ("'+0x10' == 16", false),
            ("'inf' == 1", false),
        ] {
            assert_eq!(
                evaluate(source, &context).unwrap().value,
                BaseValue::Boolean { value: expected },
                "{source}"
            );
        }
    }
    #[test]
    fn unbound_wiki_equality_is_unavailable_instead_of_an_empty_namespace() {
        // These operands require root-origin resolution. Actual immutable
        // generation tests cover their positive and known-unresolved cases;
        // an unbound evaluator must not invent an empty vault namespace.
        for source in [
            "link('Missing') == '[[Missing|Alias]]'",
            "'[[Missing|Alias]]' == link('Missing')",
            "link('Missing') == '[[Other]]'",
            "[link('Missing')] == ['[[Missing|Alias]]']",
            "[link('Missing')].contains('[[Missing|Alias]]')",
            "[link('Missing')].containsAll('Missing','[[Missing]]')",
            "[link('Missing')].containsAny('Other','[[Missing]]')",
        ] {
            assert_eq!(
                evaluate(source, &BasesEvaluationContext::default())
                    .unwrap_err()
                    .code,
                "unavailable",
                "{source}"
            );
        }
    }
    #[test]
    fn radix_primitive_coercion_rounds_only_once() {
        // Direct JavaScript Number(string) oracles, independently observed from
        // the runtime used by the shipped primitive data== comparison.
        for (source, expected) in [
            ("0x1000000000000081", 1152921504606847200.0),
            ("0x2000000000000101", 2305843009213694500.0),
            ("0x20000000000001", 9007199254740992.0),
            ("0x20000000000003", 9007199254740996.0),
        ] {
            assert_eq!(loose_numeric_text(source), Some(expected), "{source}");
        }
    }
    #[test]
    fn checked_wiki_comparison_propagates_budget_and_cancellation() {
        let link = RuntimeValue::Link(BasesLink {
            path: "Missing".into(),
            ..Default::default()
        });
        let text = RuntimeValue::String("[[Missing|Alias]]".into());
        let context = BasesEvaluationContext {
            work_limit: Some(0),
            ..Default::default()
        };
        let error = Evaluator::new(&context)
            .equals_checked(&link, &text)
            .unwrap_err();
        assert!(matches!(error,RuntimeValue::Error(message)if message.starts_with("budget\0")));
        let cancelled = OperationCancellation::default();
        cancelled.cancel();
        let context = BasesEvaluationContext {
            cancellation: Some(cancelled),
            ..Default::default()
        };
        let error = Evaluator::new(&context)
            .equals_checked(&link, &text)
            .unwrap_err();
        assert!(matches!(error,RuntimeValue::Error(message)if message.starts_with("cancelled\0")));
    }
    #[test]
    fn file_string_is_exact_path_and_file_link_accepts_raw_or_resolved_identity() {
        let file = RuntimeValue::File(Box::new(BasesFile {
            path: "People/A.md".into(),
            ..Default::default()
        }));
        let context = BasesEvaluationContext::default();
        let mut evaluator = Evaluator::new(&context);
        assert!(evaluator
            .equals_checked(&file, &RuntimeValue::String("People/A.md".into()))
            .unwrap());
        assert!(!evaluator
            .equals_checked(&file, &RuntimeValue::String("[[People/A.md|Alias]]".into()))
            .unwrap());
        let raw = RuntimeValue::Link(BasesLink {
            path: "People/A.md".into(),
            ..Default::default()
        });
        assert!(evaluator.equals_checked(&file, &raw).unwrap());
        let resolved = RuntimeValue::Link(BasesLink {
            path: "../People/A".into(),
            resolved_path: Some(Some("People/A.md".into())),
            ..Default::default()
        });
        assert!(evaluator.equals_checked(&resolved, &file).unwrap());
        let unresolved = RuntimeValue::Link(BasesLink {
            path: "../People/A".into(),
            resolved_path: Some(None),
            ..Default::default()
        });
        assert!(evaluator.equals_checked(&resolved, &unresolved).unwrap());
    }
}

#[cfg(test)]
mod checked_comparison_admission_tests {
    use super::*;
    fn object(fields: usize) -> RuntimeValue {
        RuntimeValue::Object(
            (0..fields)
                .map(|index| {
                    (
                        format!("field-{index}"),
                        RuntimeValue::String("value-value-1234".into()),
                    )
                })
                .collect(),
        )
    }
    #[test]
    fn strict_objects_charge_wide_deep_and_repeated_comparisons() {
        let wide = object(128);
        let context = BasesEvaluationContext {
            work_limit: Some(32),
            ..Default::default()
        };
        assert!(
            matches!(Evaluator::new(&context).equals_checked(&wide,&wide),Err(RuntimeValue::Error(message))if message.starts_with("budget\0"))
        );
        let mut deep = RuntimeValue::String("leaf".into());
        for _ in 0..40 {
            deep = RuntimeValue::Object(IndexMap::from([("child".into(), deep)]));
        }
        assert!(
            matches!(Evaluator::new(&context).equals_checked(&deep,&deep),Err(RuntimeValue::Error(message))if message.starts_with("budget\0"))
        );
        let small = object(1);
        // Objects now compare constructor-strict children instead of copying
        // plain JSON values. Keep a fixed narrow ceiling for one comparison,
        // then test repetition without coupling to its exact traversal charge.
        let mut probe = Evaluator::new(&context);
        let before = probe.remaining_work;
        assert!(probe.equals_checked(&small, &small).unwrap());
        let comparison_work = before - probe.remaining_work;
        assert!((1..=32).contains(&comparison_work));
        let context = BasesEvaluationContext {
            work_limit: Some(comparison_work * 2),
            ..Default::default()
        };
        let mut evaluator = Evaluator::new(&context);
        assert!(evaluator.equals_checked(&small, &small).unwrap());
        assert!(evaluator.equals_checked(&small, &small).unwrap());
        assert_eq!(evaluator.remaining_work, 0);
        assert!(
            matches!(evaluator.equals_checked(&small,&small),Err(RuntimeValue::Error(message))if message.starts_with("budget\0"))
        );
        let cancellation = OperationCancellation::default();
        cancellation.cancel();
        let context = BasesEvaluationContext {
            cancellation: Some(cancellation),
            ..Default::default()
        };
        assert!(
            matches!(Evaluator::new(&context).equals_checked(&wide,&wide),Err(RuntimeValue::Error(message))if message.starts_with("cancelled\0"))
        );
    }
    #[test]
    fn repeated_large_object_and_string_needles_pay_for_each_fallback_copy() {
        let payload = "x".repeat(1024 * 1024);
        let object_needle = RuntimeValue::Object(IndexMap::from([(
            "payload".into(),
            RuntimeValue::String(payload.clone()),
        )]));
        let empty_objects = (0..1000)
            .map(|_| RuntimeValue::Object(IndexMap::new()))
            .collect::<Vec<_>>();
        let context = BasesEvaluationContext {
            work_limit: Some(100_000),
            ..Default::default()
        };
        assert!(
            matches!(Evaluator::new(&context).contains_checked(&empty_objects,&object_needle),Err(RuntimeValue::Error(message))if message.starts_with("budget\0"))
        );
        let string_needle = RuntimeValue::String(payload);
        let empty_strings = (0..1000)
            .map(|_| RuntimeValue::String(String::new()))
            .collect::<Vec<_>>();
        assert!(
            matches!(Evaluator::new(&context).contains_checked(&empty_strings,&string_needle),Err(RuntimeValue::Error(message))if message.starts_with("budget\0"))
        );
    }
    #[test]
    fn nested_diagnostics_are_not_false_equality_or_membership() {
        for code in ["unavailable", "budget", "cancelled"] {
            let diagnostic = RuntimeValue::Error(format!("{code}\0Captured diagnostic"));
            let nested = RuntimeValue::List(vec![RuntimeValue::Object(IndexMap::from([(
                "nested".into(),
                diagnostic.clone(),
            )]))]);
            let context = BasesEvaluationContext::default();
            let mut evaluator = Evaluator::new(&context);
            for result in [
                evaluator.equals_checked(&nested, &RuntimeValue::List(vec![])),
                evaluator.equals_checked(&nested, &nested),
                evaluator.contains_checked(
                    &[RuntimeValue::Bool(true), nested.clone()],
                    &RuntimeValue::Bool(true),
                ),
                evaluator.contains_checked(&[], &nested),
            ] {
                assert!(
                    matches!(result,Err(RuntimeValue::Error(message))if message.starts_with(&format!("{code}\0")))
                );
            }
        }
    }
}

#[cfg(test)]
mod tag_provenance_budget_tests {
    use super::*;

    #[test]
    fn provenance_admits_vector_growth_and_key_copies_before_allocating() {
        let context = BasesEvaluationContext::default();
        let mut evaluator = Evaluator::new(&context);
        let mut reservations = Vec::new();
        let values = RuntimeValue::List(vec![RuntimeValue::Tag("#a".into()); 9]);
        let shape = evaluator
            .tag_shape(&values, 0, &mut |bytes| {
                reservations.push(bytes);
                Ok(())
            })
            .unwrap()
            .unwrap();
        let TagShape::List(shapes) = shape else {
            panic!("list provenance")
        };
        assert_eq!(shapes.len(), 9);
        // Full capacity is paid at each growth, including spare slots.
        assert_eq!(
            reservations.iter().sum::<usize>(),
            shapes.capacity() * std::mem::size_of::<(usize, TagShape)>()
        );

        let mut calls = 0;
        let error = evaluator
            .tag_shape(&values, 0, &mut |_| {
                calls += 1;
                Err(ExpressionDiagnostic::new(
                    "budget",
                    "Rejected before growth",
                ))
            })
            .unwrap_err();
        assert_eq!(runtime_diagnostic(error).code, "budget");
        assert_eq!(calls, 1);
        let object = RuntimeValue::Object(IndexMap::from([(
            "key".into(),
            RuntimeValue::Tag("#a".into()),
        )]));
        let mut bytes = 0;
        let shape = evaluator
            .tag_shape(&object, 0, &mut |cost| {
                bytes += cost;
                Ok(())
            })
            .unwrap()
            .unwrap();
        let TagShape::Object(shapes) = shape else {
            panic!("object provenance")
        };
        assert_eq!(
            bytes,
            shapes.capacity() * std::mem::size_of::<(String, TagShape)>() + 3
        );
    }

    #[test]
    fn object_callbacks_charge_large_materialized_errors_in_each_parent_scope_copy() {
        let context = BasesEvaluationContext {
            work_limit: Some(100_000),
            ..Default::default()
        };
        let mut evaluator = Evaluator::new(&context);
        let values = (0..1000)
            .map(|i| (format!("field{i}"), RuntimeValue::Number(1.0)))
            .collect();
        let scope = BTreeMap::from([(
            "captured".into(),
            RuntimeValue::ErrorValue("x".repeat(1024 * 1024)),
        )]);
        let error =
            evaluator.object_method(values, "map", &[Expr::Literal(Value::Null)], &scope, None);
        assert_eq!(runtime_diagnostic(error).code, "budget");
    }

    #[test]
    fn provenance_extraction_and_restoration_preserve_cancellation_and_work_errors() {
        let context = BasesEvaluationContext {
            work_limit: Some(1),
            ..Default::default()
        };
        let mut evaluator = Evaluator::new(&context);
        let value = RuntimeValue::List(vec![RuntimeValue::Tag("#a".into())]);
        let error = evaluator.tag_shape(&value, 0, &mut |_| Ok(())).unwrap_err();
        assert_eq!(runtime_diagnostic(error).code, "budget");
        let cancellation = OperationCancellation::default();
        cancellation.cancel();
        let context = BasesEvaluationContext {
            cancellation: Some(cancellation),
            ..Default::default()
        };
        let mut evaluator = Evaluator::new(&context);
        let error = evaluator
            .restore_tags(&mut RuntimeValue::String("#a".into()), &TagShape::Tag, 0)
            .unwrap_err();
        assert_eq!(runtime_diagnostic(error).code, "cancelled");
    }
}
