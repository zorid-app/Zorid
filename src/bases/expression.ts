/** Original, inert Bases expression foundation. See docs/bases-query-reference.md. */
export type BaseExpressionErrorCode = 'parse' | 'type' | 'access' | 'unknown-function' | 'unsupported' | 'cycle' | 'budget';
export class BaseExpressionError extends Error {
  readonly code: BaseExpressionErrorCode;
  readonly offset?: number;
  constructor(code: BaseExpressionErrorCode, message: string, offset?: number) {
    super(message); this.name = 'BaseExpressionError'; this.code = code; this.offset = offset;
  }
}
export interface BaseDateValue {
  readonly type: 'date'; readonly timestamp: number; readonly hasTime: boolean;
  /** Calendar display for shared date-only values; absent on legacy local dates.
   * This metadata never changes the instant or evaluator arithmetic. */
  readonly presentationTimezone?: string;
}
export interface BaseDurationValue {
  readonly type: 'duration'; readonly years: number; readonly months: number; readonly days: number;
  readonly hours: number; readonly minutes: number; readonly seconds: number; readonly milliseconds: number;
}
export type BaseExpressionValue =
  | { readonly type: 'null' }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'list'; readonly value: readonly BaseExpressionValue[] }
  | { readonly type: 'object'; readonly value: Readonly<Record<string, BaseExpressionValue>> }
  | { readonly type: 'regexp'; readonly value: RegExp }
  | BaseDateValue | BaseDurationValue
  | { readonly type: 'error'; readonly error: BaseExpressionError }
  | BaseNamespaceValue;
export interface BaseNamespaceValue {
  readonly type: 'namespace'; readonly name: string;
  readonly get: (name: string, runtime: BaseExpressionRuntime) => BaseExpressionValue | undefined;
}
export type BaseValueType = BaseExpressionValue['type'];
export const BASE_NULL: BaseExpressionValue & { type: 'null' } = Object.freeze({ type: 'null' });
const bool = (value: boolean): BaseExpressionValue => ({ type: 'boolean', value });
const num = (value: number): BaseExpressionValue => ({ type: 'number', value });
const str = (value: string): BaseExpressionValue => ({ type: 'string', value });
const list = (value: readonly BaseExpressionValue[]): BaseExpressionValue => ({ type: 'list', value });
const fail = (code: BaseExpressionErrorCode, message: string): never => { throw new BaseExpressionError(code, message); };
function asError(error: unknown): BaseExpressionError {
  return error instanceof BaseExpressionError ? error : new BaseExpressionError('unsupported', error instanceof Error ? error.message : String(error));
}

