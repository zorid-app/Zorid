/* Dedicated sandboxed fixture renderer; no Node, file paths or relay credentials. */
const api=window.zoridCoreFixture;
const byId=id=>document.getElementById(id);
const output=byId('result');
let lastMutation, busy=false;
const results=[];
function log(result){results.push(result);window.__zoridDesktopFamilyFixture={results:[...results]};output.textContent=JSON.stringify(result,null,2);}
async function action(label, callback){
  if(busy)return;busy=true;
  try {log({operation:label,ok:true,result:await callback()});}
  catch(error){log({operation:label,ok:false,error:{code:error.code??'fixture_failure',commitUncertain:error.commitUncertain===true}});}
  finally{busy=false;}
}
function exactBytes(){
  const value=byId('content').value;
  if(byId('encoding').value==='hex'){
    const hex=value.replace(/\s/g,'');
    if(!/^(?:[0-9a-fA-F]{2})*$/.test(hex)||hex.length>2*1024*1024)throw new Error('Invalid hex content');
    return Uint8Array.from(hex.match(/../g)??[],pair=>parseInt(pair,16));
  }
  if(!value.isWellFormed()||value.length>1024*1024)throw new Error('Invalid text content');
  return new TextEncoder().encode(value);
}
function capture(type){
  const mutation=type==='create'
    ?{type,id:byId('entry').value,path:byId('path').value,kind:'file'}
    :{type,id:byId('entry').value,expected:byId('revision').value};
  lastMutation={command:{version:1,request:{operation_id:byId('operation').value,mutation},create_mode:type==='create'?byId('mode').value:null},bytes:exactBytes()};
  byId('retry').disabled=false;
  // Expose exact synthetic request for verification and explicit retry. This is
  // not a durable consumer checkpoint and never claims crash-safe draft recovery.
  window.__zoridDesktopFamilyLastMutation={command:structuredClone(lastMutation.command),bytes:Array.from(lastMutation.bytes)};
  return api.apply(lastMutation.command,lastMutation.bytes);
}
byId('operation').value=crypto.randomUUID();byId('entry').value=crypto.randomUUID();
byId('new-operation').onclick=()=>{if(!busy)byId('operation').value=crypto.randomUUID();};
byId('enroll').onclick=()=>action('enroll',()=>api.enroll());
byId('status').onclick=()=>action('status',()=>api.status());
byId('list').onclick=()=>action('list',()=>api.list());
byId('sync').onclick=()=>action('sync',()=>api.sync({maxPush:64,maxPages:4}));
byId('create').onclick=()=>action('create',()=>capture('create'));
byId('write').onclick=()=>action('write',()=>capture('write'));
byId('retry').onclick=()=>action('retry-exact',()=>api.apply(lastMutation.command,lastMutation.bytes));
byId('read').onclick=()=>action('read',async()=>{
  const result=await api.read(byId('entry').value);
  if(result){byId('revision').value=result.entry.revision;byId('path').value=result.entry.path;}
  return result?{...result,bytes:Array.from(result.bytes)}:null;
});
void action('info',()=>api.info());
