import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
const files=new Map([['/',['dist/index.html','text/html']],['/main.js',['dist/main.js','text/javascript']]]);
createServer(async(req,res)=>{const file=files.get(req.url);if(!file){res.writeHead(404);res.end();return;}try{res.setHeader('Content-Type',file[1]);res.setHeader('Cache-Control','no-store');res.end(await readFile(file[0]));}catch{res.writeHead(503);res.end('Build prototype first');}}).listen(8793,'127.0.0.1',()=>console.log('Browser proof http://127.0.0.1:8793/ → Rust RPC127.0.0.1:8792'));
