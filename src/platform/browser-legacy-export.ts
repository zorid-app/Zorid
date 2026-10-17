const vaultKey='zorid.browser-vault.v1',draftPrefix='zorid:draft:browser:default:',sessionKey='zorid:workspace:browser:default';
export function previousBrowserData(storage:Storage):Record<string,string>{
  const result:Record<string,string>=Object.create(null);
  const keys=Array.from({length:storage.length},(_,index)=>storage.key(index));
  for(const key of keys)if(key&&(key===vaultKey||key===sessionKey||key.startsWith(draftPrefix))){const value=storage.getItem(key);if(value!==null)result[key]=value;}
  return result;
}
/** Explicit device-local download. Keep even malformed original bytes and drafts;
 * never import them silently into a new logical sync authority. */
export function legacyBrowserExport(storage:Storage=localStorage):(()=>void)|undefined{
  if(!Object.keys(previousBrowserData(storage)).length)return;
  return ()=>{
    const content=JSON.stringify({format:'zorid-browser-preview-export',version:1,records:previousBrowserData(storage)},null,2);
    const url=URL.createObjectURL(new Blob([content],{type:'application/json;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='zorid-previous-browser-vault.json';
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}