/** Convert plain input data, never inheriting object members or invoking getters. */
export function baseExpressionValue(input: unknown, ancestors = new Set<object>()): BaseExpressionValue {
  if (input === null || input === undefined) return BASE_NULL;
  if (typeof input === 'boolean') return bool(input);
  if (typeof input === 'number') return num(input);
  if (typeof input === 'string') return str(input);
  if (input instanceof Date) return baseDate(input, true);
  if (!input || typeof input !== 'object') return fail('unsupported', 'Unsupported expression input');
  if (ancestors.has(input)) return fail('cycle', 'Cyclic expression input');
  if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
    return fail('unsupported', 'Expression objects must be plain mappings');
  }
  ancestors.add(input);
  try {
    const entries = Object.keys(input).map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (!('value' in descriptor)) return fail('unsupported', 'Expression inputs cannot contain accessors');
      return [key, baseExpressionValue(descriptor.value, ancestors)] as const;
    });
    if (Array.isArray(input)) {
      const values = new Map(entries);
      return list(Array.from({ length: input.length }, (_, index) => values.get(String(index)) ?? BASE_NULL));
    }
    return { type: 'object', value: Object.fromEntries(entries) };
  } finally { ancestors.delete(input); }
}
export function baseDate(date: Date | number, hasTime = true): BaseDateValue {
  const timestamp = typeof date === 'number' ? date : date.getTime();
  if (!Number.isFinite(timestamp)) return fail('type', 'Invalid date');
  return { type: 'date', timestamp, hasTime };
}
export function baseDuration(parts: Partial<Omit<BaseDurationValue, 'type'>>): BaseDurationValue {
  return { type: 'duration', years: 0, months: 0, days: 0, hours: 0, minutes: 0, seconds: 0, milliseconds: 0, ...parts };
}
function ownKey(value: Readonly<Record<string, unknown>>, name: string): string | undefined {
  if (Object.hasOwn(value, name)) return name;
  const lower = name.toLowerCase();
  return Object.keys(value).find(key => key.toLowerCase() === lower);
}
export function baseValueIsTruthy(value: BaseExpressionValue): boolean {
  switch (value.type) {
    case 'null': case 'error': return false;
    case 'boolean': case 'number': case 'string': return !!value.value;
    case 'list': return value.value.length > 0;
    case 'object': return Object.keys(value.value).length > 0;
    case 'duration': return durationKeys.some(key => value[key] !== 0);
    default: return true;
  }
}
function dateString(value: BaseDateValue): string {
  const date = new Date(value.timestamp), pad = (n: number) => String(n).padStart(2, '0');
  if (!value.hasTime && value.presentationTimezone) {
    const zone = value.presentationTimezone;
    const offset = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
    if (zone === 'UTC' || offset) {
      const minutes = offset ? (Number(offset[2]) * 60 + Number(offset[3])) * (offset[1] === '-' ? -1 : 1) : 0;
      const display = new Date(value.timestamp + minutes * 60000);
      return `${String(display.getUTCFullYear()).padStart(4, '0')}-${pad(display.getUTCMonth() + 1)}-${pad(display.getUTCDate())}`;
    }
    const parts = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const part = (name: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === name)!.value;
    return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  }
  const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return value.hasTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : day;
}
export function baseValueToString(value: BaseExpressionValue): string {
  switch (value.type) {
    case 'null': return 'null';
    case 'error': return `Error: ${value.error.message}`;
    case 'boolean': case 'number': return String(value.value);
    case 'string': return value.value;
    case 'regexp': return value.value.toString();
    case 'list': return value.value.map(baseValueToString).join(', ');
    case 'object': return JSON.stringify(Object.fromEntries(Object.entries(value.value).map(([key, item]) => [key, baseValueToString(item)])));
    case 'date': return dateString(value);
    default: return fail('unsupported', `Text conversion for ${value.type} requires a host implementation`);
  }
}
const durationKeys = ['years', 'months', 'days', 'hours', 'minutes', 'seconds', 'milliseconds'] as const;
function dateOnly(value: BaseDateValue): number {
  const date = new Date(value.timestamp); date.setHours(0, 0, 0, 0); return date.getTime();
}
function addDuration(value: BaseDateValue, duration: BaseDurationValue, direction = 1): BaseDateValue {
  const date = new Date(value.timestamp);
  if (duration.years) date.setFullYear(date.getFullYear() + direction * duration.years);
  if (duration.months) date.setMonth(date.getMonth() + direction * duration.months);
  if (duration.days) date.setDate(date.getDate() + direction * duration.days);
  if (duration.hours) date.setHours(date.getHours() + direction * duration.hours);
  if (duration.minutes) date.setMinutes(date.getMinutes() + direction * duration.minutes);
  if (duration.seconds) date.setSeconds(date.getSeconds() + direction * duration.seconds);
  if (duration.milliseconds) date.setMilliseconds(date.getMilliseconds() + direction * duration.milliseconds);
  return baseDate(date, value.hasTime || !!(duration.hours || duration.minutes || duration.seconds || duration.milliseconds));
}
function durationMilliseconds(value: BaseDurationValue, now: Date): number {
  return addDuration(baseDate(now), value).timestamp - now.getTime();
}
function parseDate(value: string): BaseExpressionValue {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return baseDate(new Date(`${value}T00:00:00`), false);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/.test(value)) return baseDate(new Date(value));
  return BASE_NULL;
}
function parseDuration(value: string): BaseExpressionValue {
  if (value.startsWith('P')) return fail('unsupported', 'ISO duration syntax is not implemented');
  const match = /^(-?\d+) ?([A-Za-z]+)$/.exec(value);
  if (!match) return BASE_NULL;
  const units: Record<string, typeof durationKeys[number] | 'weeks'> = {
    y: 'years', year: 'years', years: 'years', M: 'months', month: 'months', months: 'months',
    w: 'weeks', week: 'weeks', weeks: 'weeks', d: 'days', day: 'days', days: 'days',
    h: 'hours', hour: 'hours', hours: 'hours', m: 'minutes', minute: 'minutes', minutes: 'minutes',
    s: 'seconds', second: 'seconds', seconds: 'seconds',
  };
  const unit = Object.hasOwn(units, match[2]) ? units[match[2]] : undefined;
  if (!unit) return BASE_NULL;
  return baseDuration(unit === 'weeks' ? { days: Number(match[1]) * 7 } : { [unit]: Number(match[1]) });
}
export function baseValuesEqual(left: BaseExpressionValue, right: BaseExpressionValue, loose = false, now = new Date()): boolean {
  if (left === right) return true;
  if (left.type === right.type) {
    switch (left.type) {
      case 'null': return true;
      case 'boolean': case 'number': case 'string': return left.value === (right as typeof left).value;
      case 'error': return left.error.message === (right as typeof left).error.message;
      case 'list': {
        const values = (right as typeof left).value;
        return left.value.length === values.length && left.value.every((value, index) => baseValuesEqual(value, values[index], loose, now));
      }
      case 'object': {
        const values = (right as typeof left).value, keys = Object.keys(left.value);
        return keys.length === Object.keys(values).length && keys.every(key => Object.hasOwn(values, key) && baseValuesEqual(left.value[key], values[key], false, now));
      }
      case 'date': {
        const other = right as BaseDateValue;
        return loose && (!left.hasTime || !other.hasTime) ? dateOnly(left) === dateOnly(other)
          : left.timestamp === other.timestamp && (loose || left.hasTime === other.hasTime);
      }
      case 'duration': return loose ? durationMilliseconds(left, now) === durationMilliseconds(right as BaseDurationValue, now)
        : durationKeys.every(key => left[key] === (right as BaseDurationValue)[key]);
      default: return false;
    }
  }
  if (!loose) return false;
  if (left.type === 'list' && left.value.length === 1) return baseValuesEqual(left.value[0], right, true, now);
  if (right.type === 'list' && right.value.length === 1) return baseValuesEqual(left, right.value[0], true, now);
  if (['string', 'number', 'boolean'].includes(left.type) && ['string', 'number', 'boolean'].includes(right.type)) {
    const a = (left as { value: string | number | boolean }).value, b = (right as { value: string | number | boolean }).value;
    return Number(a) === Number(b);
  }
  if (right.type === 'string' && (left.type === 'date' || left.type === 'duration')) {
    const parsed = left.type === 'date' ? parseDate(right.value) : parseDuration(right.value);
    return parsed.type !== 'null' && baseValuesEqual(left, parsed, true, now);
  }
  if (left.type === 'string' && (right.type === 'date' || right.type === 'duration')) return baseValuesEqual(right, left, true, now);
  return false;
}

