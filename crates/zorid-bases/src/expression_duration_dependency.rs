//! Bounded abstract interpretation for implicit calendar reads. An unresolved
//! formula/property/callback remains a union, never a proof that it is scalar.
use super::{canonical_function_name, parse_duration, Expr, Member};
use serde_json::Value;

const DURATION: u8 = 1;
const DURATION_TEXT: u8 = 2;
const TEXT: u8 = 4;
const NUMBER: u8 = 8;
const DATE: u8 = 16;
const LIST: u8 = 32;
const OTHER: u8 = 64;
const UNKNOWN: u8 = 127;
#[derive(Clone, Copy)]
struct Shape {
    kind: u8,
    items: u8,
}
impl Shape {
    fn scalar(kind: u8) -> Self {
        Self { kind, items: 0 }
    }
    fn unknown() -> Self {
        Self {
            kind: UNKNOWN,
            items: UNKNOWN,
        }
    }
    fn list(items: u8) -> Self {
        Self { kind: LIST, items }
    }
    fn union(self, other: Self) -> Self {
        Self {
            kind: self.kind | other.kind,
            items: self.items | other.items,
        }
    }
    fn comparable(self) -> u8 {
        self.kind | if self.kind & LIST != 0 { self.items } else { 0 }
    }
}
#[derive(Clone, Copy)]
struct Fact {
    shape: Shape,
    clock: bool,
}
impl Fact {
    fn pure(shape: Shape) -> Self {
        Self {
            shape,
            clock: false,
        }
    }
}
#[derive(Clone, Copy)]
struct Locals {
    value: Shape,
    acc: Shape,
}
impl Default for Locals {
    fn default() -> Self {
        Self {
            value: Shape::unknown(),
            acc: Shape::unknown(),
        }
    }
}

