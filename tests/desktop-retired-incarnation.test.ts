import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createDesktopIndependentDraftProvider} from '../src/platform/desktop-independent-drafts.ts';
import type {DesktopIndependentJournalRequest} from '../src/platform/bridge';

const scope={vaultId:'vault',clientId:'client',incarnationId:'current-renderer'};
const success=(value:unknown)=>({independentJournal:true,schemaVersion:1,ok:true,value});
const rejection=(code='draft_grant_retired',source='main')=>({independentJournal:true,schemaVersion:1,ok:false,error:{code,commitUncertain:false,source}});
function fixture(invoke:(request:DesktopIndependentJournalRequest)=>Promise<unknown>){
  const grant={token:'bound-journal-token',scope:{...scope}};
  const provider=createDesktopIndependentDraftProvider({independentJournal:invoke},'/owned-vault',scope,grant);
  return{provider,grant};
}

test('retirement certificate uses the bound grant and never infers retirement from a differing incarnation ID',async()=>{
  const calls:DesktopIndependentJournalRequest[]=[];let answer=false;
  const f=fixture(async request=>{calls.push(structuredClone(request));return success(answer);});
  assert.equal(typeof f.provider.isRetiredIncarnation,'function');
  f.grant.token='replacement-token';f.grant.scope.vaultId='foreign';
  assert.equal(await f.provider.isRetiredIncarnation!('older-renderer'),false);
  answer=true;assert.equal(await f.provider.isRetiredIncarnation!('older-renderer'),true);
  answer=false;assert.equal(await f.provider.isRetiredIncarnation!(scope.incarnationId),false);
  assert.deepEqual(calls,[
    {vault:'/owned-vault',token:'bound-journal-token',op:'isRetiredIncarnation',args:['older-renderer']},
    {vault:'/owned-vault',token:'bound-journal-token',op:'isRetiredIncarnation',args:['older-renderer']},
    {vault:'/owned-vault',token:'bound-journal-token',op:'isRetiredIncarnation',args:['current-renderer']},
  ]);
});

test('retirement certificate rejects malformed boolean responses rather than returning false',async()=>{
  for(const value of [null,undefined,0,1,'true','false',{},[],new Boolean(true)]){
    const {provider}=fixture(async()=>success(value));
    await assert.rejects(provider.isRetiredIncarnation!('older-renderer'),{code:'invalid_draft_response',source:'protocol'});
  }
});

test('retirement certificate preserves unknown transport and revoked-grant failures as failures',async()=>{
  const lost=fixture(async()=>{throw Error('/private/synthetic-sensitive-path');});
  await assert.rejects(lost.provider.isRetiredIncarnation!('older-renderer'),error=>{
    assert.equal((error as any).code,'draft_transport_lost');assert.equal((error as any).source,'transport');assert.doesNotMatch((error as Error).message,/private|sensitive/);return true;
  });
  const revoked=fixture(async()=>rejection());
  await assert.rejects(revoked.provider.isRetiredIncarnation!('older-renderer'),{code:'draft_grant_retired',source:'main',commitUncertain:false});
  const foreign=fixture(async()=>rejection('draft_grant_retired','foreign'));
  await assert.rejects(foreign.provider.isRetiredIncarnation!('older-renderer'),{code:'invalid_draft_response',source:'protocol'});
});

test('invalid target incarnation is rejected before independent journal IPC',async()=>{
  let calls=0;const {provider}=fixture(async()=>{calls++;return success(true);});
  for(const target of ['',null,{},'../other','a\\b','bad\0id','x'.repeat(257)])await assert.rejects(provider.isRetiredIncarnation!(target as string),{code:'invalid_draft_request'});
  assert.equal(calls,0);
});

test('a fake IPC authority can reject a current grant retired while its certificate request waits',async()=>{
  let resolve!:(value:unknown)=>void;const gate=new Promise<unknown>(yes=>{resolve=yes;});
  const {provider}=fixture(async()=>gate);let settled=false;
  const pending=provider.isRetiredIncarnation!('older-renderer');void pending.then(()=>{settled=true;},()=>{settled=true;});
  await Promise.resolve();assert.equal(settled,false);resolve(rejection());
  await assert.rejects(pending,{code:'draft_grant_retired',source:'main'});
});

test('actual preload routes only the bounded certificate operation through independent journal IPC',async()=>{
  let exposed:any;const calls:{channel:string;request:unknown}[]=[];
  const context=vm.createContext({require(name:string){assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld(_name:string,value:unknown){exposed=value;}},webUtils:{},
    ipcRenderer:{async invoke(channel:string,request:unknown){calls.push({channel,request:structuredClone(request)});return copyIn(success(true));}}};}});
  const copyIn=(value:unknown)=>vm.runInContext('JSON.parse('+JSON.stringify(JSON.stringify(value))+')',context);
  vm.runInContext(fs.readFileSync(new URL('../desktop/preload.cjs',import.meta.url),'utf8'),context);
  const {provider}=fixture(async request=>structuredClone(await exposed.independentJournal(copyIn(request))));
  assert.equal(await provider.isRetiredIncarnation!('older-renderer'),true);
  assert.deepEqual(calls,[{channel:'zorid:independentJournal',request:{vault:'/owned-vault',token:'bound-journal-token',op:'isRetiredIncarnation',args:['older-renderer']}}]);
});
