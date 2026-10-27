// Disposable interactive prototype. This launcher exits; Node is not an app host.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const directory=path.dirname(fileURLToPath(import.meta.url));
const executable=path.join(directory,'shell/target/release/zorid-tauri-native-prototype');
if(!fs.existsSync(executable))throw Error('Build the frontend and release shell first; see prototypes/tauri-native/README.md.');
const pointer='/private/tmp/zorid-tauri-native-interactive.json';
let session;
try{session=JSON.parse(fs.readFileSync(pointer,'utf8'));if(!session.root.startsWith('/private/tmp/zorid-tauri-native-play-')||!fs.existsSync(session.root))session=undefined;}catch{}
if(session?.pid){try{process.kill(session.pid,0);console.log('Prototype already running. Vault: '+session.root+'/vault');process.exit(0);}catch{}}
if(!session){
 const root=fs.mkdtempSync('/private/tmp/zorid-tauri-native-play-');
 fs.mkdirSync(path.join(root,'vault'));fs.mkdirSync(path.join(root,'data'));
 fs.writeFileSync(path.join(root,'vault/Welcome.md'),'# Welcome\n\nEdit this note, create another, or open it in a second tab. This is a disposable prototype vault.\n');session={root};
}
const fd=fs.openSync(path.join(session.root,'app.log'),'a');
const child=spawn(executable,[],{env:{...process.env,ZORID_NATIVE_VAULT:path.join(session.root,'vault'),ZORID_NATIVE_DATA:path.join(session.root,'data'),ZORID_NATIVE_BENCH:'0'},stdio:['ignore',fd,fd],detached:true});
fs.closeSync(fd);child.unref();session.pid=child.pid;
fs.writeFileSync(pointer,JSON.stringify(session));console.log('Opened native Tauri prototype. Disposable vault: '+path.join(session.root,'vault'));