export type BaseExpression =
  | { readonly kind: 'literal'; readonly value: BaseExpressionValue }
  | { readonly kind: 'identifier'; readonly name: string }
  | { readonly kind: 'list'; readonly items: readonly BaseExpression[] }
  | { readonly kind: 'unary'; readonly operator: '!' | '-'; readonly operand: BaseExpression }
  | { readonly kind: 'binary'; readonly operator: string; readonly left: BaseExpression; readonly right: BaseExpression }
  | { readonly kind: 'member'; readonly object: BaseExpression; readonly key: BaseExpression; readonly computed: boolean }
  | { readonly kind: 'call'; readonly callee: BaseExpression; readonly args: readonly BaseExpression[] };
interface Token { text: string; offset: number; kind: 'name' | 'number' | 'string' | 'symbol' | 'end'; value?: string }
class Lexer {
  readonly source: string;
  position = 0;
  constructor(source: string) { this.source = source; }
  error(message: string, offset = this.position): never { throw new BaseExpressionError('parse', message, offset); }
  next(): Token {
    while (/\s/u.test(this.source[this.position] ?? '') && this.position < this.source.length) this.position++;
    const offset = this.position, char = this.source[offset];
    if (char === undefined) return { kind: 'end', text: '', offset };
    if (char === '"' || char === "'") {
      this.position++; let value = '';
      while (this.position < this.source.length) {
        const next = this.source[this.position++];
        if (next === char) return { kind: 'string', text: this.source.slice(offset, this.position), value, offset };
        if (next.charCodeAt(0) < 32) this.error('Unescaped control character in string', this.position - 1);
        if (next !== '\\') { value += next; continue; }
        const escape = this.source[this.position++];
        if (escape === "'" && char !== "'") this.error('Invalid string escape', this.position - 1);
        const escapes: Record<string, string> = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (escape === 'u') {
          const hex = this.source.slice(this.position, this.position + 4);
          if (!/^[\da-f]{4}$/i.test(hex)) this.error('Invalid Unicode escape', this.position);
          value += String.fromCharCode(parseInt(hex, 16)); this.position += 4;
        } else if (Object.hasOwn(escapes, escape)) value += escapes[escape];
        else this.error('Invalid string escape', this.position - 1);
      }
      return this.error('Unterminated string', offset);
    }
    const rest = this.source.slice(offset), number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) { this.position += number[0].length; return { kind: 'number', text: number[0], offset }; }
    const name = /^[$_\p{L}][$_\p{L}\p{N}\p{M}]*/u.exec(rest);
    if (name) { this.position += name[0].length; return { kind: 'name', text: name[0], offset }; }
    const pair = rest.slice(0, 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(pair)) { this.position += 2; return { kind: 'symbol', text: pair, offset }; }
    if ('+-*/%!<>().,[]'.includes(char)) { this.position++; return { kind: 'symbol', text: char, offset }; }
    return this.error(`Unsupported token ${char}`, offset);
  }
  regexp(offset: number): BaseExpressionValue {
    let pattern = '', inClass = false, escaped = false;
    while (this.position < this.source.length) {
      const char = this.source[this.position++];
      if (char === '\n' || char === '\r') return this.error('Unterminated regular expression', offset);
      if (!escaped && char === '/' && !inClass) {
        const flags = /^[a-z]*/i.exec(this.source.slice(this.position))![0]; this.position += flags.length;
        try { return { type: 'regexp', value: new RegExp(pattern, flags) }; }
        catch { return this.error('Invalid regular expression', offset); }
      }
      pattern += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
    }
    return this.error('Unterminated regular expression', offset);
  }
}
// Conventional precedence; exhaustive agreement with the compiled reference grammar is not certified.
const precedence: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };
export function parseBaseExpression(source: string): BaseExpression {
  const lexer = new Lexer(source); let token = lexer.next(), depth = 0;
  const advance = () => { token = lexer.next(); };
  const expect = (text: string) => { if (token.text !== text) lexer.error(`Expected ${text}`, token.offset); advance(); };
  function expression(minimum = 0): BaseExpression {
    if (++depth > 256) return lexer.error('Expression nesting limit exceeded', token.offset);
    try {
      let node: BaseExpression;
      const first = token;
      if (first.text === '-' || first.text === '!') { advance(); node = { kind: 'unary', operator: first.text, operand: expression(7) }; }
      else if (first.text === '(') { advance(); node = expression(); expect(')'); }
      else if (first.text === '[') {
        advance(); const items: BaseExpression[] = [];
        if (token.text !== ']') { do { items.push(expression()); if (token.text !== ',') break; advance(); } while (true); }
        expect(']'); node = { kind: 'list', items };
      } else if (first.text === '/') { node = { kind: 'literal', value: lexer.regexp(first.offset) }; advance(); }
      else if (first.kind === 'string') { advance(); node = { kind: 'literal', value: str(first.value!) }; }
      else if (first.kind === 'number') { advance(); node = { kind: 'literal', value: num(Number(first.text)) }; }
      else if (first.kind === 'name') {
        advance(); node = first.text === 'null' ? { kind: 'literal', value: BASE_NULL }
          : ['true', 'false'].includes(first.text) ? { kind: 'literal', value: bool(first.text === 'true') }
          : { kind: 'identifier', name: first.text };
      } else return lexer.error('Expected an expression', first.offset);
      while (true) {
        if (token.text === '.') {
          advance(); if (token.kind !== 'name') lexer.error('Expected a property name', token.offset);
          node = { kind: 'member', object: node, key: { kind: 'literal', value: str(token.text) }, computed: false }; advance();
        } else if (token.text === '[') {
          advance(); const key = expression(); expect(']'); node = { kind: 'member', object: node, key, computed: true };
        } else if (token.text === '(') {
          advance(); const args: BaseExpression[] = [];
          if ((token as Token).text !== ')') { do { args.push(expression()); if ((token as Token).text !== ',') break; advance(); } while (true); }
          expect(')'); node = { kind: 'call', callee: node, args };
        } else {
          const strength = Object.hasOwn(precedence, token.text) ? precedence[token.text] : -1;
          if (strength < minimum) break;
          const operator = token.text; advance(); node = { kind: 'binary', operator, left: node, right: expression(strength + 1) };
        }
      }
      return node;
    } finally { depth--; }
  }
  if (token.kind === 'end') return { kind: 'literal', value: BASE_NULL };
  const result = expression();
  if ((token as Token).kind !== 'end') lexer.error('Unexpected trailing input', token.offset);
  return result;
}

