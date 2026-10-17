'use strict';
const fs = require('node:fs/promises');
const {constants}=require('node:fs');
const path = require('node:path');
/** Trusted main configuration only. Never search PATH or a renderer-selected directory. */
async function resolveDesktopHost({appRoot=path.resolve(__dirname,'..'),resourcesPath=process.resourcesPath,isPackaged=false,override=process.env.ZORID_DESKTOP_HOST_BIN}={}) {
  if (override !== undefined && (typeof override !== 'string' || !path.isAbsolute(override))) throw new Error('ZORID_DESKTOP_HOST_BIN must be an absolute native host path.');
  const name=process.platform==='win32'?'zorid-desktop-host.exe':'zorid-desktop-host';
  const candidates=override?[override]:isPackaged?[path.join(resourcesPath,'native',name)]:[path.join(appRoot,'target','debug',name),path.join(appRoot,'target','release',name)];
  for(const candidate of candidates){
    try {const stat=await fs.lstat(candidate);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Native host must be a regular executable.');await fs.access(candidate,constants.X_OK);return candidate;}
    catch(error){if(error.code!=='ENOENT'||override)throw error;}
  }
  throw Object.assign(new Error(isPackaged?'The packaged Rust host is missing. Reinstall this build.':'Build the Rust desktop host with cargo build -p zorid-desktop-host before starting Zorid.'),{code:'native_host_missing'});
}
module.exports={resolveDesktopHost};
