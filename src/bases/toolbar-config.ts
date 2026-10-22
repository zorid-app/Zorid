import { BUILTIN_BASE_VIEW_TYPES } from './document.ts';
import type { BaseValue, BaseViewPatch } from './document.ts';
import { parseBaseExpression } from './expression.ts';
import { normalizeBaseProperty } from './query.ts';
import type { BaseQueryResult } from './query.ts';

export type BaseToolbarPatch = BaseViewPatch;
import { baseFilterMethod } from './toolbar-filter-types.ts';
import type { BaseFileFilterOperator, BaseFilterOperator, BaseFilterLiteral } from './toolbar-filter-types.ts';
export type { BaseFileFilterOperator, BaseFilterOperator, BaseFilterLiteral } from './toolbar-filter-types.ts';
export type BaseFilterValueType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'list' | 'null';
export const BASE_FILE_FILTER_OPERATORS = [
  {id:'hasLink',label:'links to',method:'hasLink',kind:'file',inverse:false},
  {id:'inFolder',label:'in folder',method:'inFolder',kind:'folder',inverse:false},
  {id:'hasTag',label:'has tag',method:'hasTag',kind:'tag',inverse:false},
  {id:'hasProperty',label:'has property',method:'hasProperty',kind:'property',inverse:false},
  {id:'notHasLink',label:'does not link to',method:'hasLink',kind:'file',inverse:true},
  {id:'notInFolder',label:'is not in folder',method:'inFolder',kind:'folder',inverse:true},
  {id:'notHasTag',label:'does not have tag',method:'hasTag',kind:'tag',inverse:true},
  {id:'notHasProperty',label:'does not have property',method:'hasProperty',kind:'property',inverse:true},
] as const;
export const baseFileFilterOperator = (operator:BaseFilterOperator) => BASE_FILE_FILTER_OPERATORS.find(item=>item.id===operator);
const allowedKeys = new Set(['filters', 'sort', 'order', 'groupBy', 'groupOrder', 'name', 'type', 'limit', 'rowHeight', 'cardSize', 'columnWidth', 'image', 'imageFit', 'imageAspectRatio', 'markers', 'indentProperties', 'separator']);
const fail = (message: string): never => { throw new Error(message); };
const mapping = (value: unknown): value is Record<string, BaseValue> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reject executable/object-identity inputs before inspecting staged configuration. */
function detach(value: unknown, ancestors = new Set<object>(), budget = { remaining: 10000 }, depth = 0): BaseValue {
  if (--budget.remaining < 0 || depth > 64) return fail('Toolbar configuration is too large or deeply nested');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return fail('Toolbar configuration contains an unsupported value');
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return fail('Toolbar configuration must use plain mappings and lists');
  if (ancestors.has(value)) return fail('Toolbar configuration cannot be cyclic');
  if (Object.getOwnPropertySymbols(value).length) return fail('Toolbar configuration cannot contain symbol keys');
  ancestors.add(value);
  try {
    const entries: [string, BaseValue][] = [];
    for (const key of Object.getOwnPropertyNames(value)) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) return fail('Toolbar configuration must contain enumerable data properties');
      if (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return fail('Toolbar lists cannot have named properties');
      entries.push([key, detach(descriptor.value, ancestors, budget, depth + 1)]);
    }
    if (!array) return Object.fromEntries(entries);
    if (entries.length !== value.length) return fail('Toolbar lists cannot be sparse');
    return entries.map(([, item]) => item);
  } finally { ancestors.delete(value); }
}
function propertyId(value: unknown): string {
  if (typeof value !== 'string' || !value.length) return fail('Property IDs must be nonempty strings');
  const normalized = normalizeBaseProperty(value);
  if (!normalized.slice(normalized.indexOf('.') + 1).length) return fail('Property IDs must include a property name');
  return normalized;
}
function existingProperty(value: BaseValue | undefined): string | undefined {
  if (!mapping(value)) return undefined;
  const property = value.column || value.property;
  return typeof property === 'string' && property.length ? normalizeBaseProperty(property) : undefined;
}
function criterion(value: BaseValue, known: ReadonlySet<string>): BaseValue {
  if (!mapping(value)) return fail('Sort and group criteria must be mappings');
  const property = propertyId(value.column || value.property);
  if (!known.has(property)) return fail(`Unknown property: ${property}`);
  if (value.direction !== 'ASC' && value.direction !== 'DESC') return fail('Sort and group directions must be ASC or DESC');
  if (Object.hasOwn(value, 'column') && Object.hasOwn(value, 'property') && propertyId(value.column) !== propertyId(value.property)) return fail('A criterion cannot refer to two different properties');
  // Preserve extensions and the existing criterion spelling (column/property).
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'property' || key === 'column' ? property : entry]));
}
function validateFilter(value: BaseValue, budget = { remaining: 1000 }, depth = 0): void {
  if (--budget.remaining < 0 || depth > 32) return fail('Filters exceed the depth or node limit');
  if (typeof value === 'string') { parseBaseExpression(value); return; }
  if (!mapping(value)) return fail('A filter must be an expression or an and/or/not group');
  const keys = Object.keys(value), kind = keys[0];
  if (keys.length !== 1 || !['and', 'or', 'not'].includes(kind) || !Array.isArray(value[kind])) return fail('A filter group must contain only an and/or/not list');
  for (const child of value[kind]) validateFilter(child, budget, depth + 1);
}