export interface BaseExpressionContext {
  readonly resolveIdentifier: (name: string) => BaseExpressionValue | undefined;
  readonly functions?: BaseFunctionRegistry;
  readonly now?: () => Date;
  readonly maxSteps?: number;
}
export interface BaseExpressionRuntime {
  readonly context: BaseExpressionContext;
  readonly evaluate: (expression: string | BaseExpression, context?: BaseExpressionContext) => BaseExpressionValue;
}
export interface BaseFunctionParameter { readonly types: readonly (BaseValueType | 'any')[]; readonly optional?: boolean; readonly variadic?: boolean }
export interface BaseFunctionDefinition {
  readonly receiver?: BaseValueType | 'any';
  readonly parameters: readonly BaseFunctionParameter[];
  readonly invoke: (args: readonly BaseExpressionValue[], runtime: BaseExpressionRuntime, subject?: BaseExpressionValue) => BaseExpressionValue;
}
/** Registrations are explicit capabilities. Formula syntax cannot call arbitrary JS members. */
export class BaseFunctionRegistry {
  private entries = new Map<string, BaseFunctionDefinition>();
  register(name: string, definition: BaseFunctionDefinition): () => void {
    if (!name || definition.parameters.some((parameter, index) => parameter.variadic && index !== definition.parameters.length - 1)) {
      return fail('type', 'Invalid function registration');
    }
    const key = `${definition.receiver ?? 'global'}:${name.toLowerCase()}`;
    this.entries.set(key, definition);
    return () => { if (this.entries.get(key) === definition) this.entries.delete(key); };
  }
  find(name: string, subject?: BaseExpressionValue): BaseFunctionDefinition | undefined {
    const lower = name.toLowerCase();
    return this.entries.get(`${subject?.type ?? 'global'}:${lower}`) ?? (subject ? this.entries.get(`any:${lower}`) : undefined);
  }
}
export interface BaseExpressionContextOptions {
  readonly note?: Readonly<Record<string, unknown>>;
  readonly file?: Readonly<Record<string, unknown>>;
  readonly thisValue?: Readonly<Record<string, unknown>>;
  readonly formulas?: Readonly<Record<string, string | BaseExpression>>;
  readonly resolveIdentifier?: BaseExpressionContext['resolveIdentifier'];
  readonly functions?: BaseFunctionRegistry;
  readonly now?: () => Date;
  readonly maxSteps?: number;
}
/** A context is a detached row snapshot. Construct a new one after row/query changes. */
export function createBaseExpressionContext(options: BaseExpressionContextOptions = {}): BaseExpressionContext {
  const note = baseExpressionValue(options.note ?? {}), file = baseExpressionValue(options.file ?? {});
  const local = options.thisValue ? baseExpressionValue(options.thisValue) : BASE_NULL;
  const formulas = { ...options.formulas }, cache = new Map<string, BaseExpressionValue>(), pending = new Set<string>();
  const formula: BaseNamespaceValue = { type: 'namespace', name: 'formula', get(name, runtime) {
    const key = ownKey(formulas, name);
    if (key === undefined) return BASE_NULL;
    if (pending.has(key)) return fail('cycle', `Circular formula dependency: ${key}`);
    if (!cache.has(key)) {
      pending.add(key);
      try { cache.set(key, runtime.evaluate(formulas[key], context)); }
      catch (error) {
        const failure = asError(error);
        if (failure.code === 'budget') throw failure; // A larger surrounding expression may have consumed the budget.
        cache.set(key, { type: 'error', error: failure });
      }
      finally { pending.delete(key); }
    }
    const value = cache.get(key)!;
    if (value.type === 'error') throw value.error;
    return value;
  } };
  const context: BaseExpressionContext = {
    functions: options.functions, now: options.now, maxSteps: options.maxSteps,
    resolveIdentifier(name) {
      switch (name.toLowerCase()) {
        case 'note': return note;
        case 'file': return file;
        case 'this': return local;
        case 'formula': return formula;
      }
      const custom = options.resolveIdentifier?.(name);
      if (custom !== undefined) return custom;
      if (note.type !== 'object') return BASE_NULL;
      const key = ownKey(note.value, name);
      return key === undefined ? BASE_NULL : note.value[key];
    },
  };
  return context;
}
function member(value: BaseExpressionValue, key: BaseExpressionValue, computed: boolean, runtime: BaseExpressionRuntime): BaseExpressionValue {
  if (value.type === 'null' || key.type === 'null') return BASE_NULL;
  if (computed && value.type === 'list') {
    if (key.type !== 'number') return fail('access', 'List index must be a number');
    const index = key.value < 0 ? value.value.length + key.value : key.value;
    return Object.hasOwn(value.value, index) ? value.value[index] : BASE_NULL;
  }
  if (computed && value.type === 'string' && key.type === 'number') return str(value.value.charAt(key.value));
  if (key.type !== 'string') return fail('access', 'Property name must be a string');
  const name = key.value, lower = name.toLowerCase();
  if (value.type === 'object') {
    const actual = ownKey(value.value, name); return actual === undefined ? BASE_NULL : value.value[actual];
  }
  if (value.type === 'namespace') return value.get(name, runtime) ?? BASE_NULL;
  if ((value.type === 'string' || value.type === 'list') && lower === 'length') return num(value.value.length);
  if (value.type === 'date') {
    const date = new Date(value.timestamp);
    const parts: Record<string, number> = { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(),
      hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds(), millisecond: date.getMilliseconds(), timestamp: date.getTime() };
    if (Object.hasOwn(parts, lower)) return num(parts[lower]);
  }
  if (value.type === 'duration') return fail('unsupported', 'Duration member conversion requires calendar-aware host support');
  return fail('access', `Property ${name} is unavailable on ${value.type}`);
}
function arithmetic(operator: string, left: BaseExpressionValue, right: BaseExpressionValue): BaseExpressionValue {
  if (left.type === 'number' && right.type === 'number') {
    switch (operator) {
      case '+': return num(left.value + right.value);
      case '-': return num(left.value - right.value);
      case '*': return num(left.value * right.value);
      case '/': return num(left.value / right.value);
      case '%': return num(left.value % right.value);
    }
  }
  if (left.type === 'date' && right.type === 'string') {
    const parsed = parseDuration(right.value); if (parsed.type === 'duration') right = parsed;
  }
  if (left.type === 'date' && right.type === 'duration' && ['+', '-'].includes(operator)) return addDuration(left, right, operator === '-' ? -1 : 1);
  if (left.type === 'date' && right.type === 'date' && operator === '-') return baseDuration({ milliseconds: left.timestamp - right.timestamp });
  if (left.type === 'duration' && right.type === 'number' && ['*', '/'].includes(operator)) {
    const factor = operator === '*' ? right.value : 1 / right.value;
    return baseDuration(Object.fromEntries(durationKeys.map(key => [key, left[key] * factor])));
  }
  if (left.type === 'duration' && right.type === 'duration' && ['+', '-'].includes(operator)) {
    const sign = operator === '+' ? 1 : -1;
    return baseDuration(Object.fromEntries(durationKeys.map(key => [key, left[key] + sign * right[key]])));
  }
  if (left.type === 'list' && right.type === 'list' && operator === '+') return list([...left.value, ...right.value]);
  if (operator === '+' && (left.type === 'string' || right.type === 'string')) {
    return str((left.type === 'null' ? '' : baseValueToString(left)) + (right.type === 'null' ? '' : baseValueToString(right)));
  }
  if (left.type === 'null' || right.type === 'null') return BASE_NULL;
  return fail('type', `Operator ${operator} does not accept ${left.type} and ${right.type}`);
}
function comparison(operator: string, left: BaseExpressionValue, right: BaseExpressionValue, runtime: BaseExpressionRuntime): BaseExpressionValue {
  const now = runtime.context.now?.() ?? new Date();
  if (operator === '==' || operator === '!=') return bool(baseValuesEqual(left, right, true, now) === (operator === '=='));
  if (left.type === 'null' || right.type === 'null') return BASE_NULL;
  if (right.type === 'string' && (left.type === 'date' || left.type === 'duration')) {
    const parsed = left.type === 'date' ? parseDate(right.value) : parseDuration(right.value);
    if (parsed.type !== 'null') right = parsed;
  }
  const scalar = (value: BaseExpressionValue): string | number => value.type === 'number' ? value.value
    : value.type === 'date' ? value.timestamp : value.type === 'duration' ? durationMilliseconds(value, now) : baseValueToString(value);
  const a = scalar(left), b = scalar(right);
  switch (operator) {
    case '<': return bool(a < b);
    case '>': return bool(a > b);
    case '<=': return bool(a <= b);
    case '>=': return bool(a >= b);
    default: return fail('unsupported', `Unsupported comparison ${operator}`);
  }
}
function requireArity(name: string, count: number, minimum: number, maximum = minimum): void {
  if (count < minimum || count > maximum) fail('type', `${name} expects ${minimum === maximum ? minimum : `${minimum}–${maximum}`} arguments; received ${count}`);
}
function invoke(definition: BaseFunctionDefinition, name: string, expressions: readonly BaseExpression[], runtime: BaseExpressionRuntime, subject?: BaseExpressionValue): BaseExpressionValue {
  const parameters = definition.parameters, args: BaseExpressionValue[] = [];
  let position = 0;
  for (const expression of expressions) {
    const value = runtime.evaluate(expression); args.push(value);
    const parameter = parameters[position];
    if (!parameter) return fail('type', `Too many arguments for ${name}`);
    if (value.type === 'null' && parameter.optional) { if (!parameter.variadic) position++; continue; }
    if (!parameter.types.includes('any') && !parameter.types.includes(value.type)) {
      if (value.type === 'null') return BASE_NULL;
      return fail('type', `${name} expected ${parameter.types.join(' or ')}, received ${value.type}`);
    }
    if (!parameter.variadic) position++;
  }
  if (parameters.slice(position).some(parameter => !parameter.optional && !parameter.variadic)) return fail('type', `Not enough arguments for ${name}`);
  return definition.invoke(args, runtime, subject);
}
function evaluateTree(tree: BaseExpression, context: BaseExpressionContext, state: { remaining: number; depth: number }): BaseExpressionValue {
  if (--state.remaining < 0) return fail('budget', 'Expression evaluation budget exceeded');
  if (++state.depth > 256) { state.depth--; return fail('budget', 'Expression evaluation nesting limit exceeded'); }
  const runtime: BaseExpressionRuntime = { context, evaluate: (expression, scope = context) => evaluateTree(typeof expression === 'string' ? parseBaseExpression(expression) : expression, scope, state) };
  const evaluate = (expression: string | BaseExpression) => runtime.evaluate(expression);
  try {
    switch (tree.kind) {
      case 'literal': return tree.value;
      case 'identifier': return context.resolveIdentifier(tree.name) ?? BASE_NULL;
      case 'list': return list(tree.items.map(evaluate));
      case 'member': return member(evaluate(tree.object), evaluate(tree.key), tree.computed, runtime);
      case 'unary': {
        const value = evaluate(tree.operand);
        if (value.type === 'null') return BASE_NULL;
        if (tree.operator === '!') return bool(!baseValueIsTruthy(value));
        if (value.type !== 'number') return fail('type', 'Unary minus requires a number');
        return num(-value.value);
      }
      case 'binary': {
        const left = evaluate(tree.left);
        if (tree.operator === '&&') return bool(baseValueIsTruthy(left) && baseValueIsTruthy(evaluate(tree.right)));
        if (tree.operator === '||') return bool(baseValueIsTruthy(left) || baseValueIsTruthy(evaluate(tree.right)));
        const right = evaluate(tree.right);
        return ['+', '-', '*', '/', '%'].includes(tree.operator) ? arithmetic(tree.operator, left, right) : comparison(tree.operator, left, right, runtime);
      }
      case 'call': {
        let name: string, subjectTree: BaseExpression | undefined;
        if (tree.callee.kind === 'identifier') name = tree.callee.name;
        else if (tree.callee.kind === 'member' && !tree.callee.computed && tree.callee.key.kind === 'literal' && tree.callee.key.value.type === 'string') {
          name = tree.callee.key.value.value; subjectTree = tree.callee.object;
        } else return fail('unsupported', 'Only named functions and dot-method calls are supported');
        if (name === 'if') {
          const operands = subjectTree ? [subjectTree, ...tree.args] : tree.args;
          requireArity(name, operands.length, 2, 3);
          return baseValueIsTruthy(evaluate(operands[0])) ? evaluate(operands[1]) : operands[2] ? evaluate(operands[2]) : BASE_NULL;
        }
        const subject = subjectTree ? evaluate(subjectTree) : undefined;
        if (subject && (subject.type === 'list' || subject.type === 'object') && ['map', 'filter', 'reduce'].includes(name)) {
          if (name === 'reduce' && subject.type === 'object') return fail('unknown-function', 'Object.reduce is unavailable');
          requireArity(name, tree.args.length, name === 'reduce' ? 2 : 1);
          let accumulator = name === 'reduce' ? evaluate(tree.args[1]) : BASE_NULL;
          const items = subject.type === 'list' ? subject.value.map((value, index) => [String(index), value] as const) : Object.entries(subject.value);
          const results: [string, BaseExpressionValue][] = [];
          for (const [key, value] of items) {
            const bindings: Record<string, BaseExpressionValue> = subject.type === 'list' ? { index: num(Number(key)), value } : { key: str(key), value };
            if (name === 'reduce') bindings.acc = accumulator;
            const nested: BaseExpressionContext = { ...context, resolveIdentifier: name => Object.hasOwn(bindings, name) ? bindings[name] : context.resolveIdentifier(name) };
            const output = evaluateTree(tree.args[0], nested, state);
            if (name === 'reduce') accumulator = output;
            else if (name === 'map') results.push([key, output]);
            else if (baseValueIsTruthy(output)) results.push([key, value]);
          }
          return name === 'reduce' ? accumulator : name === 'filter' && subject.type === 'object'
            ? { type: 'object', value: Object.fromEntries(results) } : list(results.map(([, value]) => value));
        }
        const definition = context.functions?.find(name, subject) ?? builtins.find(name, subject);
        if (!definition) {
          if (subject?.type === 'null') return BASE_NULL;
          return fail('unknown-function', `Unknown function ${subject ? `${subject.type}.` : ''}${name}`);
        }
        return invoke(definition, name, tree.args, runtime, subject);
      }
    }
  } finally { state.depth--; }
}
/** Strict entry point: exceptions propagate; an explicitly returned error value remains a value. */
export function evaluateBaseExpressionOrThrow(expression: string | BaseExpression, context: BaseExpressionContext = createBaseExpressionContext()): BaseExpressionValue {
  const budget = context.maxSteps ?? 100_000;
  if (!Number.isSafeInteger(budget) || budget < 0) return fail('type', 'maxSteps must be a finite nonnegative safe integer');
  return evaluateTree(typeof expression === 'string' ? parseBaseExpression(expression) : expression, context, { remaining: budget, depth: 0 });
}
/** Formula-facing entry point: failures remain typed values rather than false/null. */
export function evaluateBaseExpression(expression: string | BaseExpression, context: BaseExpressionContext = createBaseExpressionContext()): BaseExpressionValue {
  try { return evaluateBaseExpressionOrThrow(expression, context); }
  catch (error) { return { type: 'error', error: asError(error) }; }
}
export function testBaseExpression(expression: string | BaseExpression, context: BaseExpressionContext = createBaseExpressionContext()): boolean {
  return baseValueIsTruthy(evaluateBaseExpressionOrThrow(expression, context));
}

