'use strict';
const {contextBridge,ipcRenderer}=require('electron');
let finish,queued=false;
ipcRenderer.on('floor:finish',()=>{queued=true;finish?.();});
contextBridge.exposeInMainWorld('editorFloor',Object.freeze({
 bootstrap:()=>ipcRenderer.invoke('floor:bootstrap'),
 load:()=>ipcRenderer.invoke('floor:load'),
 select:()=>ipcRenderer.invoke('floor:select'),
 event:(kind,data)=>ipcRenderer.send('floor:event',kind,data),
 journal:entry=>ipcRenderer.invoke('floor:journal',entry),
 result:result=>ipcRenderer.invoke('floor:result',result),
 onFinish:callback=>{finish=callback;if(queued)callback();},
}));
