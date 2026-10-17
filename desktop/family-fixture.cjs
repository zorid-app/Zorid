'use strict';
// Explicit verification mode within the real Electron app entry. This does not
// install a vault adapter or resume the paused durable editor consumer.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { RustVaultService } = require('./rust-vault-service.cjs');
const { WindowBroker } = require('./window-broker.cjs');
const channel = 'zorid-family-fixture:invoke';
const maxBody = 16 * 1024 * 1024;
const failure = code => Object.assign(new Error('Desktop core fixture request failed.'), { code });

/** Same captured sender/generation is checked at acceptance AND after the host
 * transport's queue wait, immediately before the request is written to stdin. */
function createFixtureDispatcher({ broker, record, host, info, isClosing }) {
  return async (event, input) => {
    try {
      const generation = record.generation;
      const check = () => {
        if (isClosing() || broker.authenticate(event) !== record || record.generation !== generation) throw failure('fixture_not_admitted');
      };
      check();
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_request');
      // IPC arguments are already cloned by Electron; take our own immutable
      // request snapshot before subsequent awaits and bound raw body copying.
      if (input.method === 'apply' && (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > maxBody)) throw failure('request_limit');
      const request = structuredClone(input);
      const guarded = Object.create(host);
      guarded.request = (command, bytes) => { check(); return host.request(command, bytes, undefined, check); };
      let result;
      switch (request.method) {
        case 'info': result = info; break;
        case 'enroll': result = await guarded.fixtureFamilyEnroll(); break;
        case 'status': result = await guarded.fixtureFamilyStatus(); break;
        case 'sync': result = await guarded.fixtureFamilyOnce({maxPush:request.maxPush,maxPages:request.maxPages}); break;
        case 'list': result = await guarded.listSnapshot(); break;
        case 'read':
          if (typeof request.entryId !== 'string') throw failure('invalid_request');
          result = await guarded.readPresentedById(request.entryId); break;
        case 'apply': result = await guarded.fixtureFamilyApply(request.command, request.bytes); break;
        default: throw failure('invalid_request');
      }
      return {ok:true,result};
    } catch(error) {
      const code = typeof error?.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'fixture_request_failed';
      // Never serialize underlying errors, native paths, credential contents or
      // stacks. Unknown commits retain the original operation and bytes.
      return {ok:false,error:{code,commitUncertain:error?.commitUncertain===true}};
    }
  };
}
async function launchFamilyFixture({app,BrowserWindow,ipcMain}, config, {openHost=RustVaultService.open.bind(RustVaultService)}={}) {
  if (!config || !['root','executable','credentials'].every(key=>typeof config[key]==='string'&&path.isAbsolute(config[key]))
    || typeof config.source !== 'string' || !/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(config.source)) throw failure('invalid_fixture_configuration');
  // Capture trusted startup configuration before awaiting core initialization.
  const root=config.root, executable=config.executable, credentials=config.credentials, source=config.source;
  const host=await openHost(root,{executable,fixtureSyncConfig:credentials,timeoutMs:60000});
  let window, broker, record, closing=false, allowQuit=false, shutdown;
  const page=path.join(__dirname,'family-fixture.html'), pageURL=pathToFileURL(page).href;
  const allowedURL = url => url === pageURL;
  const onBeforeQuit = event => { if (!allowQuit) { event.preventDefault();void stop(); } };
  const stop = () => {
    if(shutdown)return shutdown;
    closing=true;
    if(record)broker.remove(record);
    ipcMain.removeHandler(channel);
    shutdown=(async()=>{
      try { await host.close(); }
      finally {
        broker?.dispose();
        if(window&&!window.isDestroyed())window.destroy();
        allowQuit=true;
        app.removeListener('before-quit',onBeforeQuit);
        app.quit();
      }
    })();
    return shutdown;
  };
  try {
    const identity=await host.identity();
    const info=Object.freeze({fixture:true,source,localAuthority:identity.local_store_id,
      versions:{electron:process.versions.electron??null,chrome:process.versions.chrome??null,node:process.versions.node}});
    broker=new WindowBroker({openVault:()=>{throw failure('fixture_fixed_scope');},allowedURL});
    window=new BrowserWindow({width:1000,height:850,title:'Zorid — Rust core verification',
      webPreferences:{preload:path.join(__dirname,'family-fixture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    record=broker.register(window,{primary:true,initialState:'core-fixture'});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{if(!allowedURL(url))event.preventDefault();});
    window.webContents.on('will-attach-webview',event=>event.preventDefault());
    ipcMain.handle(channel,createFixtureDispatcher({broker,record,host,info,isClosing:()=>closing}));
    app.on('before-quit',onBeforeQuit);
    window.on('closed',()=>void stop());
    await window.loadFile(page);
    return {window,close:stop};
  } catch(error) {
    await stop();throw error;
  }
}
module.exports = {launchFamilyFixture,createFixtureDispatcher};