const builtins = new BaseFunctionRegistry();
const required = (...types: (BaseValueType | 'any')[]): BaseFunctionParameter => ({ types });
const optional = (...types: (BaseValueType | 'any')[]): BaseFunctionParameter => ({ types, optional: true });
const variadic = (...types: (BaseValueType | 'any')[]): BaseFunctionParameter => ({ types, variadic: true });
function builtin(name: string, receiver: BaseFunctionDefinition['receiver'], parameters: readonly BaseFunctionParameter[], invoke: BaseFunctionDefinition['invoke']): void {
  builtins.register(name, { receiver, parameters, invoke });
}
const numberData = (value: BaseExpressionValue): number => (value as Extract<BaseExpressionValue, { type: 'number' }>).value;
const stringData = (value: BaseExpressionValue): string => (value as Extract<BaseExpressionValue, { type: 'string' }>).value;
const listData = (value: BaseExpressionValue): readonly BaseExpressionValue[] => (value as Extract<BaseExpressionValue, { type: 'list' }>).value;
const optionalNumber = (value: BaseExpressionValue | undefined): number | undefined => !value || value.type === 'null' ? undefined : numberData(value);
builtin('if', undefined, [required('boolean'), required('any'), optional('any')], args => baseValueIsTruthy(args[0]) ? args[1] : args[2] ?? BASE_NULL);
builtin('number', undefined, [required('number', 'boolean', 'string', 'date', 'list', 'object', 'duration', 'regexp')], ([value]) => {
  if (value.type === 'number') return value;
  if (value.type === 'boolean') return num(value.value ? 1 : 0);
  if (value.type === 'date') return num(value.timestamp);
  if (value.type === 'string') {
    const result = parseFloat(value.value);
    if (!Number.isNaN(result)) return num(result);
  }
  return fail('type', `Cannot convert ${value.type} to a number`);
});
builtin('date', undefined, [required('string', 'date')], ([value]) => {
  if (value.type === 'date') return value;
  const text = stringData(value), parsed = parseDate(text);
  if (parsed.type !== 'null') return parsed;
  if (/^\d{8}(?:\d{4})?$/.test(text)) {
    const date = new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)),
      Number(text.slice(8, 10) || 0), Number(text.slice(10, 12) || 0));
    return baseDate(date, text.length === 12);
  }
  return BASE_NULL;
});
builtin('duration', undefined, [required('string')], ([value]) => parseDuration(stringData(value)));
builtin('now', undefined, [], (_, runtime) => baseDate(runtime.context.now?.() ?? new Date()));
builtin('today', undefined, [], (_, runtime) => baseDate(dateOnly(baseDate(runtime.context.now?.() ?? new Date())), false));
builtin('list', undefined, [required('string', 'number', 'boolean', 'list', 'object', 'regexp', 'date', 'duration')], ([value]) => value.type === 'list' ? value : list([value]));
function extremum(operation: 'min' | 'max', values: readonly number[]): number {
  let result = operation === 'min' ? Infinity : -Infinity;
  for (const value of values) result = Math[operation](result, value);
  return result;
}
for (const operation of ['min', 'max'] as const) {
  builtin(operation, undefined, [variadic('number')], args => args.length ? num(extremum(operation, args.map(numberData))) : BASE_NULL);
}
builtin('toString', 'any', [], (_, __, subject) => str(baseValueToString(subject!)));
builtin('isTruthy', 'any', [], (_, __, subject) => bool(baseValueIsTruthy(subject!)));
builtin('isType', 'any', [required('string')], ([type], _, subject) => bool(stringData(type).toLowerCase() === 'any' || stringData(type).toLowerCase() === subject!.type));
for (const receiver of ['null', 'string', 'list', 'object', 'number', 'date'] as const) {
  builtin('isEmpty', receiver, [], (_, __, subject) => bool(subject!.type === 'null'
    || (subject!.type === 'string' || subject!.type === 'list') && subject!.value.length === 0
    || subject!.type === 'object' && Object.keys(subject!.value).length === 0));
}
for (const operation of ['ceil', 'floor', 'abs'] as const) builtin(operation, 'number', [], (_, __, subject) => num(Math[operation](numberData(subject!))));
builtin('round', 'number', [optional('number')], ([digits], _, subject) => {
  const value = numberData(subject!), places = optionalNumber(digits);
  return num(places !== undefined && places > 0 ? Math.round(value * 10 ** places) / 10 ** places : Math.round(value));
});
builtin('toFixed', 'number', [required('number')], ([digits], _, subject) => str(numberData(subject!).toFixed(numberData(digits))));
for (const operation of ['startsWith', 'endsWith'] as const) {
  builtin(operation, 'string', [required('string')], ([query], _, subject) => bool(stringData(subject!)[operation](stringData(query))));
}
builtin('contains', 'string', [required('string')], ([query], _, subject) => bool(stringData(query) !== '' && stringData(subject!).toLowerCase().includes(stringData(query).toLowerCase())));
for (const operation of ['containsAny', 'containsAll'] as const) {
  builtin(operation, 'string', [variadic('string')], (args, _, subject) => {
    const text = stringData(subject!).toLowerCase(), matches = (value: BaseExpressionValue) => text.includes(stringData(value).toLowerCase());
    return bool(operation === 'containsAny' ? args.some(matches) : args.every(matches));
  });
}
for (const operation of ['trim', 'lower', 'reverse', 'title'] as const) {
  builtin(operation, 'string', [], (_, __, subject) => {
    const text = stringData(subject!);
    return str(operation === 'trim' ? text.trim() : operation === 'lower' ? text.toLowerCase()
      : operation === 'reverse' ? text.split('').reverse().join('')
      : text.split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(' '));
  });
}
builtin('slice', 'string', [required('number'), optional('number')], ([start, end], _, subject) => str(stringData(subject!).slice(numberData(start), optionalNumber(end))));
builtin('repeat', 'string', [required('number')], ([count], _, subject) => str(stringData(subject!).repeat(numberData(count))));
builtin('split', 'string', [required('string', 'regexp'), optional('number')], ([separator, limit], _, subject) =>
  list(stringData(subject!).split(separator.type === 'regexp' ? separator.value : stringData(separator), optionalNumber(limit)).map(str)));
