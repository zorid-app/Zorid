// Reproducible production renderer for both native prototype shells.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'../..'),require=createRequire(import.meta.url);
const vite=path.join(path.dirname(require.resolve('vite/package.json')),'bin/vite.js');
const result=spawnSync(process.execPath,[vite,'build','--mode','native','--outDir',path.join(directory,'dist')],{cwd:root,stdio:'inherit'});
if(result.status!==0)process.exit(result.status||1);
const script=await fs.readFile(path.join(directory,'bench/memory-workload.js'),'utf8');
await fs.writeFile(path.join(directory,'dist/native-bench.js'),'if(window.__ZORID_NATIVE_BENCH_ENABLED__){\n'+script+'\n}');
const index=path.join(directory,'dist/index.html');
let html=await fs.readFile(index,'utf8');
// Required by Tauri's native IPC custom protocol; no remote server is added.
html=html.replace("connect-src 'self'", "connect-src 'self' ipc: http://ipc.localhost");
html=html.replace('<script type="module"','<script src="./native-bench.js"></script><script type="module"');
await fs.writeFile(index,html);
