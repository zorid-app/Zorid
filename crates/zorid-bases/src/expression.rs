// Adapted from callumalpass/mdbase-rs, MIT, Copyright (c) 2025 Callum Alpass.
// Pinned origin and modifications: ../UPSTREAM.md; full notice: ../LICENSE-MDBASE.
use indexmap::IndexMap;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, OnceLock, RwLock};

use chrono::{
    DateTime, Datelike, FixedOffset, LocalResult, Months, NaiveDate, NaiveDateTime, TimeZone,
    Timelike, Utc,
};
use chrono_tz::{GapInfo, Tz};
use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};

#[path = "expression_format.rs"]
mod date_format;

use crate::{BaseValue, EvaluationResult, ExpressionDiagnostic, OperationCancellation};
#[derive(Clone, Debug, PartialEq)]
enum Expr {
    Literal(Value),
    Regex(String, String),
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
            TokenKind::Regex(pattern, flags) => Ok(Expr::Regex(pattern, flags)),
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
    Date(DateValue),
    Duration(DurationValue),
    List(Vec<RuntimeValue>),
    Object(IndexMap<String, RuntimeValue>),
    File(Box<BasesFile>),
    Link(BasesLink),
    Regex(String, String),
    Html(String),
    Image(String),
    Icon(String),
    Error(String),
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
        let ast = parse_cached(source).map_err(|message| {
            let (code, text) = message
                .split_once('\0')
                .unwrap_or(("parse", message.as_str()));
            ExpressionDiagnostic::new(code, text)
        })?;
        let value = self.evaluator.evaluate(ast.as_ref(), &BTreeMap::new());
        typed_result(value)
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
            RuntimeValue::List(values) => values.iter_mut().for_each(mark),
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
    options: &crate::EvaluationOptions,
    relationships: Option<&super::graph::PreparedRelationships<'_>>,
    shared_files: Option<Arc<super::files::BasesFiles>>,
    mut file: impl FnMut(&str) -> Result<BasesFile, ExpressionDiagnostic>,
) -> Result<EvaluationResult, ExpressionDiagnostic> {
    let timezone = BasesTimezone::from_setting(Some(&options.timezone))
        .map_err(|message| ExpressionDiagnostic::new("input", message))?;
    let context = BasesEvaluationContext {
        relationships,
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
    let mut bytes = 0usize;
    let mut converted = Vec::new();
    for value in values {
        converted.push(summary_runtime_value(
            value,
            0,
            &mut bytes,
            &mut evaluator,
            &mut file,
        )?);
    }
    let value = match parse_cached(source) {
        Ok(ast) => {
            let scope = BTreeMap::from([("values".into(), RuntimeValue::List(converted))]);
            typed_result(evaluator.evaluate(&ast, &scope))
        }
        Err(message) => {
            let (code, text) = message.split_once('\0').unwrap_or(("parse", &message));
            Err(ExpressionDiagnostic::new(code, text))
        }
    };
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
    let value = summary_runtime_value(value, 0, &mut 0usize, &mut evaluator, &mut file)?;
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
        | RuntimeValue::Html(value)
        | RuntimeValue::Image(value)
        | RuntimeValue::Icon(value)
        | RuntimeValue::Error(value) => check(value.len() / 16)?,
        RuntimeValue::Link(link) => check(
            link.path
                .len()
                .saturating_add(link.display.as_ref().map_or(0, String::len))
                .saturating_add(
                    link.resolved_path
                        .as_ref()
                        .and_then(Option::as_ref)
                        .map_or(0, String::len),
                )
                / 16,
        )?,
        RuntimeValue::File(file) => check(file.path.len() / 16)?,
        RuntimeValue::List(values) => {
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
    check: &mut impl FnMut(usize) -> Result<(), ExpressionDiagnostic>,
) -> Result<bool, ExpressionDiagnostic> {
    group_comparison_work(key, check)?;
    group_comparison_work(value, check)?;
    let context = BasesEvaluationContext {
        timezone: timezone.clone(),
        ..Default::default()
    };
    let evaluator = Evaluator::new(&context);
    Ok(evaluator.equals(key, value)
        || manual && matches!(key,RuntimeValue::String(key) if key==&stringify(value)))
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
            *bytes = bytes.saturating_add(path.len() + subpath.as_ref().map_or(0, String::len) + display.as_ref().map_or(0, String::len));
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
            RuntimeValue::Error(format!("{code}\0{message}"))
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

pub(crate) fn validate(expression: &str) -> Result<(), String> {
    parse_cached(expression).map(|_| ())
}

pub(crate) fn matches(expression: &str, context: &BasesEvaluationContext) -> Result<bool, String> {
    let ast = parse_cached(expression)?;
    let mut evaluator = Evaluator::new(context);
    match evaluator.evaluate(ast.as_ref(), &BTreeMap::new()) {
        RuntimeValue::Error(message) => Err(message),
        value => Ok(is_truthy(&value)),
    }
}

fn parse_cached(expression: &str) -> Result<Arc<Expr>, String> {
    if expression.len() > 65_536 {
        return Err("Expression exceeds 65536 bytes".into());
    }
    if expression.trim().is_empty() {
        return Ok(Arc::new(Expr::Literal(Value::Null)));
    }
    const MAX_ENTRIES: usize = 64; // <= 4 MiB of source keys plus bounded ASTs
    static CACHE: OnceLock<RwLock<HashMap<String, Arc<Expr>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    if let Ok(cache) = cache.read() {
        if let Some(ast) = cache.get(expression) {
            return Ok(ast.clone());
        }
    }
    let ast = Arc::new(Parser::parse(expression)?);
    if let Ok(mut cache) = cache.write() {
        if cache.len() >= MAX_ENTRIES {
            cache.clear();
        }
        cache.insert(expression.to_string(), ast.clone());
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
            Expr::Literal(_) | Expr::Regex(_, _) => false,
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
            Expr::Literal(_) | Expr::Regex(_, _) | Expr::Identifier(_) => Some(()),
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
        .is_some_and(|ast| walk(&ast, check).is_some())
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
            Expr::Literal(_) | Expr::Regex(_, _) | Expr::Identifier(_) => Some(Dependency::None),
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
        .and_then(|ast| walk(&ast, check))
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
        Expr::Literal(_) | Expr::Regex(_, _) | Expr::Identifier(_) => false,
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
        Expr::Literal(_) | Expr::Regex(_, _) | Expr::Identifier(_) => false,
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
        Expr::Literal(_) | Expr::Regex(_, _) | Expr::Identifier(_) => false,
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

fn string_data(value: &RuntimeValue) -> Option<&str> {
    match value {
        RuntimeValue::String(value)
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
            Expr::Regex(pattern, flags) => RuntimeValue::Regex(pattern.clone(), flags.clone()),
            Expr::Identifier(name) => self.identifier(name, scope),
            Expr::Array(values) => {
                let mut result = Vec::new();
                let mut bytes = 0usize;
                for value in values {
                    let value = self.evaluate(value, scope);
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
            if operator == "+"
                && !matches!(left, RuntimeValue::String(_))
                && !matches!(right, RuntimeValue::String(_))
            {
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
                (RuntimeValue::Number(_), RuntimeValue::Duration(_)) => {
                    RuntimeValue::Error("Invalid operator between Number and Duration".to_string())
                }
                _ => numeric_pair(self, &left, &right, |a, b| a * b),
            },
            "/" => numeric_pair(self, &left, &right, |a, b| a / b),
            "%" => numeric_pair(self, &left, &right, |a, b| a % b),
            "==" => RuntimeValue::Bool(self.equals(&left, &right)),
            "!=" => RuntimeValue::Bool(!self.equals(&left, &right)),
            ">" | "<" | ">=" | "<=" => self
                .compare(&left, &right, operator)
                .map(RuntimeValue::Bool)
                .unwrap_or_else(RuntimeValue::Error),
            _ => RuntimeValue::Error(format!("Unsupported operator {operator}")),
        }
    }

    fn add(&self, left: RuntimeValue, right: RuntimeValue) -> RuntimeValue {
        if let (RuntimeValue::List(a), RuntimeValue::List(b)) = (&left, &right) {
            return RuntimeValue::List(a.iter().chain(b).cloned().collect());
        }
        if let RuntimeValue::Date(date) = &left {
            if let Some(duration) = coerce_duration(&right) {
                return add_duration(date, &duration, 1.0)
                    .map(RuntimeValue::Date)
                    .unwrap_or_else(RuntimeValue::Error);
            }
        }
        if matches!(left, RuntimeValue::String(_)) || matches!(right, RuntimeValue::String(_)) {
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
                            RuntimeValue::String(name) => name,
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
                plain_string(&value)
            }
        };
        self.property(object, &property)
    }

    fn call(&mut self, callee: &Expr, arguments: &[Expr], scope: &Scope) -> RuntimeValue {
        match callee {
            Expr::Identifier(name) if name.eq_ignore_ascii_case("if") => {
                let condition = arguments
                    .first()
                    .map(|value| self.evaluate(value, scope))
                    .unwrap_or(RuntimeValue::Null);
                if matches!(condition, RuntimeValue::Error(_)) {
                    return condition;
                }
                if is_truthy(&condition) {
                    arguments
                        .get(1)
                        .map(|value| self.evaluate(value, scope))
                        .unwrap_or(RuntimeValue::Null)
                } else {
                    arguments
                        .get(2)
                        .map(|value| self.evaluate(value, scope))
                        .unwrap_or(RuntimeValue::Null)
                }
            }
            Expr::Identifier(name) => {
                let arguments = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                self.global(name, &arguments)
            }
            Expr::Member(object, Member::Named(method)) => {
                let receiver = self.evaluate(object, scope);
                self.method(receiver, method, arguments, scope)
            }
            _ => RuntimeValue::Error("Expression is not callable".to_string()),
        }
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

    fn evaluate_arguments(
        &mut self,
        arguments: &[Expr],
        scope: &Scope,
    ) -> Result<Vec<RuntimeValue>, RuntimeValue> {
        let mut values = Vec::new();
        let mut bytes = 0usize;
        for argument in arguments {
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
            values.push(value);
        }
        Ok(values)
    }

    fn global(&mut self, name: &str, arguments: &[RuntimeValue]) -> RuntimeValue {
        let name = canonical_function_name(name);
        let first = arguments.first().cloned().unwrap_or(RuntimeValue::Null);
        match name {
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
                RuntimeValue::List(_) | RuntimeValue::Null => first,
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

    fn method(
        &mut self,
        receiver: RuntimeValue,
        name: &str,
        arguments: &[Expr],
        scope: &Scope,
    ) -> RuntimeValue {
        let name = canonical_function_name(name);
        let work = match &receiver {
            RuntimeValue::List(values) => values.len(),
            RuntimeValue::Object(values) => values.len(),
            RuntimeValue::File(file) if name == "hasLink" => file.links.len(),
            RuntimeValue::String(value) => value.len() / 256,
            _ => 0,
        };
        if let Err(error) = self.charge(work) {
            return error;
        }
        if name == "isTruthy" {
            return RuntimeValue::Bool(is_truthy(&receiver));
        }
        if name == "isEmpty" {
            return RuntimeValue::Bool(is_empty(&receiver));
        }
        if name == "toString" {
            return RuntimeValue::String(stringify(&receiver));
        }
        if name == "isType" {
            let values = match self.evaluate_arguments(arguments, scope) {
                Ok(values) => values,
                Err(error) => return error,
            };
            let expected = values.first().map(plain_string).unwrap_or_default();
            return RuntimeValue::Bool(
                value_type(&receiver).eq_ignore_ascii_case(&expected)
                    || expected.eq_ignore_ascii_case("string")
                        && matches!(
                            &receiver,
                            RuntimeValue::Link(_)
                                | RuntimeValue::Html(_)
                                | RuntimeValue::Image(_)
                                | RuntimeValue::Icon(_)
                        ),
            );
        }
        if let RuntimeValue::Error(_) = receiver {
            return receiver;
        }
        match receiver {
            // As in Obsidian, a method on a missing value is missing rather than an error.
            RuntimeValue::Null => RuntimeValue::Null,
            RuntimeValue::String(value) => {
                let values = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                self.string_method(&value, name, &values)
            }
            RuntimeValue::Html(value) | RuntimeValue::Image(value) | RuntimeValue::Icon(value) => {
                let values = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                self.string_method(&value, name, &values)
            }
            RuntimeValue::Number(value) => {
                let values = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                self.number_method(value, name, &values)
            }
            RuntimeValue::Date(value) => {
                let values = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                self.date_method(&value, name, &values)
            }
            RuntimeValue::List(values) => self.list_method(&values, name, arguments, scope),
            RuntimeValue::Object(value) => match name {
                "keys" => {
                    RuntimeValue::List(value.keys().cloned().map(RuntimeValue::String).collect())
                }
                "values" => RuntimeValue::List(value.values().cloned().collect()),
                _ => method_not_found("Object", name),
            },
            RuntimeValue::Regex(pattern, flags) if name == "matches" => {
                let values = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                let candidate = values.first().map(plain_string).unwrap_or_default();
                match regex_is_match(&pattern, &flags, &candidate) {
                    Ok(matches) => RuntimeValue::Bool(matches),
                    Err(error) => RuntimeValue::Error(error),
                }
            }
            RuntimeValue::File(file) => {
                let values = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                self.file_method(&file, name, &values)
            }
            RuntimeValue::Link(link) => {
                let values = match self.evaluate_arguments(arguments, scope) {
                    Ok(values) => values,
                    Err(error) => return error,
                };
                self.link_method(&link, name, &values)
            }
            value => method_not_found(value_type(&value), name),
        }
    }

    fn string_method(&self, value: &str, name: &str, arguments: &[RuntimeValue]) -> RuntimeValue {
        let first = arguments.first().cloned().unwrap_or(RuntimeValue::Null);
        match name {
            "contains" => RuntimeValue::Bool(
                !plain_string(&first).is_empty()
                    && value
                        .to_lowercase()
                        .contains(&plain_string(&first).to_lowercase()),
            ),
            "containsAll" => RuntimeValue::Bool(
                arguments
                    .iter()
                    .all(|argument| value.contains(&plain_string(argument))),
            ),
            "containsAny" => RuntimeValue::Bool(
                arguments
                    .iter()
                    .any(|argument| value.contains(&plain_string(argument))),
            ),
            "endsWith" => RuntimeValue::Bool(value.ends_with(&plain_string(&first))),
            "lower" => RuntimeValue::String(value.to_lowercase()),
            "replace" => {
                let replacement = arguments.get(1).map(plain_string).unwrap_or_default();
                if value.len().saturating_add(
                    value
                        .len()
                        .saturating_add(1)
                        .saturating_mul(replacement.len()),
                ) > 8 * 1024 * 1024
                {
                    return RuntimeValue::Error("budget\0Replacement exceeds byte budget".into());
                }
                match first {
                    RuntimeValue::Regex(pattern, flags) => {
                        regex_replace(value, &pattern, &flags, &replacement)
                            .map(RuntimeValue::String)
                            .unwrap_or_else(RuntimeValue::Error)
                    }
                    other => {
                        RuntimeValue::String(value.replace(&plain_string(&other), &replacement))
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
                    .map(|value| value as usize),
            ),
            "startsWith" => RuntimeValue::Bool(value.starts_with(&plain_string(&first))),
            "title" => RuntimeValue::String(title_case(value)),
            "trim" => RuntimeValue::String(value.trim().to_string()),
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
                let factor = 10_f64.powf(digits);
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
                    .unwrap_or(0.0)
                    .max(0.0) as usize;
                if digits > 100 {
                    RuntimeValue::Error("budget\0Numeric precision exceeds 100".into())
                } else {
                    RuntimeValue::String(format!("{value:.digits$}"))
                }
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
    ) -> RuntimeValue {
        let eager = if ["map", "filter", "reduce"].contains(&name) {
            Vec::new()
        } else {
            match self.evaluate_arguments(arguments, scope) {
                Ok(values) => values,
                Err(error) => return error,
            }
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
                RuntimeValue::Bool(values.iter().any(|value| self.equals(value, &needle)))
            }
            "containsAll" => RuntimeValue::Bool(
                eager
                    .iter()
                    .all(|needle| values.iter().any(|value| self.equals(value, needle))),
            ),
            "containsAny" => RuntimeValue::Bool(
                eager
                    .iter()
                    .any(|needle| values.iter().any(|value| self.equals(value, needle))),
            ),
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
            "flat" => RuntimeValue::List(
                values
                    .iter()
                    .flat_map(|value| match value {
                        RuntimeValue::List(values) => values.clone(),
                        value => vec![value.clone()],
                    })
                    .collect(),
            ),
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
            "unique" => {
                let mut seen = HashSet::new();
                RuntimeValue::List(
                    values
                        .iter()
                        .filter(|value| {
                            matches!(value, RuntimeValue::Error(_))
                                || seen.insert(unique_key(value))
                        })
                        .cloned()
                        .collect(),
                )
            }
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
                    RuntimeValue::String(value) => {
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
            RuntimeValue::List(values) if property.eq_ignore_ascii_case("length") => {
                RuntimeValue::Number(values.len() as f64)
            }
            RuntimeValue::List(values) => property
                .parse::<isize>()
                .ok()
                .and_then(|index| index_value(&values, index))
                .unwrap_or_else(|| member_not_found("List", property)),
            RuntimeValue::Object(values) => values
                .get(own_key(&values, property).unwrap_or(property))
                .cloned()
                .unwrap_or(RuntimeValue::Null),
            RuntimeValue::Date(value) => date_property(&value, &property.to_lowercase()),
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
        let value = parse_cached(expression)
            .map(|expression| self.evaluate(expression.as_ref(), &BTreeMap::new()))
            .unwrap_or_else(RuntimeValue::Error);
        self.formula_stack.remove(name);
        self.formula_cache.insert(name.to_string(), value.clone());
        value
    }

    fn number(&self, value: &RuntimeValue) -> Result<f64, String> {
        match value {
            RuntimeValue::Number(value) => Ok(*value),
            RuntimeValue::Bool(value) => Ok(if *value { 1.0 } else { 0.0 }),
            RuntimeValue::String(value) => value
                .parse()
                .map_err(|_| format!("Unable to parse {value:?} as a number.")),
            RuntimeValue::Date(value) => Ok(value.millis as f64),
            RuntimeValue::Duration(value) => Ok(duration_millis(value)),
            RuntimeValue::Null => Ok(0.0),
            value => Err(format!("Cannot convert {} to number", value_type(value))),
        }
    }

    fn equals(&self, left: &RuntimeValue, right: &RuntimeValue) -> bool {
        match (left, right) {
            (RuntimeValue::Link(left), RuntimeValue::Link(right)) => {
                self.link_identity(left) == self.link_identity(right)
            }
            (RuntimeValue::Link(left), RuntimeValue::File(right)) => self
                .link_resolved(left)
                .is_some_and(|path| path == right.path),
            (RuntimeValue::File(left), RuntimeValue::Link(right)) => self
                .link_resolved(right)
                .is_some_and(|path| path == left.path),
            (RuntimeValue::Date(left), RuntimeValue::Date(right)) => {
                dates_loosely_equal(left, right)
            }
            (RuntimeValue::Date(date), RuntimeValue::String(text))
            | (RuntimeValue::String(text), RuntimeValue::Date(date)) => {
                parse_frontmatter_date(text, &self.context.timezone)
                    .is_some_and(|other| dates_loosely_equal(date, &other))
            }
            (RuntimeValue::Null, RuntimeValue::Null) => true,
            (RuntimeValue::Null, _) | (_, RuntimeValue::Null) => false,
            (RuntimeValue::List(a), RuntimeValue::List(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| self.equals(a, b))
            }
            (RuntimeValue::List(a), b) if a.len() == 1 => self.equals(&a[0], b),
            (a, RuntimeValue::List(b)) if b.len() == 1 => self.equals(a, &b[0]),
            (RuntimeValue::String(a), RuntimeValue::Number(b))
            | (RuntimeValue::Number(b), RuntimeValue::String(a)) => {
                a.trim().parse::<f64>().ok() == Some(*b)
            }
            (RuntimeValue::Bool(a), RuntimeValue::Number(b))
            | (RuntimeValue::Number(b), RuntimeValue::Bool(a)) => {
                (if *a { 1.0 } else { 0.0 }) == *b
            }
            (RuntimeValue::Bool(a), RuntimeValue::String(b))
            | (RuntimeValue::String(b), RuntimeValue::Bool(a)) => {
                (if *a { 1.0 } else { 0.0 })
                    == if b.is_empty() {
                        0.0
                    } else {
                        b.trim().parse::<f64>().unwrap_or(f64::NAN)
                    }
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
        let ordering =
            if let (RuntimeValue::String(left), RuntimeValue::String(right)) = (left, right) {
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
        RuntimeValue::List(values) => Value::Array(values.iter().map(to_plain).collect()),
        RuntimeValue::Object(values) => Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), to_plain(value)))
                .collect(),
        ),
        RuntimeValue::File(value) => Value::String(value.path.clone()),
        RuntimeValue::Link(value) => Value::String(value.path.clone()),
        RuntimeValue::Regex(pattern, flags) => Value::String(format!("/{pattern}/{flags}")),
        RuntimeValue::Error(message) => Value::Object(Map::from_iter([(
            "error".to_string(),
            Value::String(message.clone()),
        )])),
    }
}

fn plain_string(value: &RuntimeValue) -> String {
    match value {
        RuntimeValue::Null => "null".to_string(),
        RuntimeValue::Bool(value) => value.to_string(),
        RuntimeValue::Number(value) => format_number(*value),
        RuntimeValue::String(value) | RuntimeValue::Html(value) | RuntimeValue::Icon(value) => {
            value.clone()
        }
        RuntimeValue::Date(value) => format_date(
            value,
            if value.date_only {
                "YYYY-MM-DD"
            } else {
                "YYYY-MM-DDTHH:mm:ss"
            },
        ),
        RuntimeValue::Duration(value) => format_duration(value),
        RuntimeValue::List(values) => values
            .iter()
            .map(plain_string)
            .collect::<Vec<_>>()
            .join(", "),
        RuntimeValue::Object(_) => serde_json::to_string(&to_plain(value)).unwrap_or_default(),
        RuntimeValue::File(value) => value.path.clone(),
        RuntimeValue::Link(value) if value.external => value.path.clone(),
        RuntimeValue::Link(value) => value
            .display
            .as_ref()
            .map(|display| format!("[[{}|{display}]]", value.path))
            .unwrap_or_else(|| format!("[[{}]]", value.path)),
        RuntimeValue::Regex(pattern, flags) => format!("/{pattern}/{flags}"),
        RuntimeValue::Image(value) => super::order::image_text(value),
        RuntimeValue::Error(message) => message.clone(),
    }
}

fn stringify(value: &RuntimeValue) -> String {
    plain_string(value)
}

fn is_truthy(value: &RuntimeValue) -> bool {
    match value {
        RuntimeValue::Null | RuntimeValue::Error(_) => false,
        RuntimeValue::Bool(value) => *value,
        RuntimeValue::Number(value) => *value != 0.0 && !value.is_nan(),
        RuntimeValue::String(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Image(value)
        | RuntimeValue::Icon(value) => !value.is_empty(),
        RuntimeValue::Link(link) if link.external => !link.path.is_empty(),
        RuntimeValue::List(value) => !value.is_empty(),
        RuntimeValue::Object(value) => !value.is_empty(),
        _ => true,
    }
}

fn is_empty(value: &RuntimeValue) -> bool {
    match value {
        RuntimeValue::Null => true,
        RuntimeValue::String(value)
        | RuntimeValue::Html(value)
        | RuntimeValue::Image(value)
        | RuntimeValue::Icon(value) => value.is_empty(),
        RuntimeValue::Link(link) => link.path.is_empty(),
        RuntimeValue::Number(value) => value.is_nan(),
        RuntimeValue::List(values) => values.is_empty(),
        RuntimeValue::Object(values) => values.is_empty(),
        _ => false,
    }
}

fn value_type(value: &RuntimeValue) -> &'static str {
    match value {
        RuntimeValue::Null => "Null",
        RuntimeValue::Bool(_) => "Boolean",
        RuntimeValue::Number(_) => "Number",
        RuntimeValue::String(_) => "String",
        RuntimeValue::Date(_) => "Date",
        RuntimeValue::Duration(_) => "Duration",
        RuntimeValue::List(_) => "List",
        RuntimeValue::Object(_) => "Object",
        RuntimeValue::File(_) => "File",
        RuntimeValue::Link(value) if value.external => "URL",
        RuntimeValue::Link(_) => "Link",
        RuntimeValue::Regex(_, _) => "RegExp",
        RuntimeValue::Html(_) => "HTML",
        RuntimeValue::Image(_) => "Image",
        RuntimeValue::Icon(_) => "Icon",
        RuntimeValue::Error(_) => "Error",
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
    if value.fract() == 0.0 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
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
    static PATTERN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(years?|y|months?|M|weeks?|w|days?|d|hours?|h|minutes?|m|seconds?|s|milliseconds?|ms)\b").expect("duration expression")
    });
    let pattern = &*PATTERN;
    let mut duration = DurationValue::default();
    let mut matched = false;
    for captures in pattern.captures_iter(value.trim()) {
        matched = true;
        let amount = captures[1].parse::<f64>().ok()?;
        let unit = &captures[2];
        if unit == "y" || unit.to_lowercase().starts_with("year") {
            duration.years += amount;
        } else if unit == "M" || unit.to_lowercase().starts_with("month") {
            duration.months += amount;
        } else if unit == "w" || unit.to_lowercase().starts_with("week") {
            duration.weeks += amount;
        } else if unit == "d" || unit.to_lowercase().starts_with("day") {
            duration.days += amount;
        } else if unit == "h" || unit.to_lowercase().starts_with("hour") {
            duration.hours += amount;
        } else if unit == "m" || unit.to_lowercase().starts_with("minute") {
            duration.minutes += amount;
        } else if unit == "s" || unit.to_lowercase().starts_with("second") {
            duration.seconds += amount;
        } else {
            duration.milliseconds += amount;
        }
    }
    matched.then_some(duration)
}

fn duration_millis(value: &DurationValue) -> f64 {
    value.milliseconds
        + value.seconds * 1_000.0
        + value.minutes * 60_000.0
        + value.hours * 3_600_000.0
        + value.days * 86_400_000.0
        + value.weeks * 604_800_000.0
}

fn add_duration(
    value: &DateValue,
    duration: &DurationValue,
    direction: f64,
) -> Result<DateValue, String> {
    let invalid = || "numeric-domain\0Date arithmetic is out of range".to_string();
    if !duration_finite(duration) {
        return Err(invalid());
    }
    let mut date = value.timezone.local_datetime(value.millis);
    let months = ((duration.years * 12.0 + duration.months) * direction).round();
    if !months.is_finite() || months.abs() > u32::MAX as f64 {
        return Err(invalid());
    }
    if months > 0.0 {
        date = date
            .checked_add_months(Months::new(months as u32))
            .ok_or_else(invalid)?;
    } else if months < 0.0 {
        date = date
            .checked_sub_months(Months::new((-months) as u32))
            .ok_or_else(invalid)?;
    }
    let days = (duration.weeks * 7.0 + duration.days) * direction;
    if !days.is_finite() || days.abs() > i32::MAX as f64 {
        return Err(invalid());
    }
    date = date
        .checked_add_signed(chrono::Duration::try_days(days.trunc() as i64).ok_or_else(invalid)?)
        .ok_or_else(invalid)?;
    let elapsed = (days.fract() * 86_400_000.0
        + (duration.hours * 3_600_000.0
            + duration.minutes * 60_000.0
            + duration.seconds * 1_000.0
            + duration.milliseconds)
            * direction)
        .round();
    if !elapsed.is_finite() || elapsed < i64::MIN as f64 || elapsed >= i64::MAX as f64 {
        return Err(invalid());
    }
    let base = value.timezone.try_millis_from_local(date).ok_or_else(|| {
        "invalid-local-time\0Calendar arithmetic produced a nonunique local time".to_string()
    })?;
    let millis = base.checked_add(elapsed as i64).ok_or_else(invalid)?;
    if DateTime::<Utc>::from_timestamp_millis(millis).is_none() {
        return Err(invalid());
    }
    Ok(DateValue {
        millis,
        date_only: value.date_only && elapsed == 0.0,
        timezone: value.timezone.clone(),
    })
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
        RuntimeValue::String(value) => parse_duration(value),
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
        "tags" => RuntimeValue::List(
            file.tags
                .iter()
                .cloned()
                .map(RuntimeValue::String)
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
    destination.find('#').map(|index| destination[index..].to_owned())
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
fn string_split(value: &str, separator: &RuntimeValue, limit: Option<usize>) -> RuntimeValue {
    let requested = limit.unwrap_or(usize::MAX);
    let take = requested.min(100_001);
    let values: Result<Vec<String>, String> = match separator {
        RuntimeValue::Regex(pattern, flags) => compile_regex(pattern, flags)
            .map(|regex| regex.split(value).take(take).map(String::from).collect()),
        other if plain_string(other).is_empty() => Ok(value
            .chars()
            .take(take)
            .map(|character| character.to_string())
            .collect()),
        other => Ok(value
            .split(&plain_string(other))
            .take(take)
            .map(String::from)
            .collect()),
    };
    match values {
        Ok(values) if values.len() > 100_000 => {
            RuntimeValue::Error("budget\0Split result exceeds item budget".into())
        }
        Ok(values) => RuntimeValue::List(values.into_iter().map(RuntimeValue::String).collect()),
        Err(error) => RuntimeValue::Error(error),
    }
}
fn compare_sort_keys(left: &RuntimeValue, right: &RuntimeValue) -> std::cmp::Ordering {
    match (left, right) {
        (RuntimeValue::Number(left), RuntimeValue::Number(right)) => {
            left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal)
        }
        _ => plain_string(left).cmp(&plain_string(right)),
    }
}
fn unique_key(value: &RuntimeValue) -> String {
    match value {
        RuntimeValue::Date(date) => format!("date:{}:{}", date.millis, date.date_only),
        RuntimeValue::Link(link) => format!("link:{}", link.path),
        RuntimeValue::File(file) => format!("file:{}", file.path),
        _ => format!(
            "{}:{}",
            value_type(value),
            serde_json::to_string(&to_plain(value)).unwrap_or_default()
        ),
    }
}

/// Expressions run once per record, so each pattern is compiled once and reused.
fn compile_regex(pattern: &str, flags: &str) -> Result<Regex, String> {
    const MAX_ENTRIES: usize = 8; // <= 8 MiB compiled regex budget plus bounded pattern keys
    type Compiled = Result<Regex, String>;
    static CACHE: OnceLock<RwLock<HashMap<(String, String), Compiled>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    let key = (pattern.to_string(), flags.to_string());
    if let Some(compiled) = cache.read().ok().and_then(|cache| cache.get(&key).cloned()) {
        return compiled;
    }
    if flags.chars().any(|flag| !"gimsu".contains(flag))
        || flags.chars().collect::<HashSet<_>>().len() != flags.chars().count()
    {
        return Err("unsupported\0Unsupported regular expression flags".into());
    }
    let mut builder = RegexBuilder::new(pattern);
    builder.size_limit(1_048_576).dfa_size_limit(1_048_576);
    builder
        .case_insensitive(flags.contains('i'))
        .multi_line(flags.contains('m'))
        .dot_matches_new_line(flags.contains('s'));
    let compiled = builder
        .build()
        .map_err(|error| format!("unsupported\0Unsupported regular expression: {error}"));
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
) -> Result<String, String> {
    let regex = compile_regex(pattern, flags)?;
    Ok(if flags.contains('g') {
        regex.replace_all(value, replacement)
    } else {
        regex.replace(value, replacement)
    }
    .to_string())
}
fn regex_split(value: &str, pattern: &str, flags: &str) -> Result<Vec<String>, String> {
    Ok(compile_regex(pattern, flags)?
        .split(value)
        .map(String::from)
        .collect())
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
        Regex::new(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
            .expect("numeric prefix")
    });
    PREFIX
        .find(value.trim_start())
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
        RuntimeValue::String(value) => {
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
        RuntimeValue::List(values) => BaseValue::List {
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
            *bytes = bytes
                .saturating_add(value.path.len() + value.subpath.as_ref().map_or(0, String::len) + value.display.as_ref().map_or(0, String::len));
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
            | RuntimeValue::Html(value)
            | RuntimeValue::Image(value)
            | RuntimeValue::Icon(value)
            | RuntimeValue::Error(value) => bytes = bytes.saturating_add(value.len()),
            RuntimeValue::Link(link) => {
                bytes = bytes
                    .saturating_add(link.path.len() + link.subpath.as_ref().map_or(0, String::len) + link.display.as_ref().map_or(0, String::len));
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
                        32 + link.path.len() + link.subpath.as_ref().map_or(0, String::len) + link.display.as_ref().map_or(0, String::len),
                    );
                    if let Some(display) = link.display_value.as_deref() {
                        work.push(display);
                    }
                }
            }
            RuntimeValue::List(values) => work.extend(values),
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
                    .map(|(key, value)| (key, infer(value, timezone, depth + 1)))
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
            "icon('book').isType('icon')",
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
            "IF(true, 2, unknown()) == 2",
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
        assert_eq!(
            eval("max(null,2,4)").unwrap(),
            BaseValue::Number { value: 4.0 }
        );
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