builtin('replace', 'string', [required('string', 'regexp'), required('string')], ([pattern, replacement], _, subject) => {
  const text = stringData(subject!), replace = stringData(replacement);
  return str(pattern.type === 'regexp' ? text.replace(pattern.value, replace)
    : stringData(pattern) === '' ? text : text.split(stringData(pattern)).join(replace));
});
builtin('matches', 'regexp', [required('string')], ([value], _, subject) => bool((subject as Extract<BaseExpressionValue, { type: 'regexp' }>).value.test(stringData(value))));
builtin('contains', 'list', [required('any')], ([value], runtime, subject) => bool(listData(subject!).some(item => baseValuesEqual(item, value, true, runtime.context.now?.()))));
for (const operation of ['containsAny', 'containsAll'] as const) {
  builtin(operation, 'list', [variadic('any')], (args, runtime, subject) => {
    const candidates = args.length === 1 && args[0].type === 'list' ? args[0].value : args;
    const includes = (value: BaseExpressionValue) => listData(subject!).some(item => baseValuesEqual(item, value, true, runtime.context.now?.()));
    return bool(operation === 'containsAny' ? candidates.some(includes) : candidates.every(includes));
  });
}
builtin('slice', 'list', [required('number'), optional('number')], ([start, end], _, subject) => list(listData(subject!).slice(numberData(start), optionalNumber(end))));
builtin('reverse', 'list', [], (_, __, subject) => list([...listData(subject!)].reverse()));
builtin('join', 'list', [required('string')], ([separator], _, subject) => str(listData(subject!).map(baseValueToString).join(stringData(separator))));
builtin('flat', 'list', [], (_, __, subject) => {
  const output: BaseExpressionValue[] = [], work = [...listData(subject!)].reverse();
  while (work.length) { const next = work.pop()!; if (next.type === 'list') for (let i = next.value.length - 1; i >= 0; i--) work.push(next.value[i]); else output.push(next); }
  return list(output);
});
for (const operation of ['sum', 'mean', 'median', 'min', 'max', 'stddev'] as const) {
  builtin(operation, 'list', [], (_, __, subject) => {
    const all = listData(subject!), values = all.filter(value => value.type === 'number').map(numberData);
    if (!values.length) return BASE_NULL;
    const sum = values.reduce((a, b) => a + b, 0);
    if (operation === 'sum') return num(sum);
    if (operation === 'mean') return num(sum / all.length);
    if (operation === 'min' || operation === 'max') return num(extremum(operation, values));
    if (operation === 'stddev') { const mean = sum / values.length; return num(Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length)); }
    values.sort((a, b) => a - b); const middle = Math.floor(values.length / 2);
    return num(values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2);
  });
}
for (const operation of ['keys', 'values'] as const) {
  builtin(operation, 'object', [], (_, __, subject) => {
    const object = (subject as Extract<BaseExpressionValue, { type: 'object' }>).value;
    return list(operation === 'keys' ? Object.keys(object).map(str) : Object.values(object));
  });
}
// Non-lowercase calls use the ordinary registry path, matching the audited distinction.
for (const receiver of ['list', 'object'] as const) {
  builtin('map', receiver, [required('any')], (_, __, subject) => subject!.type === 'object' ? list(Object.values(subject!.value)) : subject!);
  builtin('filter', receiver, [required('boolean')], (_, __, subject) => subject!);
}
builtin('reduce', 'list', [required('any'), required('any')], (_, __, subject) => subject!);
builtin('date', 'date', [], (_, __, subject) => baseDate(dateOnly(subject as BaseDateValue), false));
