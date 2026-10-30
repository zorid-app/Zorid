// Genuine temporary SQLite only; none of these fixtures are Native authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {acquireSqliteWriter} from './sqlite-writer-fault.mjs';
async function fixture(){const out=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'zorid-sqlite-writer-unit-'))),vault=path.join(out,'disposable','bases-native-recovery');await fs.mkdir(path.join(vault,'.zorid'),{recursive:true});const file=path.join(vault,'.zorid','vault.sqlite'),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; PRAGMA application_id=1515147844; PRAGMA user_version=20; CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES (\'unchanged\')');return{out,vault,file,db,async close(){try{if(db.isOpen)db.close();}finally{await fs.rm(out,{recursive:true,force:true});}}};}
test('the owned external helper holds a genuine SQLite writer lock until explicit rollback and close',async()=>{
  const f=await fixture();let held;const contender=new DatabaseSync(f.file,{timeout:0});try{held=await acquireSqliteWriter({vault:f.vault,outputDirectory:f.out,evidence:{}});assert.throws(()=>contender.exec('BEGIN IMMEDIATE'),error=>error.code==='ERR_SQLITE_ERROR'&&error.errcode===5);await held.release();held=undefined;contender.exec('BEGIN IMMEDIATE');contender.exec('ROLLBACK');assert.deepEqual(f.db.prepare('SELECT value FROM sentinel').all().map(row=>row.value),['unchanged']);}finally{try{if(contender.isTransaction)contender.exec('ROLLBACK');}finally{try{contender.close();}finally{try{await held?.release();}finally{await f.close();}}}}
});
test('writer transaction changes no schema, logical rows or database/WAL bytes',async()=>{
  const f=await fixture(),before={database:await fs.readFile(f.file),wal:await fs.readFile(f.file+'-wal'),schema:f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),rows:f.db.prepare('SELECT value FROM sentinel').all(),version:f.db.prepare('PRAGMA data_version').get().data_version},evidence={};let held;
  try{held=await acquireSqliteWriter({vault:f.vault,outputDirectory:f.out,evidence});assert.ok(Object.isFrozen(held)&&Object.isFrozen(held.evidence)&&held.evidence.transactionActive);const closed=await held.release();held=undefined;assert.ok(Object.isFrozen(closed)&&closed.rollback&&closed.closed);assert.equal(closed.exitCode,0);assert.equal(closed.signal,null);assert.equal(evidence.sqliteWriterFaults.length,1);assert.equal(evidence.sqliteWriterFaults[0].forcedCleanup,false);assert.deepEqual(await fs.readFile(f.file),before.database);assert.deepEqual(await fs.readFile(f.file+'-wal'),before.wal);assert.deepEqual(f.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name').all(),before.schema);assert.deepEqual(f.db.prepare('SELECT value FROM sentinel').all(),before.rows);assert.equal(f.db.prepare('PRAGMA data_version').get().data_version,before.version);}finally{try{await held?.release();}finally{await f.close();}}
});
test('missing DB, aliases, foreign paths, symlink/hardlink DB and unsafe sidecars fail before opening',async()=>{
  for(const kind of ['missing','traversal','outside','vault-symlink','db-symlink','db-hardlink','sidecar-symlink','db-directory','uninitialized','foreign-application']){
    const f=await fixture();try{
      let vault=f.vault;
      if(kind==='missing'){f.db.close();await fs.rm(f.file);}
      if(kind==='traversal')vault=f.vault+'/../bases-native-recovery';
      if(kind==='outside')vault=path.join(f.out,'outside');
      if(kind==='vault-symlink'){const alias=path.join(f.out,'alias');await fs.symlink(f.vault,alias);vault=alias;}
      if(['db-symlink','db-hardlink','db-directory','uninitialized'].includes(kind)){f.db.close();await fs.rename(f.file,f.file+'.original');if(kind==='db-symlink')await fs.symlink(f.file+'.original',f.file);if(kind==='db-hardlink')await fs.link(f.file+'.original',f.file);if(kind==='db-directory')await fs.mkdir(f.file);if(kind==='uninitialized')await fs.writeFile(f.file,'not a SQLite database');}
      if(kind==='sidecar-symlink'){await fs.symlink(f.file,path.join(f.vault,'.zorid','vault.sqlite-journal'));}
      if(kind==='foreign-application')f.db.exec('PRAGMA application_id=1');
      await assert.rejects(acquireSqliteWriter({vault,outputDirectory:f.out,evidence:{}}));
      if(kind==='missing')await assert.rejects(fs.stat(f.file),error=>error.code==='ENOENT');
    }finally{await f.close();}
  }
});
test('original DB replacement while held rejects release after rollback and joins the owned child',async()=>{
  const f=await fixture(),evidence={};let held;
  try{held=await acquireSqliteWriter({vault:f.vault,outputDirectory:f.out,evidence});await fs.rename(f.file,f.file+'.original');await fs.copyFile(f.file+'.original',f.file);await assert.rejects(held.release(),/identity changed/);held=undefined;assert.equal(evidence.sqliteWriterFaults[0].exitCode,1);assert.equal(evidence.sqliteWriterFaults[0].receipt.rollback,true);assert.equal(evidence.sqliteWriterFaults[0].receipt.closed,true);}finally{try{await held?.release().catch(()=>{});}finally{await f.close();}}
});
test('hold deadline rolls back and closes but fails normal-release acceptance',async()=>{
  const f=await fixture(),evidence={};let held;try{held=await acquireSqliteWriter({vault:f.vault,outputDirectory:f.out,evidence,holdMs:100});await new Promise(resolve=>setTimeout(resolve,150));await assert.rejects(held.release());held=undefined;assert.equal(evidence.sqliteWriterFaults[0].receipt.reason,'hold-deadline');assert.equal(evidence.sqliteWriterFaults[0].receipt.rollback,true);assert.equal(evidence.sqliteWriterFaults[0].receipt.closed,true);f.db.exec('BEGIN IMMEDIATE');f.db.exec('ROLLBACK');}finally{try{await held?.release().catch(()=>{});}finally{await f.close();}}
});
