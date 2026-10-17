// Adapted from callumalpass/mdbase-rs, MIT, Copyright (c) 2025 Callum Alpass.
// Pinned origin and modifications: ../UPSTREAM.md; full notice: ../LICENSE-MDBASE.
use indexmap::IndexMap;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, OnceLock, RwLock};

use chrono::{
    DateTime, Datelike, FixedOffset, Months, NaiveDate, NaiveDateTime, TimeZone, Timelike, Utc,
};
use chrono_tz::Tz;
use regex::{Regex, RegexBuilder};
use serde_json::{Map, Value};

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

#[derive(Clone, Debug, Default)]
pub(crate) struct BasesEvaluationContext {
    pub note: IndexMap<String, RuntimeValue>,
    pub file: BasesFile,
    pub this_file: Option<BasesFile>,
    pub files: Arc<super::files::BasesFiles>,
    pub formulas: Arc<IndexMap<String, String>>,
    pub property_types: Arc<BTreeMap<String, String>>,
    pub link_resolutions: Arc<BTreeMap<String, Option<String>>>,
    pub now: Option<String>,
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
    pub path: String,
    pub display: Option<String>,
    pub resolved_path: Option<Option<String>>,
    pub external: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct DateValue {
    pub(crate) millis: i64,
    pub(crate) date_only: bool,
    timezone: BasesTimezone,
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

    fn millis_from_local(&self, value: NaiveDateTime) -> i64 {
        match self {
            Self::Utc => value.and_utc().timestamp_millis(),
            Self::Fixed(offset) => offset
                .from_local_datetime(&value)
                .single()
                .expect("fixed offsets are unambiguous")
                .timestamp_millis(),
            Self::Named(timezone) => timezone
                .from_local_datetime(&value)
                .earliest()
                .unwrap_or_else(|| timezone.from_utc_datetime(&value))
                .timestamp_millis(),
        }
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
impl<'a> Session<'a> {
    pub(crate) fn new(context: &'a BasesEvaluationContext) -> Self {
        Self {
            evaluator: Evaluator::new(context),
            initial_steps: context.work_limit.unwrap_or(100_000),
        }
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
        Member::Named(name) => expected.contains(&name.as_str()),
        Member::Computed(value) => {
            constant_member_name(value).is_none_or(|name| expected.contains(&name.as_str()))
        }
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
            let ctime_member = matches!(object.as_ref(), Expr::Identifier(namespace) if namespace == "file")
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
                ],
            );
            relationship_member
                || expression_uses_relationships(object)
                || matches!(member, Member::Computed(value) if expression_uses_relationships(value))
        }
        Expr::Call(callee, arguments) => {
            let relationship_call = match callee.as_ref() {
                Expr::Identifier(name) => name == "file",
                Expr::Member(_, Member::Named(name)) => {
                    matches!(name.as_str(), "hasLink" | "asFile" | "asLink")
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
    context: &'a BasesEvaluationContext,
    now: DateValue,
    timezone: BasesTimezone,
    formula_cache: HashMap<String, RuntimeValue>,
    formula_stack: HashSet<String>,
    remaining_work: usize,
}

pub(crate) const BASES_WORK_BUDGET_EXCEEDED: &str = "Obsidian Base expression work budget exceeded";
pub(crate) const BASES_OPERATION_CANCELLED: &str = "Obsidian Base expression evaluation cancelled";

type Scope = BTreeMap<String, RuntimeValue>;

impl<'a> Evaluator<'a> {
    fn new(context: &'a BasesEvaluationContext) -> Self {
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
        match name.to_lowercase().as_str() {
            "note" => RuntimeValue::Object(
                self.context
                    .note
                    .iter()
                    .map(|(key, value)| (key.clone(), self.note_property(key, value)))
                    .collect(),
            ),
            "file" => RuntimeValue::File(Box::new(self.context.file.clone())),
            "this" => self
                .context
                .this_file
                .as_ref()
                .map(|file| {
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
            if namespace.eq_ignore_ascii_case("formula") {
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
            Expr::Identifier(name) if name == "if" => {
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

    fn charge(&mut self, work: usize) -> Result<(), ()> {
        if self
            .context
            .cancellation
            .as_ref()
            .is_some_and(|cancellation| cancellation.stop_reason().is_some())
        {
            return Err(());
        }
        self.remaining_work = self.remaining_work.checked_sub(work).ok_or(())?;
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

    fn global(&self, name: &str, arguments: &[RuntimeValue]) -> RuntimeValue {
        let first = arguments.first().cloned().unwrap_or(RuntimeValue::Null);
        match name {
            "random" | "file" | "link" | "html" | "image" | "icon" => RuntimeValue::Error(format!(
                "unknown-function\0Unsupported host function {name}"
            )),
            "escapeHTML" => RuntimeValue::String(escape_html(&plain_string(&first))),
            "date" => parse_date(&plain_string(&first), &self.timezone)
                .map(RuntimeValue::Date)
                .unwrap_or(RuntimeValue::Null),
            "duration" => parse_duration(&plain_string(&first))
                .map(RuntimeValue::Duration)
                .unwrap_or_else(|| RuntimeValue::Error("Invalid duration".to_string())),
            "file" => match first {
                RuntimeValue::File(file) => RuntimeValue::File(file),
                RuntimeValue::Link(link) => self.file_from_link(&link),
                value => self.file_from_target(&plain_string(&value)),
            },
            "html" => RuntimeValue::Html(plain_string(&first)),
            "image" => RuntimeValue::Image(match first {
                RuntimeValue::File(file) => file.path,
                RuntimeValue::Link(link) => link.path,
                value => plain_string(&value),
            }),
            "icon" => RuntimeValue::Icon(plain_string(&first)),
            "link" => RuntimeValue::Link(
                self.make_link(&plain_string(&first), arguments.get(1).map(plain_string)),
            ),
            "list" => match first {
                RuntimeValue::List(_) | RuntimeValue::Null => first,
                value => RuntimeValue::List(vec![value]),
            },
            "max" | "min" => {
                let numbers = arguments
                    .iter()
                    .map(|value| self.number(value))
                    .collect::<Result<Vec<_>, _>>();
                match numbers {
                    Ok(values) => RuntimeValue::Number(
                        values
                            .into_iter()
                            .reduce(if name == "max" { f64::max } else { f64::min })
                            .unwrap_or(if name == "max" {
                                f64::NEG_INFINITY
                            } else {
                                f64::INFINITY
                            }),
                    ),
                    Err(error) => RuntimeValue::Error(error),
                }
            }
            "now" => RuntimeValue::Date(self.now.clone()),
            "number" => match first {
                RuntimeValue::String(value) => parse_number_prefix(&value)
                    .map(RuntimeValue::Number)
                    .unwrap_or_else(|| RuntimeValue::Error("type\0Invalid number".into())),
                RuntimeValue::Bool(value) => RuntimeValue::Number(if value { 1.0 } else { 0.0 }),
                RuntimeValue::Number(value) => RuntimeValue::Number(value),
                RuntimeValue::Null => RuntimeValue::Null,
                _ => RuntimeValue::Error("type\0Cannot convert value to number".into()),
            },
            "today" => RuntimeValue::Date(start_of_day(&self.now)),
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
        if let RuntimeValue::Error(_) = receiver {
            return receiver;
        }
        let work = match &receiver {
            RuntimeValue::List(values) => values.len(),
            RuntimeValue::Object(values) => values.len(),
            RuntimeValue::String(value) => value.len() / 256,
            _ => 0,
        };
        if self.charge(work).is_err() {
            return RuntimeValue::Error("budget\0Builtin traversal exceeds work budget".into());
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
            return RuntimeValue::Bool(value_type(&receiver).eq_ignore_ascii_case(&expected));
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
                RuntimeValue::Number((value * factor).round() / factor)
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
        &self,
        value: &DateValue,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        match name {
            "date" => RuntimeValue::Date(start_of_day(value)),
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
                        .filter(|value| seen.insert(unique_key(value)))
                        .cloned()
                        .collect(),
                )
            }
            "sum" => values
                .iter()
                .map(|value| self.number(value))
                .sum::<Result<f64, _>>()
                .map(RuntimeValue::Number)
                .unwrap_or_else(RuntimeValue::Error),
            "mean" => {
                if values.is_empty() {
                    RuntimeValue::Null
                } else {
                    values
                        .iter()
                        .map(|value| self.number(value))
                        .sum::<Result<f64, _>>()
                        .map(|sum| RuntimeValue::Number(sum / values.len() as f64))
                        .unwrap_or_else(RuntimeValue::Error)
                }
            }
            _ => method_not_found("List", name),
        }
    }

    fn file_method(
        &self,
        file: &BasesFile,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        match name {
            "hasLink" | "asLink" => {
                RuntimeValue::Error("unsupported\0Relationship metadata not supplied".into())
            }
            "asLink" => RuntimeValue::Link(BasesLink {
                path: file.path.clone(),
                display: arguments.first().map(plain_string),
                resolved_path: Some(Some(file.path.clone())),
                external: false,
            }),
            "hasLink" => RuntimeValue::Bool(file.links.iter().any(|link| {
                arguments
                    .first()
                    .is_some_and(|target| self.link_matches(link, target))
            })),
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
        &self,
        link: &BasesLink,
        name: &str,
        arguments: &[RuntimeValue],
    ) -> RuntimeValue {
        match name {
            "asFile" => self.file_from_link(link),
            "linksTo" => match self.file_from_link(link) {
                RuntimeValue::File(file) => self.file_method(&file, "hasLink", arguments),
                _ => RuntimeValue::Error("Could not coerce link to file".to_string()),
            },
            // Obsidian applies string functions to a link's path, e.g. `link.replace(...)`.
            _ => self.string_method(&link.path, name, arguments),
        }
    }

    fn property(&self, object: RuntimeValue, property: &str) -> RuntimeValue {
        match object {
            RuntimeValue::Null => RuntimeValue::Null,
            RuntimeValue::String(value) if property == "length" => {
                RuntimeValue::Number(value.chars().count() as f64)
            }
            RuntimeValue::List(values) if property == "length" => {
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
            RuntimeValue::Date(value) => date_property(&value, property),
            RuntimeValue::File(value) => {
                if ["links", "embeds", "backlinks"].contains(&property.to_lowercase().as_str()) {
                    RuntimeValue::Error("unsupported\0Relationship metadata not supplied".into())
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
                if left.date_only || right.date_only {
                    left.timezone.local_datetime(left.millis).date()
                        == right.timezone.local_datetime(right.millis).date()
                } else {
                    left.millis == right.millis
                }
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

    fn make_link(&self, target: &str, display: Option<String>) -> BasesLink {
        let (target, parsed_display) = parse_link_text(target);
        BasesLink {
            resolved_path: Some(self.resolve_link(&target)),
            external: is_external(&target),
            path: target,
            display: display.or(parsed_display),
        }
    }

    fn resolve_link(&self, target: &str) -> Option<String> {
        for candidate in link_resolution_keys(target) {
            if let Some(value) = self.context.link_resolutions.get(&candidate) {
                return value.clone();
            }
            if let Some(value) = self.context.link_resolutions.get(&candidate.to_lowercase()) {
                return value.clone();
            }
        }
        self.find_file(target).map(|file| file.path.clone())
    }

    fn find_file(&self, target: &str) -> Option<&BasesFile> {
        self.context.files.find(target)
    }

    fn file_from_target(&self, target: &str) -> RuntimeValue {
        let resolved = self.resolve_link(target);
        match resolved {
            None => RuntimeValue::Null,
            Some(path) => self
                .context
                .files
                .by_path(&path)
                .cloned()
                .map(|file| RuntimeValue::File(Box::new(file)))
                .unwrap_or_else(|| RuntimeValue::File(Box::new(file_defaults(&path)))),
        }
    }

    fn file_from_link(&self, link: &BasesLink) -> RuntimeValue {
        match link
            .resolved_path
            .clone()
            .flatten()
            .or_else(|| self.resolve_link(&link.path))
        {
            None => RuntimeValue::Null,
            Some(path) => self
                .context
                .files
                .by_path(&path)
                .cloned()
                .map(|file| RuntimeValue::File(Box::new(file)))
                .unwrap_or_else(|| RuntimeValue::File(Box::new(file_defaults(&path)))),
        }
    }

    fn link_resolved(&self, link: &BasesLink) -> Option<String> {
        link.resolved_path
            .clone()
            .flatten()
            .or_else(|| self.resolve_link(&link.path))
            .or_else(|| Some(strip_subpath(&link.path)))
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
    Some(BasesLink {
        path: link.get("path")?.as_str()?.to_string(),
        display: link.get("display").map(runtime_display_string),
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
            .join(","),
        RuntimeValue::Object(_) => serde_json::to_string(&to_plain(value)).unwrap_or_default(),
        RuntimeValue::File(value) => value.path.clone(),
        RuntimeValue::Link(value) if value.external => value.path.clone(),
        RuntimeValue::Link(value) => value
            .display
            .as_ref()
            .map(|display| format!("[[{}|{display}]]", value.path))
            .unwrap_or_else(|| format!("[[{}]]", value.path)),
        RuntimeValue::Regex(pattern, flags) => format!("/{pattern}/{flags}"),
        RuntimeValue::Image(value) => format!("![]({value})"),
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
        RuntimeValue::String(value) => !value.is_empty(),
        RuntimeValue::List(value) => !value.is_empty(),
        RuntimeValue::Object(value) => !value.is_empty(),
        _ => true,
    }
}

fn is_empty(value: &RuntimeValue) -> bool {
    match value {
        RuntimeValue::Null => true,
        RuntimeValue::String(value) => value.is_empty(),
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
    let seconds = sign * (hours.parse::<i32>().ok()? * 3_600 + minutes.parse::<i32>().ok()? * 60);
    FixedOffset::east_opt(seconds)
}

fn parse_date(value: &str, timezone: &BasesTimezone) -> Option<DateValue> {
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
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

fn start_of_day(value: &DateValue) -> DateValue {
    let date = value.timezone.local_datetime(value.millis).date();
    let local = date.and_hms_opt(0, 0, 0).expect("valid midnight");
    DateValue {
        millis: value.timezone.millis_from_local(local),
        date_only: true,
        timezone: value.timezone.clone(),
    }
}

fn format_date(value: &DateValue, pattern: &str) -> String {
    try_format_date(value, pattern).unwrap_or_default()
}
fn try_format_date(value: &DateValue, pattern: &str) -> Result<String, String> {
    if pattern.len() > 65_536 {
        return Err("budget\0Date format exceeds byte budget".into());
    }
    let date = value.timezone.local_datetime(value.millis);
    let mut format = pattern.to_string();
    static LITERALS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\[([^]]*)\]").expect("literal expression"));
    let literals = &*LITERALS;
    let mut stored = Vec::new();
    format = literals
        .replace_all(&format, |captures: &regex::Captures<'_>| {
            stored.push(captures[1].to_string());
            format!("__L{}__", stored.len() - 1)
        })
        .to_string();
    for (source, target) in [
        ("YYYY", "%Y"),
        ("yyyy", "%Y"),
        ("WW", "%V"),
        ("MM", "%m"),
        ("DD", "%d"),
        ("dd", "%d"),
        ("HH", "%H"),
        ("mm", "%M"),
        ("ss", "%S"),
    ] {
        format = format.replace(source, target);
    }
    if chrono::format::StrftimeItems::new(&format)
        .any(|item| matches!(item, chrono::format::Item::Error))
    {
        return Err("unsupported\0Invalid date format".into());
    }
    let mut output = String::new();
    std::fmt::write(&mut output, format_args!("{}", date.format(&format)))
        .map_err(|_| "unsupported\0Date format requires unavailable fields".to_string())?;
    for (index, literal) in stored.iter().enumerate() {
        output = output.replace(&format!("__L{index}__"), literal);
    }
    Ok(output)
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
    static EXTERNAL: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*:").expect("external link expression")
    });
    EXTERNAL.is_match(value)
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
        RuntimeValue::Link(_) => stringify(value),
        _ => serde_json::to_string(&to_plain(value)).unwrap_or_default(),
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
fn typed_result(value: RuntimeValue) -> Result<BaseValue, ExpressionDiagnostic> {
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
        RuntimeValue::File(value) => BaseValue::File { path: value.path },
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