/** Validate one staged view patch without changing either the query or caller data. */
export function validateToolbarPatch(result: BaseQueryResult, patch: BaseViewPatch): BaseViewPatch {
  if (!mapping(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) return fail('A toolbar patch must be a plain mapping');
  if (Object.getOwnPropertySymbols(patch).length) return fail('Toolbar patches cannot contain symbol keys');
  const output: BaseViewPatch = {}, budget = { remaining: 10000 };
  for (const key of Object.getOwnPropertyNames(patch)) {
    if (!allowedKeys.has(key)) return fail(`Unsupported toolbar option: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(patch, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) return fail('Toolbar patches must contain enumerable data properties');
    output[key] = descriptor.value === undefined ? undefined : detach(descriptor.value, new Set(), budget);
  }
  const available = new Set(result.availableProperties.map(propertyId));
  for (const [key, value] of Object.entries(output)) {
    switch (key) {
      case 'name':
        if (typeof value !== 'string' || !value.trim()) return fail('View name must not be empty');
        output.name = value.trim(); break;
      case 'type':
        if (typeof value !== 'string' || !(BUILTIN_BASE_VIEW_TYPES as readonly string[]).includes(value)) return fail('Unknown built-in view type');
        break;
      case 'order': {
        if (!Array.isArray(value)) return fail('Property order must be a list');
        const known = new Set(available);
        if (Array.isArray(result.view.order)) for (const property of result.view.order) if (typeof property === 'string') known.add(normalizeBaseProperty(property));
        const normalized = value.map(propertyId);
        if (new Set(normalized).size !== normalized.length) return fail('Property order cannot contain duplicates');
        for (const property of normalized) if (!known.has(property) && !property.startsWith('note.')) return fail(`Unknown property: ${property}`);
        output.order = normalized; break;
      }
      case 'sort': {
        if (!Array.isArray(value)) return fail('Sort criteria must be a list');
        const known = new Set(available), seen = new Set<string>();
        if (Array.isArray(result.view.sort)) for (const previous of result.view.sort) { const property = existingProperty(previous); if (property) known.add(property); }
        output.sort = value.map(entry => {
          const validated = criterion(entry, known), property = existingProperty(validated)!;
          if (seen.has(property)) return fail('Sort criteria cannot contain duplicate properties');
          seen.add(property); return validated;
        }); break;
      }
      case 'groupBy': {
        if (value === undefined) break;
        if (!mapping(value) || !Object.hasOwn(value, 'property')) return fail('Grouping requires a property and direction');
        const known = new Set(available), previous = existingProperty(result.view.groupBy);
        if (previous) known.add(previous);
        output.groupBy = criterion(value, known); break;
      }
      case 'groupOrder':
        if (!Object.hasOwn(output, 'groupBy')) return fail('Group order requires an accompanying grouping change');
        if (value !== undefined && (!Array.isArray(value) || !mapping(output.groupBy))) return fail('Group order must be a list with an active grouping');
        if (Array.isArray(value)) { const validate = (item:BaseValue):void => { if (Array.isArray(item)) { for (const child of item) validate(child); return; } if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') return fail('Group order values must be primitive values or lists'); }; for (const item of value) validate(item); }
        break;
      case 'filters': if (value !== undefined) validateFilter(value); break;
      case 'limit': if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) return fail('Limit must be a nonnegative whole number'); break;
      case 'rowHeight': if (value !== undefined && !['', 'short', 'medium', 'tall', 'extra'].includes(String(value))) return fail('Unknown row height'); break;
      case 'imageFit': if (value !== undefined && value !== '' && value !== 'cover' && value !== 'contain') return fail('Unknown image fit'); break;
      case 'markers': if (value !== undefined && !['bullet', 'number', 'none'].includes(String(value))) return fail('Unknown list marker'); break;
      case 'indentProperties': if (value !== undefined && typeof value !== 'boolean') return fail('Indent properties must be a checkbox'); break;
      case 'separator': if (value !== undefined && typeof value !== 'string') return fail('Property separator must be text'); break;
      case 'image': if (value !== undefined && (typeof value !== 'string' || !value)) return fail('Image property must be a property name'); break;
      case 'cardSize': case 'columnWidth': case 'imageAspectRatio': {
        const [min,max] = key === 'cardSize' ? [50,800] : key === 'columnWidth' ? [200,500] : [.25,2.5];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)) return fail(`${key} must be between ${min} and ${max}`);
        break;
      }
    }
  }
  return output;
}

/** Quote the complete property key so spaces, punctuation and quotes remain data. */
export function propertyExpression(property: string): string {
  const normalized = propertyId(property), split = normalized.indexOf('.');
  return `${normalized.slice(0, split)}[${JSON.stringify(normalized.slice(split + 1))}]`;
}

export interface BaseFilterCondition {
  property:string;
  operator:BaseFilterOperator;
  text:string;
  type:BaseFilterValueType;
  /** Legacy File operands remain readable for existing hosts. */
  values?:readonly string[];
  /** One comparison RHS, including one complete list literal. */
  operand?:BaseFilterLiteral;
  /** Exact method arguments: one list argument differs from variadic members. */
  arguments?:readonly BaseFilterLiteral[];
}
const comparisons:Partial<Record<BaseFilterOperator,string>>={eq:'==',neq:'!=',lt:'<',lte:'<=',gt:'>',gte:'>='};

/** Only literal data enters source; nested members retain primitive types. */
export function encodeFilterLiteral(value:BaseFilterLiteral):string {
  const active=new Set<readonly BaseFilterLiteral[]>(),budget={remaining:10000};
  const encode=(item:BaseFilterLiteral,depth=0):string=>{
    if(--budget.remaining<0||depth>64)return fail('Filter literal exceeds its size or nesting limit');
    if(item===null)return 'null';
    if(typeof item==='string')return JSON.stringify(item);
    if(typeof item==='boolean')return String(item);
    if(typeof item==='number'){if(!Number.isFinite(item))return fail('Enter a finite decimal number');return Object.is(item,-0)?'-0':String(item);}
    if(!Array.isArray(item)||active.has(item))return fail('Only finite primitive and list filter literals are supported');
    active.add(item);
    try{
      if(Object.getOwnPropertySymbols(item).length||Object.getOwnPropertyNames(item).some(key=>key!=='length'&&(!/^(?:0|[1-9]\d*)$/.test(key)||Number(key)>=item.length)))return fail('Filter lists contain only indexed values');
      const values:string[]=[];
      for(let index=0;index<item.length;index++){const property=Object.getOwnPropertyDescriptor(item,String(index));if(!property||!('value'in property))return fail('Filter lists cannot be sparse or contain accessors');values.push(encode(property.value as BaseFilterLiteral,depth+1));}
      return `[${values.join(', ')}]`;
    }finally{active.delete(item);}
  };return encode(value);
}
function legacyLiteral(value:string,type:BaseFilterValueType):BaseFilterLiteral {
  if(type==='text'||type==='date'||type==='datetime')return value;
  if(type==='number'){
    if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)||!Number.isFinite(Number(value)))return fail('Enter a finite decimal number');
    return Number(value);
  }
  if(type==='boolean'){if(value!=='true'&&value!=='false')return fail('Boolean values must be true or false');return value==='true';}
  if(type==='null'){if(value!==''&&value!=='null')return fail('Enter null');return null;}
  if(type==='list'){
    let parsed:unknown;try{parsed=JSON.parse(value);}catch{return fail('Enter a list literal');}
    if(!Array.isArray(parsed))return fail('Enter a list literal');encodeFilterLiteral(parsed as BaseFilterLiteral[]);return parsed as BaseFilterLiteral[];
  }
  return fail('Unknown filter value type');
}
/** Values for the operand control, never inferred by evaluating an expression. */
export function filterConditionValues(condition:BaseFilterCondition):readonly BaseFilterLiteral[] {
  if(condition.operator==='unset'||condition.operator==='set')return [];
  const method=baseFilterMethod(condition.operator);
  if(method){
    if(condition.arguments!==undefined)return condition.arguments;
    if(method.arity==='none')return [];
    if(condition.values!==undefined)return condition.values;
    return [legacyLiteral(condition.text,condition.type)];
  }
  if(Object.hasOwn(condition,'operand')){if(condition.operand===undefined)return fail('Enter a filter value');return [condition.operand];}
  return [legacyLiteral(condition.text,condition.type)];
}
/** Construct supported syntax without converting user text to code or dates. */
export function serializeFilterCondition(condition:BaseFilterCondition):string {
  const property=propertyId(condition.property),receiver=property==='file.file'?'file':propertyExpression(property);
  if(condition.operator==='unset'||condition.operator==='set')return `${receiver} ${condition.operator==='unset'?'==':'!='} null`;
  const method=baseFilterMethod(condition.operator),values=filterConditionValues(condition);
  // Validate the outer argument container before indexing or invoking array methods.
  encodeFilterLiteral(values);
  if(method){
    const file=baseFileFilterOperator(condition.operator);
    if(file&&property!=='file.file')return fail('File operators require the file property');
    if(property==='file.file'&&!file)return fail('This method requires a supported non-File property');
    if(method.arity==='none'?values.length!==0:method.arity==='one'?values.length!==1:values.length===0)return fail('Enter the supported file filter values or method arguments');
    if(file&&values.some(value=>typeof value!=='string'))return fail('File filter operands must be literal strings');
    return `${method.inverse?'!':''}${receiver}.${method.method}(${values.map(value=>encodeFilterLiteral(value)).join(', ')})`;
  }
  const comparison=comparisons[condition.operator];
  if(!comparison||values.length!==1)return fail('Unknown filter operator or operand count');
  if(property==='file.file')return fail('File comparisons remain in the advanced editor');
  return `${receiver} ${comparison} ${encodeFilterLiteral(values[0])}`;
}
/** Backward-compatible construction entry point; typed controls use the model. */
export function buildFilterCondition(property:string,operator:BaseFilterOperator,value:string|readonly BaseFilterLiteral[],valueType:BaseFilterValueType):string {
  if(!['text','number','boolean','date','datetime','list','null'].includes(valueType))return fail('Unknown filter value type');
  const method=baseFilterMethod(operator);
  const condition:BaseFilterCondition={property,operator,text:typeof value==='string'?value:'',type:valueType};
  if(method){
    condition.arguments=method.arity==='none'?[]:Array.isArray(value)?(method.arity==='one'&&valueType==='list'?[value]:value):[legacyLiteral(value as string,valueType)];
  }else if(operator!=='set'&&operator!=='unset')condition.operand=Array.isArray(value)?value:legacyLiteral(value as string,valueType);
  return serializeFilterCondition(condition);
}
/** Decode only exact supported literal AST shapes; arbitrary source stays advanced. */
export function decodeFilterCondition(source:string):BaseFilterCondition|undefined {
  try{
    let expression=parseBaseExpression(source);
    const property=(node:ReturnType<typeof parseBaseExpression>):string|undefined=>{
      if(node.kind==='identifier')return normalizeBaseProperty(node.name);
      if(node.kind==='member'&&node.object.kind==='identifier'&&['note','file','formula'].includes(node.object.name)&&node.key.kind==='literal'&&node.key.value.type==='string')return `${node.object.name}.${node.key.value.value}`;
      return undefined;
    };
    let remaining=10000;
    const literal=(node:ReturnType<typeof parseBaseExpression>,depth=0):BaseFilterLiteral=>{
      if(--remaining<0||depth>64)throw Error('Literal limit');
      if(node.kind==='literal'){
        const value=node.value;
        if(value.type==='null')return null;
        if(value.type==='string'||value.type==='boolean')return value.value;
        if(value.type==='number'&&Number.isFinite(value.value))return value.value;
      }
      if(node.kind==='unary'&&node.operator==='-'&&node.operand.kind==='literal'&&node.operand.value.type==='number'&&Number.isFinite(node.operand.value.value))return -node.operand.value.value;
      if(node.kind==='list')return node.items.map(item=>literal(item,depth+1));
      throw Error('Unsupported literal');
    };
    const scalar=(target:string,operator:BaseFilterOperator,value:BaseFilterLiteral):BaseFilterCondition=>{
      if(value===null&&(operator==='eq'||operator==='neq'))return {property:target,operator:operator==='eq'?'unset':'set',text:'',type:'text'};
      if(Array.isArray(value))return {property:target,operator,text:'',type:'list',operand:value};
      return {property:target,operator,text:value===null?'null':typeof value==='number'&&Object.is(value,-0)?'-0':String(value),type:value===null?'null':typeof value==='number'?'number':typeof value==='boolean'?'boolean':'text'};
    };
    const inverse=expression.kind==='unary'&&expression.operator==='!';if(inverse&&expression.kind==='unary')expression=expression.operand;
    if(expression.kind==='call'&&expression.callee.kind==='member'&&expression.callee.key.kind==='literal'&&expression.callee.key.value.type==='string'){
      const target=property(expression.callee.object),name=expression.callee.key.value.value;
      if(!target)return undefined;
      const methodIds:BaseFilterOperator[]=['startsWith','notStartsWith','endsWith','notEndsWith','isEmpty','isNotEmpty','contains','notContains','containsAny','notContainsAny','containsAll','notContainsAll','linksTo','notLinksTo','matches','notMatches',...BASE_FILE_FILTER_OPERATORS.map(item=>item.id)];
      const operator=methodIds.find(id=>{const item=baseFilterMethod(id);return item?.method===name&&!!item.inverse===inverse;});
      if(!operator)return undefined;
      const method=baseFilterMethod(operator)!;
      if(method.arity==='none'?expression.args.length!==0:method.arity==='one'?expression.args.length!==1:expression.args.length===0)return undefined;
      const args=expression.args.map(item=>literal(item));
      const file=baseFileFilterOperator(operator);
      if(file){if(target!=='file.file'||args.some(value=>typeof value!=='string'))return undefined;const values=args as string[];return {property:target,operator,text:values[0]??'',type:'text',values};}
      if(target==='file.file')return undefined;
      if(method.arity==='none')return {property:target,operator,text:'',type:'text'};
      if(args.length===1&&!Array.isArray(args[0]))return scalar(target,operator,args[0]);
      return {property:target,operator,text:'',type:'list',arguments:args};
    }
    if(inverse||expression.kind!=='binary')return undefined;
    const target=property(expression.left),operator=({'==':'eq','!=':'neq','<':'lt','<=':'lte','>':'gt','>=':'gte'} as Record<string,BaseFilterOperator>)[expression.operator];
    if(!target||target==='file.file'||!operator)return undefined;
    return scalar(target,operator,literal(expression.right));
  }catch{return undefined;}
}
