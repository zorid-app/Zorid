import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const hashFile=async file=>hash(await fs.readFile(file));
export function ownedOutput(value){const out=path.resolve(value);assert.ok(path.dirname(out)==='/private/tmp'&&path.basename(out).startsWith('zorid-packaged-startup-')&&!out.includes('\0'),'Output must be a fresh owned /private/tmp/zorid-packaged-startup-* directory');return out;}
export function launchEnvironment(profile,localDataDirectory,inherited=process.env){
  const result={...inherited,ZORID_LOCAL_DATA_DIR:localDataDirectory};
  for(const key of Object.keys(result))if(key.startsWith('ZORID_')&&key!=='ZORID_LOCAL_DATA_DIR'||key.startsWith('ELECTRON_')||['NODE_OPTIONS','NODE_PATH','CHROME_LOG_FILE'].includes(key))delete result[key];
  assert.ok(path.isAbsolute(profile)&&path.isAbsolute(localDataDirectory));return result;
}
export async function appPins(app,asar,manifestFile,{readInfo=filename=>JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',filename],{encoding:'utf8'}))}={}){
  const infoPath=path.join(app,'Contents/Info.plist');
  const info=await readInfo(infoPath);
  assert.ok(typeof info.CFBundleExecutable==='string'&&path.basename(info.CFBundleExecutable)===info.CFBundleExecutable);
  const executable=path.join(app,'Contents/MacOS',info.CFBundleExecutable),archive=path.join(app,'Contents/Resources/app.asar');
  const native=path.join(app,'Contents/Resources/native/zorid-desktop-host');
  const framework=path.join(app,'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');
  const result={app,executable,archive,native,framework,bundleIdentifier:info.CFBundleIdentifier,
    executableSha256:await hashFile(executable),asarSha256:await hashFile(archive),nativeSha256:await hashFile(native),frameworkSha256:await hashFile(framework),infoSha256:await hashFile(infoPath)};
  if(manifestFile){
    const data=await fs.readFile(manifestFile),manifest=JSON.parse(data);assert.ok(manifest.files&&Object.keys(manifest.files).length<=4096);
    for(const [name,expected] of Object.entries(manifest.files)){
      assert.ok(!path.isAbsolute(name)&&!name.split('/').includes('..')&&/^[a-f0-9]{64}$/.test(expected));
      assert.equal(hash(asar.extractFile(archive,name)),expected,'Provided input manifest does not match packaged '+name);
    }
    assert.equal(result.nativeSha256,manifest.native?.signed?.sha256??manifest.native?.sourceSha256,'Provided native manifest does not match packaged host');
    result.provenance={status:'provided-manifest-verified',path:manifestFile,sha256:hash(data),files:Object.keys(manifest.files).length,gitCommit:'unknown-unless-recorded-by-supplier'};
  }else result.provenance={status:'unknown',reason:'No matching source input manifest supplied; ASAR hash is artifact identity only'};
  return result;
}
export function ownedProcesses(apps){
  const prefixes=apps.map(app=>app+'/Contents/');
  return execFileSync('/bin/ps',['-axo','pid=,ppid=,command='],{encoding:'utf8'}).split('\n').flatMap(line=>{
    const match=/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match&&prefixes.some(prefix=>match[3].startsWith(prefix))?[{pid:Number(match[1]),parentPid:Number(match[2]),command:match[3]}]:[];
  });
}
export async function journalHeads(profile){
  const directory=path.join(profile,'draft-journal-v2'),rows=[];
  async function visit(folder,depth){
    if(depth>4||rows.length>=128)return;
    for(const item of await fs.readdir(folder,{withFileTypes:true})){
      const file=path.join(folder,item.name);if(item.isSymbolicLink())continue;
      if(item.isDirectory())await visit(file,depth+1);
      else if(item.isFile()&&item.name==='head.json'){
        const bytes=await fs.readFile(file);if(bytes.length>65536)continue;
        const head=JSON.parse(bytes.toString());rows.push({relative:path.relative(directory,file),sha256:hash(bytes),identity:head.identity,revision:head.revision,generation:head.generation,deleted:head.deleted,draftHash:head.draft??null});
      }
    }
  }
  try{await visit(directory,0);}catch(error){if(error.code!=='ENOENT')throw error;}
  return {status:rows.length?'disk-heads-observed':'not-observed',rows,acknowledgementProven:false,limit:'Disk metadata is not a journal fsync/ACK or protected-body recovery proof'};
}
