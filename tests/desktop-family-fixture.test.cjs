'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {WindowBroker}=require('../desktop/window-broker.cjs');
const {RustVaultService}=require('../desktop/rust-vault-service.cjs');
const {createFixtureDispatcher,launchFamilyFixture}=require('../desktop/family-fixture.cjs');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(){
  const mainFrame={url:'file:///fixture.html'},webContents={id:1,mainFrame,isDestroyed:()=>false};
  const window={webContents,isDestroyed:()=>false};
  const broker=new WindowBroker({openVault:()=>assert.fail('No dynamic root selection'),allowedURL:url=>url===mainFrame.url});
  const record=broker.register(window),event={sender:webContents,senderFrame:mainFrame};
  return{broker,record,event};
}

test('fixture authenticates real broker sender/top frame and never accepts renderer configuration',async()=>{
  const f=setup();let calls=0;
  const host=Object.create(RustVaultService.prototype);host.request=()=>{calls++;return Promise.resolve({result:{}});};
  const invoke=createFixtureDispatcher({...f,host,info:{fixture:true,localAuthority:'authority'},isClosing:()=>false});
  assert.equal((await invoke({...f.event,senderFrame:{url:'file:///fixture.html'}},{method:'status'})).ok,false);
  assert.equal((await invoke({...f.event,sender:{id:2}},{method:'status'})).ok,false);
  const unknown=await invoke(f.event,{method:'configure',root:'/other',credentials:'secret'});
  assert.equal(unknown.error.code,'invalid_request');assert.equal(calls,0);
  const info=await invoke(f.event,{method:'info',root:'/ignored'});
  assert.deepEqual(info,{ok:true,result:{fixture:true,localAuthority:'authority'}});
});

test('retired renderer cannot send queued family write, using actual RustVaultService dispatch queue',async()=>{
  const f=setup(),blocked=deferred();let writes=0;
  const host=Object.create(RustVaultService.prototype);
  Object.assign(host,{root:'/fixture',sequence:0n,tail:blocked.promise,ready:Promise.resolve(),queuedCount:0,queuedBytes:0,closing:false,fatal:null,exited:false,
    expect:()=>assert.fail('Retired request must never create an inflight frame'),child:{stdin:{write:()=>{writes++;}}}});
  const invoke=createFixtureDispatcher({...f,host,info:{},isClosing:()=>false});
  const waiting=invoke(f.event,{method:'apply',command:{version:1,request:{operation_id:'op',mutation:{type:'create',id:'entry',path:'a.md',kind:'file'}},create_mode:'text'},bytes:Buffer.from('draft')});
  assert.equal(host.queuedCount,1);
  f.broker.remove(f.record);blocked.resolve();
  const result=await waiting;
  assert.equal(result.ok,false);assert.equal(writes,0);await host.tail;assert.equal(host.queuedCount,0);
});

test('fixture snapshots mutable command/bytes and sanitizes unknown commit errors',async()=>{
  const f=setup(),blocked=deferred();let captured;
  const host=Object.create(RustVaultService.prototype);
  host.request=async(command,bytes,_lease,beforeDispatch)=>{captured={command,bytes};await blocked.promise;beforeDispatch();throw Object.assign(new Error('/secret/path TOKEN'),{code:'host_timeout',commitUncertain:true});};
  const invoke=createFixtureDispatcher({...f,host,info:{},isClosing:()=>false});
  const input={method:'apply',command:{version:1,request:{operation_id:'original',mutation:{type:'create',id:'entry',path:'a',kind:'file'}},create_mode:'binary'},bytes:Buffer.from([0,255])};
  const waiting=invoke(f.event,input);input.command.request.operation_id='changed';input.bytes.fill(7);
  assert.equal(captured.command.family.request.operation_id,'original');assert.deepEqual([...captured.bytes],[0,255]);
  blocked.resolve();assert.deepEqual(await waiting,{ok:false,error:{code:'host_timeout',commitUncertain:true}});
});

class FixtureWindow extends EventEmitter{
  constructor(options){super();this.options=options;this.destroyed=false;this.webContents=new EventEmitter();Object.assign(this.webContents,{id:7,mainFrame:{url:''},isDestroyed:()=>this.destroyed,setWindowOpenHandler:()=>{}});}
  isDestroyed(){return this.destroyed;}
  async loadFile(page){this.webContents.mainFrame.url=require('node:url').pathToFileURL(page).href;}
  destroy(){if(!this.destroyed){this.destroyed=true;this.emit('closed');}}
}

test('fixture window close retires IPC and holds app quit until child drains',async()=>{
  const app=new EventEmitter(),closed=deferred();let quits=0,closeCalls=0,prevented=0;
  app.quit=()=>{const event={preventDefault(){prevented++;}};app.emit('before-quit',event);if(!app.listenerCount('before-quit'))quits++;};
  const handlers=new Map(),ipcMain={handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)};
  const host={identity:async()=>({local_store_id:'authority'}),close:async()=>{closeCalls++;await closed.promise;}};
  const launched=await launchFamilyFixture({app,BrowserWindow:FixtureWindow,ipcMain},{root:'/fixture',executable:'/host',credentials:'/private/config',source:'abcdef0'},{openHost:async(root,options)=>{
    assert.equal(root,'/fixture');assert.equal(options.fixtureSyncConfig,'/private/config');return host;
  }});
  assert.equal(launched.window.options.webPreferences.sandbox,true);assert.equal(launched.window.options.webPreferences.nodeIntegration,false);
  launched.window.destroy();app.quit();await tick();
  assert.equal(closeCalls,1);assert.equal(handlers.size,0);assert.equal(prevented,1);assert.equal(quits,0);
  closed.resolve();await launched.close();assert.equal(quits,1);assert.equal(app.listenerCount('before-quit'),0);
});
