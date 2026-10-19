/** Hand-specified arithmetic expectations. Never imports an evaluator/parser. */
import assert from 'node:assert/strict';
import {extras,noteId,notePath,CLOCK_MS} from './workload.mjs';
export const ORACLE_VERSION='zorid-generated-bases-v1';
export const CLOCK_ORACLE=Object.freeze({file:'accepted-expressions.json',sha256:'fbbcd720ff13ae589a4abafbf05f5085bb7305a44834060eddfcdf407f775352',id:'clock-pinned',expression:'today().toString()',clockMs:1705314030000,timezone:'UTC',expected:'2024-01-15'});
export const SOURCE=Object.freeze({localStoreId:'s1-generated-bases-store',watermark:'1'});
export const SNAPSHOT=Object.freeze({localStoreId:'s1-generated-bases-store',generationEpoch:'s1-generated-bases-epoch',generation:'1',versions:{schema:1,extraction:'zorid-markdown-1:metadata-2',resolver:'link-nfc-lower-segment-utf16-v1',query:'literal-lines-exact-v1'}});
const number=value=>({type:'number',value}),string=value=>({type:'string',value});
const status=i=>['todo','doing','done'][i%3];
const groupKeys=Object.freeze({doing:'base-key-v1:{"type":"string","value":"doing"}',done:'base-key-v1:{"type":"string","value":"done"}',todo:'base-key-v1:{"type":"string","value":"todo"}'});
export const rowWitness=e=>({entryId:e.logicalId,revision:`source-${e.sha256}`,path:e.path});
const view=(name,order,sort=[])=>({type:'table',name,order,...(sort.length?{sort}:{})});
const ascending=[{property:'rank',direction:'ASC'}],descending=[{property:'rank',direction:'DESC'}];
export function generatedPlan(){
  const sparseSource=extras.find(e=>e.logicalId==='base-sparse').bytes.toString('utf8');
  const configurations={
    grouped:{filters:'rank >= 0 && rank < 100',formulas:{doubleRank:'rank * 2'},views:[{...view('Grouped',['file.name','rank','status','formula.doubleRank'],descending),groupBy:{property:'status',direction:'ASC'}}]},
    links:{filters:'rank >= 0 && rank < 100 && file.links.length == 1',formulas:{outgoing:'file.links.length',target:'file.links[0]'},views:[view('Links',['file.name','rank','formula.outgoing','formula.target'],ascending)]},
    context:{filters:'rank >= 0 && rank < 10',formulas:{contextRank:'this.rank'},views:[view('Ascending',['file.name','rank','formula.contextRank'],ascending),view('Descending',['file.name','rank','formula.contextRank'],descending)]},
    clock:{filters:'rank >= 0 && rank < 3',formulas:{today:CLOCK_ORACLE.expression},views:[view('Clock',['file.name','rank','formula.today'],ascending)]},
  };
  const options=(extra={})=>({viewIndex:0,searchTerms:[],ignorePaths:[],maxSteps:2000000,maxScanned:50000,maxRows:10000,maxGroups:5000,maxOutputBytes:8388608,...extra,evaluation:{clockMs:CLOCK_MS,timezone:'UTC',maxSteps:100000,formulas:[],currentRecord:null,...extra.evaluation}});
  return {schemaVersion:1,oracleVersion:ORACLE_VERSION,programs:[{id:'sparse',source:sparseSource},...Object.entries(configurations).map(([id,config])=>({id,source:JSON.stringify(config)}))],invocations:[
    {id:'sparse-first',programId:'sparse',options:options()},
    {id:'sparse-repeat',programId:'sparse',options:options()},
    {id:'formula-sort-group',programId:'grouped',options:options()},
    {id:'relationship-filter',programId:'links',options:options()},
    {id:'current0-ascending',programId:'context',options:options({currentEntryId:noteId(0)})},
    {id:'current1-ascending',programId:'context',options:options({currentEntryId:noteId(1)})},
    {id:'current1-descending',programId:'context',options:options({currentEntryId:noteId(1),viewIndex:1})},
    {id:'fixed-clock',programId:'clock',options:options({evaluation:{clockMs:CLOCK_ORACLE.clockMs,timezone:CLOCK_ORACLE.timezone,maxSteps:100000}})},
  ]};
}
export function expectedGenerated(caseId,manifest){
  assert.ok([100,10000].includes(manifest.noteCount),'only approved100/10000 profiles');
  assert.ok(['sparse-first','sparse-repeat','formula-sort-group','relationship-filter','current0-ascending','current1-ascending','current1-descending','fixed-clock'].includes(caseId),'unknown semantic oracle');
  const entries=new Map(manifest.entries.map(e=>[e.path,e]));
  let indices=Array.from({length:100},(_,i)=>i),properties=['file.name','note.rank'],name='Sparse';
  if(caseId==='formula-sort-group'){indices.reverse();properties.push('note.status','formula.doubleRank');name='Grouped';}
  else if(caseId==='relationship-filter'){indices=indices.filter(i=>i%2===0);properties.push('formula.outgoing','formula.target');name='Links';}
  else if(caseId.startsWith('current')){indices=indices.slice(0,10);if(caseId==='current1-descending')indices.reverse();properties.push('formula.contextRank');name=caseId.endsWith('descending')?'Descending':'Ascending';}
  else if(caseId==='fixed-clock'){indices=indices.slice(0,3);properties.push('formula.today');name='Clock';}
  else assert.ok(['sparse-first','sparse-repeat'].includes(caseId),'unknown semantic oracle');
  const rows=indices.map(i=>{
    const entry=entries.get(notePath(i));assert.ok(entry);
    const values={'file.name':string(`Note-${String(i).padStart(6,'0')}`),'note.rank':number(i)};
    if(caseId==='formula-sort-group'){values['note.status']=string(status(i));values['formula.doubleRank']=number(2*i);}
    if(caseId==='relationship-filter'){
      const next=(i+1)%manifest.noteCount,target=entries.get(notePath(next));assert.ok(target);
      values['formula.outgoing']=number(1);values['formula.target']={type:'link',path:`/${notePath(next).slice(0,-3)}`,target:{entryId:target.logicalId,revision:`source-${target.sha256}`},display:null,external:false};
    }
    if(caseId.startsWith('current'))values['formula.contextRank']=number(caseId==='current0-ascending'?0:1);
    if(caseId==='fixed-clock')values['formula.today']=string(CLOCK_ORACLE.expected);
    return {...rowWitness(entry),values};
  });
  const groups=caseId==='formula-sort-group'?['doing','done','todo'].map(key=>({keyId:groupKeys[key],key:string(key),entryIds:indices.filter(i=>status(i)===key).map(noteId)})):[{keyId:null,key:null,entryIds:rows.map(r=>r.entryId)}];
  const attachment=manifest.entries.find(e=>e.logicalId==='attachment-pixel');assert.ok(attachment);
  return {viewName:name,rows,properties,groups,groupOptions:[],counts:{scanned:manifest.noteCount+3,matched:rows.length,afterGroupOrder:rows.length,afterSearch:rows.length,returned:rows.length},diagnostics:[],relationshipsAvailable:true,metadataComplete:true,
    metadataIssues:[{witness:{entryId:attachment.logicalId,revision:`source-${attachment.sha256}`},exclusion:'binary',diagnostics:[],propertiesUnavailable:false}]};
}
