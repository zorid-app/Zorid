import fs from 'node:fs';
import vm from 'node:vm';
/** Actual preload source with a plain-data clone standing in for contextBridge. */
export function planningBridge(invoke:(...args:any[])=>Promise<unknown>){
  let bridge:any;
  vm.runInNewContext(fs.readFileSync(new URL('../../desktop/preload.cjs',import.meta.url),'utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name:string,value:unknown)=>{bridge=value;}},ipcRenderer:{invoke},webUtils:{}})});
  return{async plan(input:unknown){return JSON.parse(JSON.stringify(await bridge.durableInvoke('/vault','admission','planWrite',[input])));}};
}
