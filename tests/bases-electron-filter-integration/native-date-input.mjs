// Adapted from our original trusted-input reference helper, not Obsidian code:
// /private/tmp/zorid-obsidian-1.14.5-runtime-20261026-005/{ui,common}.mjs.
import assert from 'node:assert/strict';

function segmentKind(name){
  const text=String(name).toLowerCase();
  if(/am\/pm|day.?period/.test(text))return 'period';
  if(/year|yyyy/.test(text))return 'year';
  if(/month|\bmm\b/.test(text)&&!/minute/.test(text))return 'month';
  if(/\bday\b|\bdd\b/.test(text))return 'day';
  if(/hour/.test(text))return 'hour';
  if(/minute/.test(text))return 'minute';
  if(/second/.test(text))return 'second';
  return null;
}
export function nativeSegments(record){
  const segments=record.nodes.filter(node=>!node.ignored&&node.role?.value==='spinbutton').map(node=>({kind:segmentKind(node.name?.value),name:node.name?.value,focused:node.properties?.some(property=>property.name==='focused'&&property.value?.value===true)===true}));
  assert.ok(segments.length>=3&&segments.every(segment=>segment.kind),'Understood actual native AX segments');
  const kinds=segments.map(segment=>segment.kind);assert.equal(new Set(kinds).size,kinds.length,'Unique native segment kinds');
  for(const kind of ['year','month','day'])assert.ok(kinds.includes(kind),'Native '+kind+' segment');
  if(record.admission.type==='date')assert.equal(segments.length,3,'Date exposes only Y/M/D');
  else{assert.equal(record.admission.type,'datetime-local');for(const kind of ['hour','minute'])assert.ok(kinds.includes(kind),'Native '+kind+' segment');}
  assert.equal(segments.filter(segment=>segment.focused).length,1,'Exactly one actual focused native segment');
  return segments;
}
export function nativeLiteralParts(value){
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
  assert.ok(match,'Native recipe requires an exact ISO date or minute datetime, without seconds, fraction or timezone');
  const [,year,month,day,hour,minute]=match;
  assert.ok(Number(year)>0&&Number(month)>=1&&Number(month)<=12&&Number(day)>=1&&Number(day)<=31,'Native date fields in range');
  if(hour!==undefined)assert.ok(Number(hour)<=23&&Number(minute)<=59,'Native time fields in range');
  return{type:hour===undefined?'date':'datetime-local',year,month,day,hour,minute,second:'00'};
}
async function field(c,selector,type){
  return c.ui.wait(`const matches=[...document.querySelectorAll(${JSON.stringify(selector)})];if(matches.length!==1)return false;const e=matches[0];if(e.tagName!=='INPUT'||e.type!==${JSON.stringify(type)}||!e.isConnected||!e.getClientRects().length||e.closest('[hidden],[inert],[aria-disabled="true"]')||e.matches(':disabled'))return false;return {type:e.type,value:e.value,valid:e.validity.valid,focused:e===document.activeElement,step:e.step,min:e.min,max:e.max};`,'One visible enabled exact native '+type+' operand');
}
async function nativeAX(c,selector,type){
  const admission=await field(c,selector,type);assert.equal(admission.focused,true,'Native operand actually focused');
  const {root}=await c.cdp.call('DOM.getDocument',{depth:1}),{nodeId}=await c.cdp.call('DOM.querySelector',{nodeId:root.nodeId,selector});assert.ok(nodeId);
  const {node}=await c.cdp.call('DOM.describeNode',{nodeId}),{nodes}=await c.cdp.call('Accessibility.getFullAXTree');
  const roots=nodes.filter(item=>!item.ignored&&item.backendDOMNodeId===node.backendNodeId);assert.equal(roots.length,1,'One actual native AX input root');
  const byId=new Map(nodes.map(item=>[item.nodeId,item])),descendants=[],seen=new Set();
  function visit(item){assert.ok(item&&!seen.has(item.nodeId)&&seen.size<64,'Bounded complete native AX subtree');seen.add(item.nodeId);descendants.push(item);for(const id of item.childIds??[])visit(byId.get(id));}
  visit(roots[0]);const record={admission,backendNodeId:node.backendNodeId,nodes:descendants};
  c.evidence.actions.push({action:'native-filter-date-AX',selector,record,at:Date.now()});return record;
}
async function character(c,key){
  const code=/\d/.test(key)?'Digit'+key:'Key'+key.toUpperCase(),windowsVirtualKeyCode=key.toUpperCase().charCodeAt(0);
  await c.cdp.call('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode,modifiers:0});
  await c.cdp.call('Input.dispatchKeyEvent',{type:'char',key,text:key,unmodifiedText:key,modifiers:0});
  await c.cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode,modifiers:0});
  c.evidence.actions.push({action:'native-filter-date-character',key,code,at:Date.now()});
}
export async function enterNativeDate(c,selector,value){
  const parts=nativeLiteralParts(value),before=await field(c,selector,parts.type);assert.equal(before.value,'','Fresh native date operand is empty');assert.equal(before.valid,true);
  await c.ui.click(selector);
  let record=await nativeAX(c,selector,parts.type),segments=nativeSegments(record);const backend=record.backendNodeId,order=segments.map(segment=>segment.kind);
  const observe=async()=>{record=await nativeAX(c,selector,parts.type);assert.equal(record.backendNodeId,backend,'The same actual operand remains mounted');segments=nativeSegments(record);assert.deepEqual(segments.map(segment=>segment.kind),order,'Actual native segment order remains unchanged');return segments.findIndex(segment=>segment.focused);};
  // A real click may select the middle segment. Move only across the observed
  // preceding segments, never infer display order from a locale or ISO string.
  for(let index=segments.findIndex(segment=>segment.focused);index>0;index--){await c.ui.key('ArrowLeft');assert.equal(await observe(),index-1,'Actual native segment moves left');}
  assert.equal(await observe(),0,'Observed first native segment focused before typing');
  const period=order.includes('period'),values={...parts,hour:period?String(Number(parts.hour)%12||12).padStart(2,'0'):parts.hour,period:Number(parts.hour)<12?'a':'p'};
  for(const [index,kind]of order.entries()){
    assert.equal(await observe(),index,'Typing the exact observed '+kind+' segment');assert.ok(values[kind]);
    for(const key of values[kind])await character(c,key);
    if(index<order.length-1){const focused=await observe();if(focused===index){await c.ui.key('Tab');assert.equal(await observe(),index+1,'Real Tab reaches the next observed segment');}else assert.equal(focused,index+1,'Native typing advances only to the next observed segment');}
  }
  const entered=await field(c,selector,parts.type);assert.equal(entered.focused,true);assert.equal(entered.valid,true);assert.equal(entered.value,value,'Full original native ISO value before blur');
  for(let count=0;count<order.length+2;count++){if(!(await field(c,selector,parts.type)).focused)break;await c.ui.key('Tab');}
  const blurred=await field(c,selector,parts.type);assert.equal(blurred.focused,false,'Real native Tab blur occurred');assert.equal(blurred.valid,true);assert.equal(blurred.value,value,'Full original native ISO value after blur');
  c.evidence.checks.push({name:'native-filter-date-exact-trusted-input',selector,value,order,before,entered,blurred});
}
