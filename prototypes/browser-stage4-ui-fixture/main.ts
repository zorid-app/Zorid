import {BrowserCoreRuntime} from '../../src/platform/browser-core-runtime.ts';
import {admitBrowserClient} from '../../src/platform/browser-client-admission.ts';
import type {BrowserClientContext} from '../../src/platform/browser-client-admission.ts';
import {DEFAULT_BROWSER_DATABASE,defaultBrowserAdapter} from '../../src/platform/browser-default.ts';

declare const __STAGE4_FIXTURE_SOURCE__:string;
declare const __STAGE4_FIXTURE_MODULE_PATH__:string;
const output=document.getElementById('report')!,button=document.getElementById('seed') as HTMLButtonElement;
const encoder=new TextEncoder();
let lastReport:Record<string,unknown>={fixtureSource:__STAGE4_FIXTURE_SOURCE__,origin:location.origin,database:DEFAULT_BROWSER_DATABASE};
function show(value:Record<string,unknown>){lastReport=value;output.textContent=JSON.stringify(value,null,2);}
function assert(value:unknown,message:string):asserts value{if(!value)throw new Error(message);}
function definition(folder:string):string {
  const columns=['file.name','status','color','formula.proofDate','file.links','formula.contextName'];
  const views=[['table','Table'],['kanban','Board'],['list','List'],['cards','Cards']];
  return [
    'filters:',
    '  and:',
    `    - 'file.inFolder("${folder}")'`,
    `    - 'file.ext == "md"'`,
    'formulas:',
    `  proofDate: "date('2026-10-18')"`,
    '  contextName: "this.file.name"',
    'views:',
    ...views.flatMap(([type,name])=>[
      `  - type: ${type}`,`    name: ${name}`,
      '    groupBy:','      property: status','      direction: ASC',
      `    groupOrder: [2, '2']`,'    order:',...columns.map(column=>`      - ${column}`),
    ]),'',
  ].join('\n');
}
async function release(runtime:BrowserCoreRuntime,consumer?:BrowserClientContext):Promise<void>{
  let failure:unknown;
  if(consumer){
    try{await consumer.recoverCommands?.();}catch(error){failure=error;}
    try{await consumer.release(()=>{});}catch(error){failure??=error;}
  }
  runtime.close();if(failure)throw failure;
}
async function seed():Promise<Record<string,unknown>>{
  const suffix=crypto.randomUUID().slice(0,8),folder=`Stage4 proof ${suffix}`,clientId=crypto.randomUUID();
  const paths={folder,number:`${folder}/Number.md`,string:`${folder}/String.md`,base:`${folder}/All.base`};
  const literal=`Stage4 needle ${suffix}`;
  const files=[
    {path:paths.number,text:`---\nstatus: 2\ncolor: blue\n---\n# Number\n\n${literal}\n`},
    {path:paths.string,text:`---\nstatus: '2'\ncolor: red\n---\n# String\n\n[[Number]]\n\n${literal}\n`},
    {path:paths.base,text:definition(folder)},
  ];
  const base={fixtureSource:__STAGE4_FIXTURE_SOURCE__,origin:location.origin,database:DEFAULT_BROWSER_DATABASE,clientId,paths,literal};
  const created:string[]=[],verified:{path:string;entryId:string;revision:string;bytes:number;sha256:string;rawBytesPreserved:true}[]=[];
  show({...base,status:'running',phase:'open production consumer',created,verified});
  const runtime=await BrowserCoreRuntime.open({database:DEFAULT_BROWSER_DATABASE,clientId,allowNewVault:true,initializeLocal:true,
    wasmModuleUrl:new URL(__STAGE4_FIXTURE_MODULE_PATH__,document.baseURI).href,timeoutMs:60000});
  let consumer:BrowserClientContext|undefined,result:Record<string,unknown>|undefined,failure:unknown;
  try{
    consumer=admitBrowserClient(runtime,{assertOwner:()=>runtime.assertActive()});
    const adapter=defaultBrowserAdapter(runtime,consumer);assert(adapter.createText,'Production atomic create capability is required');
    await adapter.mkdir(folder);created.push(folder);
    for(const file of files){
      show({...base,status:'running',phase:`create ${file.path}`,created:[...created],verified:[...verified]});
      await adapter.createText(file.path,file.text);created.push(file.path);
    }
    for(const file of files){
      const row=await runtime.readEntry(file.path),expected=encoder.encode(file.text);
      assert(row?.entry.path===file.path&&row.entry.kind==='file'&&row.bytes instanceof Uint8Array,'Committed fixture source is unavailable');
      assert(row.bytes.length===expected.length&&row.bytes.every((byte,index)=>byte===expected[index]),'Committed fixture bytes differ');
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',row.bytes as Uint8Array<ArrayBuffer>))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
      verified.push({path:file.path,entryId:row.entry.id,revision:row.entry.revision,bytes:row.bytes.length,sha256,rawBytesPreserved:true});
    }
    const manifest=await fetch(new URL('manifest.json',new URL(__STAGE4_FIXTURE_MODULE_PATH__,document.baseURI))).then(response=>{assert(response.ok,'WASM build manifest is unavailable');return response.json();});
    result={...base,status:'passed',created,verified,rawBytesPreserved:true,wasm:manifest,views:['Table','Board','List','Cards'],
      expected:{rows:2,statusTypes:['number 2',"string '2'"],groups:2,date:'2026-10-18',numberColor:'blue',stringColor:'red',link:`${paths.string} -> ${paths.number}`,currentFile:'All.base'},
      next:'Open All.base in the normal app and verify all four views, typed groups, date, links and search. Seeding alone is not UI acceptance.'};
  }catch(error){failure=error;}
  let consumerReleased=false;try{await release(runtime,consumer);consumerReleased=true;}catch(error){failure??=error;}
  if(failure){show({...base,status:'failed',created,verified,consumerReleased});throw failure;}
  return {...result,consumerReleased:true};
}
button.addEventListener('click',async()=>{
  if(button.disabled)return;button.disabled=true;
  try{show(await seed());}catch(error){const row=error as {code?:unknown;message?:unknown};show({...lastReport,status:'failed',code:typeof row?.code==='string'?row.code:'fixture_error',message:String(row?.message??error).slice(0,512)});}
  finally{button.disabled=false;}
});
