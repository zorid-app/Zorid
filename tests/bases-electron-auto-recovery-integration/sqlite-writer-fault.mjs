// A real, campaign-local writer lock. No schema or data writes, Native replies,
// product APIs, client leases, or fault-mode hooks are introduced here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';

const helper=fileURLToPath(import.meta.url),applicationId=0x5a4f5244,schemaVersion=20;
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const identity=stat=>{const value={dev:stat.dev,ino:stat.ino,uid:stat.uid,nlink:stat.nlink};for(const field of Object.values(value))assert.ok(Number.isSafeInteger(field));return value;};
const same=(actual,expected,label)=>assert.deepEqual(actual,expected,label+' identity changed');
async function regular(file){const stat=await fs.lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink(),'SQLite path must be a regular nonsymlink file');assert.equal(stat.uid,process.getuid(),'SQLite file must be owned by this fixture user');assert.equal(stat.nlink,1,'SQLite fixture files cannot have hard-link aliases');assert.equal(await fs.realpath(file),file);return identity(stat);}
async function sidecars(database){const result=[];for(const suffix of ['-wal','-shm','-journal']){const file=database+suffix;try{result.push({path:file,...await regular(file)});}catch(error){if(error.code!=='ENOENT')throw error;}}return result;}
/** Authenticate exactly this runner's already-created disposable Native DB. */
export async function authenticateSqliteWriter({vault,outputDirectory},expected){
  for(const value of [vault,outputDirectory])assert.ok(typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&!value.split(path.sep).includes('..'),'Canonical absolute owned paths required');
  assert.equal(await fs.realpath(outputDirectory),outputDirectory);assert.equal(vault,path.join(outputDirectory,'disposable','bases-native-recovery'));assert.equal(await fs.realpath(vault),vault);
  const directories=[];let current=path.parse(outputDirectory).root;
  for(const part of path.join(vault,'.zorid').slice(current.length).split(path.sep)){
    current=path.join(current,part);const stat=await fs.lstat(current);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'SQLite ancestors cannot be symlinks');assert.equal(await fs.realpath(current),current);
    if(current===outputDirectory||current.startsWith(outputDirectory+path.sep)){assert.equal(stat.uid,process.getuid(),'Owned fixture directories require the fixture user');const {nlink:unused,...directoryIdentity}=identity(stat);directories.push({path:current,...directoryIdentity});}
  }
  const database=path.join(vault,'.zorid','vault.sqlite'),snapshot={directories,database:{path:database,...await regular(database)},sidecars:await sidecars(database)};
  if(expected){same(snapshot.directories,expected.directories,'Owned fixture directories');same(snapshot.database,expected.database,'Original SQLite database');for(const before of expected.sidecars){const now=snapshot.sidecars.find(row=>row.path===before.path);assert.ok(now,'Previously existing SQLite sidecar disappeared before open');same(now,before,'Existing SQLite sidecar');}}
  return freeze(snapshot);
}
async function verifyExistingSidecars(snapshot){for(const before of snapshot.sidecars)same({path:before.path,...await regular(before.path)},before,'Pinned SQLite sidecar');}
function send(value){process.stdout.write(JSON.stringify(value)+'\n');}
async function holdWriter({vault,outputDirectory,expected,holdMs}){
  assert.ok(Number.isSafeInteger(holdMs)&&holdMs>=50&&holdMs<=15000);
  let finish;const command=new Promise(resolve=>{finish=resolve;});let input='';
  const onData=chunk=>{input+=chunk;if(Buffer.byteLength(input)>64)finish('invalid-input');else if(input.includes('\n'))finish(input==='release\n'?'release':'invalid-input');};
  const onEnd=()=>finish('stdin-eof'),onTerm=()=>finish('SIGTERM');
  process.stdin.setEncoding('utf8');process.stdin.on('data',onData);process.stdin.once('end',onEnd);process.once('SIGTERM',onTerm);
  let pin,db,locked,snapshot,reason='setup-failed',failure,timer,rolledBack=false,closed=false,began=false;
  try{
    snapshot=await authenticateSqliteWriter({vault,outputDirectory},expected);pin=await fs.open(snapshot.database.path,constants.O_RDWR|constants.O_NOFOLLOW);same(identity(await pin.stat()),expected.database&&identity(expected.database),'Pinned database descriptor');
    const header=Buffer.alloc(16);const read=await pin.read(header,0,16,0);assert.equal(read.bytesRead,16);assert.equal(header.toString('binary'),'SQLite format 3\0','Existing initialized SQLite header required');
    const uri=pathToFileURL(snapshot.database.path);uri.searchParams.set('mode','rw');db=new DatabaseSync(uri.href,{timeout:0,readOnly:false});
    await authenticateSqliteWriter({vault,outputDirectory},snapshot);same(identity(await pin.stat()),identity(snapshot.database),'Opened database descriptor');
    assert.equal(db.prepare('PRAGMA application_id').get().application_id,applicationId,'Existing Zorid application ID required');assert.equal(db.prepare('PRAGMA user_version').get().user_version,schemaVersion,'Frozen Native database schema required');assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal','Existing Native WAL mode required');
    const main=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main');assert.equal(main.file,snapshot.database.path,'SQLite must open the exact authenticated file');
    db.exec('BEGIN IMMEDIATE');began=true;assert.equal(db.isTransaction,true,'A genuine SQLite write transaction must be active');
    locked=await authenticateSqliteWriter({vault,outputDirectory},snapshot);same(identity(await pin.stat()),identity(snapshot.database),'Locked database descriptor');
    send({kind:'acquired',pid:process.pid,database:snapshot.database,sidecars:locked.sidecars,applicationId,schemaVersion,journalMode:'wal',beginImmediate:true,transactionActive:db.isTransaction});
    timer=setTimeout(()=>finish('hold-deadline'),holdMs);reason=await command;
  }catch(error){failure=error;}
  finally{
    clearTimeout(timer);process.stdin.removeListener('data',onData);process.stdin.removeListener('end',onEnd);process.removeListener('SIGTERM',onTerm);process.stdin.pause();
    try{if(db?.isTransaction){db.exec('ROLLBACK');rolledBack=true;}if(db){assert.equal(db.isTransaction,false);if(locked)await verifyExistingSidecars(locked);db.close();closed=true;}if(snapshot){await authenticateSqliteWriter({vault,outputDirectory},{...snapshot,sidecars:[]});if(pin)same(identity(await pin.stat()),identity(snapshot.database),'Released original database descriptor');}}
    catch(error){failure??=error;}
    finally{if(db&&!closed)try{db.close();closed=true;}catch{}await pin?.close();}
  }
  const receipt={kind:'closed',pid:process.pid,reason,beginImmediate:began,rollback:rolledBack,closed,...(snapshot?{database:snapshot.database}:{}),...(failure?{error:String(failure.message)}:{})};send(receipt);
  if(failure||reason!=='release'||!locked||!rolledBack||!closed)process.exitCode=1;
}
function deadline(promise,ms,label){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms);})]).finally(()=>clearTimeout(timer));}
/** Acquires only after real BEGIN IMMEDIATE proof. release() always joins normal
 * rollback/close; abnormal or forced cleanup is a failed campaign, never proof. */