pub(super) fn is_unit(name: &str) -> bool {
    matches!(
        name,
        "years" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds" | "milliseconds"
    )
}
fn equality_reads(left: Shape, right: Shape) -> bool {
    let (a, b) = (left.comparable(), right.comparable());
    a & DURATION != 0 && b & (DURATION | DURATION_TEXT) != 0
        || b & DURATION != 0 && a & (DURATION | DURATION_TEXT) != 0
}
pub(super) fn reads_clock(
    expr: &Expr,
    check: &mut impl FnMut(usize) -> Option<()>,
) -> Option<bool> {
    walk(expr, Locals::default(), check).map(|fact| fact.clock)
}
fn walk(expr: &Expr, locals: Locals, check: &mut impl FnMut(usize) -> Option<()>) -> Option<Fact> {
    check(1)?;
    let fact = match expr {
        Expr::Literal(Value::String(text)) => {
            check(1 + text.len() / 64)?;
            Fact::pure(Shape::scalar(if parse_duration(text).is_some() {
                DURATION_TEXT
            } else {
                TEXT
            }))
        }
        Expr::Literal(Value::Number(_)) => Fact::pure(Shape::scalar(NUMBER)),
        Expr::Literal(_) | Expr::Regex(_, _) => Fact::pure(Shape::scalar(OTHER)),
        Expr::Identifier(name) => Fact::pure(match name.as_str() {
            "value" => locals.value,
            "acc" => locals.acc,
            "index" => Shape::scalar(NUMBER),
            "note" | "formula" | "this" | "file" => Shape::scalar(OTHER),
            _ => Shape::unknown(),
        }),
        Expr::Array(values) => {
            let mut fact = Fact::pure(Shape::list(0));
            for value in values {
                let value = walk(value, locals, check)?;
                fact.clock |= value.clock;
                fact.shape.items |= value.shape.comparable();
            }
            fact
        }
        Expr::Unary(operator, child) => {
            let child = walk(child, locals, check)?;
            Fact {
                shape: Shape::scalar(if operator == "!" { OTHER } else { NUMBER }),
                clock: child.clock || operator == "+" && child.shape.kind & DURATION != 0,
            }
        }
        Expr::Binary(operator, left, right) => {
            let (a, b) = (walk(left, locals, check)?, walk(right, locals, check)?);
            let mut clock = a.clock || b.clock;
            let shape = match operator.as_str() {
                "==" | "!=" => {
                    clock |= equality_reads(a.shape, b.shape);
                    Shape::scalar(OTHER)
                }
                "<" | ">" | "<=" | ">=" => {
                    clock |= (a.shape.kind | b.shape.kind) & DURATION != 0;
                    Shape::scalar(OTHER)
                }
                "&&" | "||" => Shape::scalar(OTHER),
                "+" | "-" => {
                    let mut kind = NUMBER;
                    if a.shape.kind & DURATION != 0 && b.shape.kind & DURATION != 0
                        || operator == "-" && a.shape.kind & DATE != 0 && b.shape.kind & DATE != 0
                    {
                        kind |= DURATION;
                    }
                    if a.shape.kind & DATE != 0 {
                        kind |= DATE;
                    }
                    if operator == "+"
                        && (a.shape.kind | b.shape.kind) & (TEXT | DURATION_TEXT) != 0
                    {
                        kind |= TEXT | DURATION_TEXT;
                    }
                    Shape {
                        kind,
                        items: if (a.shape.kind | b.shape.kind) & LIST != 0 {
                            a.shape.items | b.shape.items
                        } else {
                            0
                        },
                    }
                    .union(Shape::scalar(
                        if operator == "+" && a.shape.kind & b.shape.kind & LIST != 0 {
                            LIST
                        } else {
                            0
                        },
                    ))
                }
                "*" | "/" => Shape::scalar(
                    NUMBER
                        | if a.shape.kind & DURATION != 0 {
                            DURATION
                        } else {
                            0
                        },
                ),
                _ => Shape::scalar(NUMBER),
            };
            Fact { shape, clock }
        }
        Expr::Member(object, member) => {
            let value = walk(object, locals, check)?;
            let (name, key_clock) = match member {
                Member::Named(name) => (Some(name.as_str()), false),
                Member::Computed(key) => {
                    let key_fact = walk(key, locals, check)?;
                    (
                        if let Expr::Literal(Value::String(name)) = key.as_ref() {
                            Some(name.as_str())
                        } else {
                            None
                        },
                        key_fact.clock,
                    )
                }
            };
            let duration_field = name.map_or(true, |name| is_unit(&name.to_ascii_lowercase()));
            let clock =
                value.clock || key_clock || duration_field && value.shape.kind & DURATION != 0;
            let shape = if name.is_some_and(|name| name.eq_ignore_ascii_case("length"))
                && value.shape.kind & !(TEXT | DURATION_TEXT | LIST) == 0
            {
                Shape::scalar(NUMBER)
            } else if value.shape.kind == LIST {
                Shape {
                    kind: value.shape.items,
                    items: if value.shape.items & LIST != 0 {
                        value.shape.items
                    } else {
                        0
                    },
                }
            } else if value.shape.kind == DURATION && duration_field {
                Shape::scalar(NUMBER)
            } else if matches!(object.as_ref(),Expr::Identifier(namespace) if namespace.eq_ignore_ascii_case("file"))
                && name.is_some_and(|name| {
                    matches!(
                        name,
                        "name" | "path" | "ext" | "basename" | "folder" | "size"
                    )
                })
            {
                Shape::scalar(if name == Some("size") {
                    NUMBER
                } else {
                    TEXT | DURATION_TEXT
                })
            } else {
                Shape::unknown()
            };
            Fact { shape, clock }
        }
        Expr::Call(callee, args) => {
            // Callback locals are inferred from the receiver when possible.
            // Reduce's accumulator is a fixed-point union; UNKNOWN is sound
            // for recurrence and heterogeneous callback branches without loops.
            if let Expr::Member(receiver, Member::Named(method)) = callee.as_ref() {
                let receiver = walk(receiver, locals, check)?;
                let method = canonical_function_name(method);
                let mut nested = locals;
                if matches!(method, "map" | "filter" | "reduce") {
                    nested.value = if receiver.shape.kind == LIST {
                        Shape {
                            kind: receiver.shape.items,
                            items: if receiver.shape.items & LIST != 0 {
                                receiver.shape.items
                            } else {
                                0
                            },
                        }
                    } else {
                        Shape::unknown()
                    };
                    if method == "reduce" {
                        nested.acc = Shape::unknown();
                    }
                }
                let mut arguments = Vec::with_capacity(args.len());
                let mut clock = receiver.clock;
                if method == "reduce" {
                    let initial = if let Some(initial) = args.get(1) {
                        walk(initial, locals, check)?
                    } else {
                        Fact::pure(Shape::scalar(OTHER))
                    };
                    clock |= initial.clock;
                    nested.acc = initial.shape;
                    // The finite bit lattice reaches a fixed point in at most
                    // fourteen bit additions (kind and nested-item domains).
                    for _ in 0..=14 {
                        check(1)?;
                        let output = if let Some(callback) = args.first() {
                            walk(callback, nested, check)?
                        } else {
                            Fact::pure(Shape::scalar(OTHER))
                        };
                        clock |= output.clock;
                        let next = nested.acc.union(output.shape);
                        if next.kind == nested.acc.kind && next.items == nested.acc.items {
                            return Some(Fact { shape: next, clock });
                        }
                        nested.acc = next;
                    }
                    return None;
                }
                for (index, arg) in args.iter().enumerate() {
                    let value = walk(arg, if index == 0 { nested } else { locals }, check)?;
                    clock |= value.clock;
                    arguments.push(value.shape);
                }
                let first = arguments.first().copied().unwrap_or(Shape::scalar(OTHER));
                if matches!(method, "repeat" | "slice" | "round" | "toFixed") {
                    clock |= arguments.iter().any(|value| value.kind & DURATION != 0);
                } else if method == "split" {
                    clock |= arguments
                        .get(1)
                        .is_some_and(|value| value.kind & DURATION != 0);
                }
                let shape = match method {
                    "map" => Shape::list(first.comparable()),
                    "filter" | "reverse" | "slice" | "sort" | "unique" => receiver.shape,
                    "flat" => Shape::list(receiver.shape.items),
                    "reduce" => Shape::unknown(),
                    "contains" | "containsAll" | "containsAny" => {
                        if receiver.shape.kind & LIST != 0 {
                            clock |= arguments.iter().any(|argument| {
                                equality_reads(
                                    Shape {
                                        kind: receiver.shape.items,
                                        items: UNKNOWN,
                                    },
                                    *argument,
                                )
                            });
                        }
                        Shape::scalar(OTHER)
                    }
                    "isTruthy" | "isEmpty" | "isType" | "hasLink" | "linksTo" | "hasProperty"
                    | "hasTag" | "inFolder" | "startsWith" | "endsWith" | "matches" => {
                        Shape::scalar(OTHER)
                    }
                    "sum" | "mean" | "min" | "max" | "median" | "stddev" | "abs" | "ceil"
                    | "floor" | "round" => Shape::scalar(NUMBER),
                    "date" | "earliest" | "latest" => Shape::scalar(DATE),
                    "keys" | "values" => Shape::list(UNKNOWN),
                    "split" => Shape::list(TEXT | DURATION_TEXT),
                    "lower" | "replace" | "repeat" | "title" | "trim" | "join" | "toFixed"
                    | "format" | "time" | "toString" => Shape::scalar(TEXT | DURATION_TEXT),
                    // Existing scheduling walk handles relative/unknown calls.
                    _ => Shape::unknown(),
                };
                Fact { shape, clock }
            } else {
                let mut arguments = Vec::with_capacity(args.len());
                let mut clock = false;
                for arg in args {
                    let fact = walk(arg, locals, check)?;
                    clock |= fact.clock;
                    arguments.push(fact.shape);
                }
                let shape = if let Expr::Identifier(name) = callee.as_ref() {
                    match canonical_function_name(name) {
                        "duration" => Shape::scalar(DURATION),
                        "date" | "now" | "today" => Shape::scalar(DATE),
                        "if" => arguments
                            .get(1)
                            .copied()
                            .unwrap_or(Shape::scalar(OTHER))
                            .union(arguments.get(2).copied().unwrap_or(Shape::scalar(OTHER))),
                        "list" => {
                            let first = arguments.first().copied().unwrap_or(Shape::scalar(OTHER));
                            if first.kind == LIST {
                                first
                            } else {
                                Shape::list(first.comparable())
                            }
                        }
                        "max" | "min" | "number" | "random" => Shape::scalar(NUMBER),
                        "escapeHTML" | "html" | "image" | "icon" => Shape::scalar(TEXT),
                        "link" | "file" => Shape::scalar(OTHER),
                        _ => Shape::unknown(),
                    }
                } else {
                    clock |= walk(callee, locals, check)?.clock;
                    Shape::unknown()
                };
                Fact { shape, clock }
            }
        }
    };
    Some(fact)
}
