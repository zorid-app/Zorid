'use strict';
const { contextBridge, ipcRenderer } = require('electron');
async function invoke(request) {
  const reply=await ipcRenderer.invoke('zorid-family-fixture:invoke',request);
  if(!reply?.ok)throw Object.assign(new Error('Core fixture request failed; preserve the exact command on uncertain results.'),reply?.error);
  return reply.result;
}
contextBridge.exposeInMainWorld('zoridCoreFixture',Object.freeze({
  info:()=>invoke({method:'info'}),
  enroll:()=>invoke({method:'enroll'}),
  status:()=>invoke({method:'status'}),
  sync:({maxPush=64,maxPages=4}={})=>invoke({method:'sync',maxPush,maxPages}),
  list:()=>invoke({method:'list'}),
  read:entryId=>invoke({method:'read',entryId}),
  apply:(command,bytes)=>invoke({method:'apply',command,bytes}),
}));