export async function acquireSqliteWriter({vault,outputDirectory,evidence,holdMs=15000}){
  assert.ok(Number.isSafeInteger(holdMs)&&holdMs>=50&&holdMs<=15000);const expected=await authenticateSqliteWriter({vault,outputDirectory});
  const argv=[helper,'--hold-owned-sqlite',JSON.stringify({vault,outputDirectory,expected,holdMs})],child=spawn(process.execPath,argv,{stdio:['pipe','pipe','pipe']}),record={kind:'owned-sqlite-writer',pid:child.pid,executable:process.execPath,helper,database:expected.database,forcedCleanup:false};
  if(evidence)(evidence.sqliteWriterFaults??=[]).push(record);child.stdin.on('error',error=>{record.stdinError=error.code??error.message;});
  let acquired,closeReceipt,buffer='',stderr='',parseFailure,resolveReady,rejectReady;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});void ready.catch(()=>{});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{buffer+=chunk;if(Buffer.byteLength(buffer)>32768){parseFailure??=Error('SQLite helper exceeded bounded receipt output');rejectReady(parseFailure);return;}let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);try{const row=JSON.parse(line);assert.equal(row.pid,child.pid);if(row.kind==='acquired'){assert.equal(acquired,undefined);acquired=row;resolveReady(row);}else{assert.equal(row.kind,'closed');assert.equal(closeReceipt,undefined);closeReceipt=row;}}catch(error){parseFailure??=error;rejectReady(error);}}});
  child.stderr.on('data',chunk=>{if(Buffer.byteLength(stderr)<65536)stderr+=chunk;});
  let ended=false;const closed=new Promise(resolve=>{child.once('error',error=>{ended=true;record.spawnError=error.message;rejectReady(error);resolve({code:null,signal:null,error});});child.once('close',(code,signal)=>{ended=true;Object.assign(record,{exitCode:code,signal,receipt:closeReceipt,stderr});if(!acquired)rejectReady(Error('SQLite helper closed before BEGIN IMMEDIATE: '+(closeReceipt?.error??stderr)));resolve({code,signal});});});
  const stop=async()=>{if(!ended){child.stdin.end('release\n');try{return await deadline(closed,5000,'SQLite helper normal release deadline');}catch{record.forcedCleanup=true;child.kill('SIGTERM');try{return await deadline(closed,1000,'SQLite helper SIGTERM deadline');}catch{child.kill('SIGKILL');return deadline(closed,1000,'Owned SQLite helper must be gone');}}}return closed;};
  let released;
  const release=()=>released??=(async()=>{const result=await stop();assert.equal(parseFailure,undefined);assert.equal(record.forcedCleanup,false,'Forced SQLite cleanup is not normal rollback proof');assert.equal(result.code,0,closeReceipt?.error??stderr);assert.equal(result.signal,null);assert.ok(closeReceipt?.beginImmediate&&closeReceipt.rollback&&closeReceipt.closed);assert.equal(closeReceipt.reason,'release');same(closeReceipt.database,expected.database,'Released database');await authenticateSqliteWriter({vault,outputDirectory},{...expected,sidecars:[]});return freeze(structuredClone({...closeReceipt,exitCode:result.code,signal:result.signal}));})();
  try{
    const receipt=await deadline(ready,5000,'SQLite writer acquire deadline');assert.equal(receipt.beginImmediate,true);assert.equal(receipt.transactionActive,true);assert.equal(receipt.applicationId,applicationId);assert.equal(receipt.schemaVersion,schemaVersion);assert.equal(receipt.journalMode,'wal');same(receipt.database,expected.database,'Acquired database');await authenticateSqliteWriter({vault,outputDirectory},{...expected,sidecars:[]});assert.equal(ended,false,'SQLite helper must still be alive at acquisition');assert.equal(closeReceipt,undefined,'SQLite helper cannot close before acquisition returns');record.acquired=freeze(structuredClone(receipt));return Object.freeze({evidence:record.acquired,release});
  }catch(error){try{await stop();}catch(cleanup){record.cleanupError=cleanup.message;}throw error;}
}
export function isSqliteWriterInvocation(argv){return typeof argv[1]==='string'&&path.resolve(argv[1])===helper&&argv[2]==='--hold-owned-sqlite'&&argv.length===4;}
if(isSqliteWriterInvocation(process.argv))holdWriter(JSON.parse(process.argv[3])).catch(error=>{send({kind:'closed',pid:process.pid,reason:'unhandled-setup-failure',beginImmediate:false,rollback:false,closed:false,error:String(error.message)});process.exitCode=1;});
