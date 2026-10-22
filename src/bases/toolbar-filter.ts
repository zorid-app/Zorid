import { baseFileFilterOperator, serializeFilterCondition, decodeFilterCondition } from './toolbar-config.ts';
import type { BaseFilterCondition } from './toolbar-config.ts';
import {baseFilterMethod} from './toolbar-filter-types.ts';

/** Persisted filter syntax is never optimized using a client evaluator. */
export type BaseFilterNode = string | {and:BaseFilterNode[]} | {or:BaseFilterNode[]} | {not:BaseFilterNode[]};
export type BaseFilterConjunction = 'and' | 'or' | 'not';
export interface BaseFilterDraftCondition {
  kind:'condition';
  fields?:BaseFilterCondition;
  source?:string;
  acceptedSource?:string;
  advanced:boolean;
  problem?:string;
}
export interface BaseFilterDraftGroup {
  kind:'group';
  conjunction:BaseFilterConjunction;
  children:BaseFilterDraftNode[];
  /** A persisted empty OR is false; a new empty group is only a local draft. */
  persistedEmpty:boolean;
  implicit?:boolean;
}
export type BaseFilterDraftNode = BaseFilterDraftCondition | BaseFilterDraftGroup;

export function newBaseFilterCondition():BaseFilterDraftCondition {
  return {kind:'condition',fields:{property:'file.file',operator:'hasLink',text:'',type:'text',values:[]},advanced:false};
}
export function newBaseFilterGroup(conjunction:BaseFilterConjunction='and'):BaseFilterDraftGroup {
  return {kind:'group',conjunction,children:[newBaseFilterCondition()],persistedEmpty:false};
}
function draft(source:BaseFilterNode):BaseFilterDraftNode {
  if(typeof source==='string')return {kind:'condition',source,acceptedSource:source,fields:decodeFilterCondition(source),advanced:!decodeFilterCondition(source)};
  const conjunction=Object.keys(source)[0] as BaseFilterConjunction;
  const children=(source as Record<BaseFilterConjunction,BaseFilterNode[]>)[conjunction];
  return {kind:'group',conjunction,children:children.length?children.map(draft):[newBaseFilterCondition()],persistedEmpty:children.length===0};
}
export function createBaseFilterDraft(source:BaseFilterNode|undefined):BaseFilterDraftGroup {
  if(source===undefined)return newBaseFilterGroup();
  const node=draft(source);
  return node.kind==='group'?node:{kind:'group',conjunction:'and',children:[node],persistedEmpty:false,implicit:true};
}
export function updateBaseFilterCondition(node:BaseFilterDraftCondition,fields:BaseFilterCondition,issue?:{incomplete?:boolean;error?:string}):void {
  node.fields={...fields,...(fields.values?{values:[...fields.values]}:{}),...(fields.arguments?{arguments:structuredClone(fields.arguments)}:{})};node.advanced=false;node.problem=issue?.error;
  if(issue?.error)return;
  if(issue?.incomplete){node.source=undefined;return;}
  const method=baseFilterMethod(fields.operator),file=baseFileFilterOperator(fields.operator),values=fields.values??[fields.text];
  // Rendering never mutates authored literals. A control must explicitly report
  // an incomplete edit; zero-argument methods and explicit null/list are complete.
  const typed=Object.hasOwn(fields,'operand')||fields.arguments!==undefined;
  const missing=!typed&&method?.arity!=='none'&&(file?values.length===0||values.some(value=>value.length===0)
    :!['set','unset'].includes(fields.operator)&&fields.text.length===0);
  if(missing){node.source=undefined;return;}
  try{node.source=serializeFilterCondition(fields);}
  catch(error){node.problem=error instanceof Error?error.message:String(error);}
}
export function updateBaseFilterExpression(node:BaseFilterDraftCondition,source:string):void {
  node.advanced=true;node.source=source.length?source:undefined;node.problem=undefined;
}
export function readBaseFilterDraft(node:BaseFilterDraftNode):BaseFilterNode|undefined {
  if(node.kind==='condition'){
    if(node.problem)throw Error(node.problem);
    if(node.source===undefined&&node.acceptedSource!==undefined)throw Error('Finish the existing filter value or explicitly remove this filter.');
    return node.source;
  }
  const children=node.children.map(readBaseFilterDraft).filter((value):value is BaseFilterNode=>value!==undefined);
  if(!children.length&&!node.persistedEmpty)return undefined;
  if(node.implicit&&node.conjunction==='and'&&children.length===1)return children[0];
  return node.conjunction==='and'?{and:children}:node.conjunction==='or'?{or:children}:{not:children};
}
/** Capture the submitted identities, not queued controls changed during saving. */
export function captureBaseFilterAcknowledgement(root:BaseFilterDraftNode):()=>void {
  const conditions:Array<[BaseFilterDraftCondition,string]>=[],groups:Array<[BaseFilterDraftGroup,boolean]>=[];
  const visit=(node:BaseFilterDraftNode)=>{
    const source=readBaseFilterDraft(node);if(source===undefined)return;
    if(node.kind==='condition'){conditions.push([node,source as string]);return;}
    groups.push([node,typeof source!=='string'&&Object.values(source)[0].length===0]);
    node.children.forEach(visit);
  };visit(root);
  return ()=>{for(const [node,source]of conditions)node.acceptedSource=source;for(const [node,empty]of groups)node.persistedEmpty=empty;};
}
export function baseFilterCount(source:BaseFilterNode|undefined):number {
  return source===undefined?0:typeof source==='string'?1:Object.values(source)[0].length;
}
