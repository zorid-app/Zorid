import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {runtimeAssets} from '../vite.config.mjs';

test('dev runtime assets retain bytes, MIME types and exact-path boundaries',async()=>{
  let middleware;
  const data=Buffer.from('<svg/>');
  await runtimeAssets(new Map([['lib/pdfjs/icon.svg',data],['lib/mathjax/font.woff2',Buffer.from([1,2])]])).configureServer({middlewares:{use(handler){middleware=handler;}}});
  const request=(url,method='GET')=>{let next=false,body;const headers={};const res={statusCode:200,setHeader(name,value){headers[name]=value;},end(value){body=value;}};middleware({url,method},res,()=>{next=true;});return {next,body,headers,status:res.statusCode};};
  assert.deepEqual(request('/lib/pdfjs/icon.svg').body,data);
  assert.equal(request('/lib/pdfjs/icon.svg').headers['Content-Type'],'image/svg+xml');
  assert.equal(request('/lib/mathjax/font.woff2').headers['Content-Type'],'font/woff2');
  assert.equal(request('/lib/pdfjs/icon.svg','HEAD').body,undefined);
  assert.equal(request('/lib/pdfjs/icon.svg','POST').status,405);
  for(const url of ['/lib/pdfjs/missing.svg','/lib/pdfjs/../../package.json','/lib/pdfjs/%ZZ'])assert.equal(request(url).next,true);
});
test('dev Rust add/change/delete events regenerate matched module assets once',async()=>{
  for(const [event,relative] of [['add','crates/new/src/new.rs'],['unlink','crates/old/Cargo.toml'],['change','Cargo.lock']]){
    const watcher=new EventEmitter();watcher.add=()=>{};let restarts=0;
    const plugin=runtimeAssets(new Map(),{core:true});
    await plugin.configureServer({middlewares:{use(){}},watcher,restart(){restarts++;return Promise.resolve();}});
    watcher.emit('change',fileURLToPath(new URL('../README.md',import.meta.url)));assert.equal(restarts,0);
    const file=fileURLToPath(new URL('../'+relative,import.meta.url));watcher.emit(event,file);watcher.emit(event,file);assert.equal(restarts,1);
  }
  assert.throws(()=>runtimeAssets(new Map(),{core:true}).configResolved({build:{watch:{}}}),/Vite dev server/);
});
