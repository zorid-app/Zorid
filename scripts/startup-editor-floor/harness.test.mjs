import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';

// Execute the shipped entry through its Electron/IPC boundary; never launch an app.
async function mainFixture(){
 const source=await readFile(new URL('./electron-main.cjs',import.meta.url),'utf8');
 const config={directory:'/private/tmp/zorid-editor-floor-vm',profile:'/private/tmp/zorid-editor-floor-vm/profile',mode:'normal-reopen',deadlineMs:800,diagnosticMs:1800,timeoutMs:15000,electronVersion:'44.9.1',fixture:{id:'fixture',path:'/fixture.md',bytes:1024,caret:32}};
 const writes=[],reads=[],handlers=new Map(),timers=[],immediates=[],windows=[];
 const app=new EventEmitter();Object.assign(app,{setPath(){},setName(){},getAppPath:()=>'/fixture/app.asar',isPackaged:true,whenReady:()=>Promise.resolve(),getAppMetrics:()=>[],quit(){app.emit('before-quit');app.emit('will-quit');}});
 class BrowserWindow extends EventEmitter{
  constructor(){super();windows.push(this);const contents=new EventEmitter();Object.assign(contents,{mainFrame:{url:'file:///fixture/app.asar/renderer/index.html'},focus(){},sendInputEvent(){},send(){},setWindowOpenHandler(){},capturePage:async()=>({toPNG:()=>Buffer.alloc(0)})});this.webContents=contents;}
  focus(){}isDestroyed(){return false;}async loadFile(){}
 }
 const ipcMain=new EventEmitter();ipcMain.handle=(name,handler)=>handlers.set(name,handler);
 const fs={readFileSync(file){reads.push(file);return JSON.stringify(config);},writeFileSync(file,text){writes.push({file,text,sync:true});},promises:{async writeFile(file,text){writes.push({file,text,sync:false});},async stat(){return{size:1024,mtimeMs:1};},async readFile(){return'x'.repeat(1024);}}};
 vm.runInNewContext(source,{require(name){if(name==='electron')return{app,BrowserWindow,ipcMain,Menu:{setApplicationMenu(){}}};if(name==='node:fs')return fs;if(name==='node:path')return path;if(name==='node:perf_hooks')return{performance};throw Error(name);},process:{env:{ZORID_EDITOR_FLOOR_CASE:'/config.json',ZORID_EDITOR_FLOOR_CONFIG:JSON.stringify(config),ZORID_EDITOR_FLOOR_SPAWN_EPOCH:String(Date.now())},versions:{electron:'44.9.1'},execPath:'/fixture/EditorFloor'},__dirname:'/fixture/app.asar',Buffer,URL,Set,setTimeout(callback,delay){timers.push({callback,delay});return timers.length;},setImmediate(callback){immediates.push(callback);}},{filename:'electron-main.cjs'});
 await Promise.resolve();await Promise.resolve();
 const message={sender:windows[0].webContents,senderFrame:windows[0].webContents.mainFrame};
 return{writes,reads,handlers,timers,immediates,message,event:(name,data)=>ipcMain.emit('floor:event',message,name,data)};
}

test('packaged timing events and fixture load do not rewrite reports or read runtime provenance',async()=>{
 const fixture=await mainFixture();
 fixture.event('editor-ready',{at:123,id:'fixture'});fixture.event('input-applied',{name:'ready',appliedEpoch:124});
 await fixture.handlers.get('floor:load')(fixture.message);
 assert.equal(fixture.writes.length,0,'measurement must not include report writes');
 assert.equal(fixture.reads.length,0,'parent-supplied config must not incur a measured config read');
});
test('terminal result flushes buffered milestones and normal quit proof',async()=>{
 const fixture=await mainFixture();fixture.event('editor-ready',{at:123,id:'fixture'});
 await fixture.handlers.get('floor:result')(fixture.message,{errors:[],probes:[]});
 for(const callback of fixture.immediates)callback();await Promise.resolve();await Promise.resolve();
 const reports=fixture.writes.filter(row=>row.file.endsWith('/app-report.json'));
 assert.ok(reports.length>0);const final=JSON.parse(reports.at(-1).text);
 assert.ok(final.events.some(event=>event.kind==='main-module-entry'));assert.ok(final.events.some(event=>event.kind==='editor-ready'));
 assert.equal(final.normalQuitObserved,true);
});
