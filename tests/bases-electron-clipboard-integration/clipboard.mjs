import {spawn} from 'node:child_process';

const MAX_BYTES=64*1024*1024;
const PUBLIC_FORMATS=new Set(['public.utf8-plain-text','public.utf16-external-plain-text','public.html','public.rtf','org.chromium.web-custom-data','text/plain','text/markdown','obsidian/table','obsidian/bases-cells']);
// The snapshot travels over private pipes, never argv, shell interpolation,
// evidence files, diagnostics, or the campaign's action log.
const APPKIT=String.raw`ObjC.import('AppKit');ObjC.import('Foundation');
function snapshot(){const p=$.NSPasteboard.generalPasteboard,before=Number(p.changeCount),items=[],source=p.pasteboardItems;for(let i=0;i<Number(source.count);i++){const item=source.objectAtIndex(i),types=item.types,values=[];for(let j=0;j<Number(types.count);j++){const type=types.objectAtIndex(j),data=item.dataForType(type),bytes=ObjC.unwrap(data.base64EncodedStringWithOptions(0));if(typeof bytes!=='string')throw Error('Unavailable pasteboard representation');values.push({type:ObjC.unwrap(type),data:bytes});}items.push(values);}if(Number(p.changeCount)!==before)throw Error('Pasteboard changed during capture');if(!items.length&&Number(p.types.count))throw Error('Unrepresentable pasteboard items');return{changeCount:before,items};}
function run(argv){if(argv[0]==='capture')return JSON.stringify(snapshot());if(argv[0]!=='restore')throw Error('Unknown pasteboard operation');const bytes=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile,input=ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes,$.NSUTF8StringEncoding)),saved=JSON.parse(input),objects=$.NSMutableArray.array;for(const types of saved.items){const item=$.NSPasteboardItem.alloc.init;for(const value of types){const data=$.NSData.alloc.initWithBase64EncodedStringOptions($(value.data),0);if(!Boolean(item.setDataForType(data,$(value.type))))throw Error('Pasteboard type restore failed');}objects.addObject(item);}const p=$.NSPasteboard.generalPasteboard;p.clearContents;if(saved.items.length&&!Boolean(p.writeObjects(objects)))throw Error('Pasteboard item restore failed');return JSON.stringify(snapshot());}`;

function privateCommand(command,args,input){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['pipe','pipe','pipe']});const chunks=[];let count=0,settled=false;
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Error('Private clipboard command timed out.'));},15000);
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    child.on('error',()=>finish(Error('Private clipboard command could not start.')));
    child.stdout.on('data',chunk=>{count+=chunk.length;if(count>MAX_BYTES){child.kill('SIGKILL');finish(Error('Clipboard exceeds the private preservation limit.'));}else chunks.push(chunk);});
    // Drain stderr without retaining native output, which could contain user data.
    child.stderr.on('data',()=>{});child.on('close',code=>{if(code!==0)finish(Error('Private clipboard command failed.'));else finish(undefined,Buffer.concat(chunks));});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
function privateJSON(bytes){try{return JSON.parse(bytes.toString('utf8'));}catch{throw Error('Private clipboard response is invalid.');}}
const nativeTransport={
  async capture(){if(process.platform!=='darwin')throw Error('This clipboard campaign requires macOS.');return privateJSON(await privateCommand('/usr/bin/osascript',['-l','JavaScript','-e',APPKIT,'capture']));},
  async restore(snapshot){return privateJSON(await privateCommand('/usr/bin/osascript',['-l','JavaScript','-e',APPKIT,'restore'],JSON.stringify(snapshot)));},
  async plain(){return(await privateCommand('/usr/bin/pbpaste',[])).toString('utf8');},
};
function validSnapshot(snapshot){
  if(!snapshot||!Number.isInteger(snapshot.changeCount)||!Array.isArray(snapshot.items)||snapshot.items.length>1024)throw Error('Clipboard cannot be preserved completely.');
  let size=0;for(const item of snapshot.items){if(!Array.isArray(item)||!item.length||item.length>1024)throw Error('Clipboard cannot be preserved completely.');for(const entry of item){if(typeof entry?.type!=='string'||!entry.type||typeof entry.data!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data))throw Error('Clipboard cannot be preserved completely.');size+=entry.data.length;if(size>MAX_BYTES)throw Error('Clipboard exceeds the private preservation limit.');}}
}
/** Runtime only. No snapshot/content escapes this closure, including on failure.
 * A transport injection supports offline preservation tests without touching macOS. */
export function createClipboardGuard({transport=nativeTransport}={}){
  let original,owned=false,restored=false,lastChangeCount,ownedText;
  return{
    async capture(){if(original)throw Error('Clipboard preservation is already active.');const value=await transport.capture();validSnapshot(value);original=structuredClone(value);lastChangeCount=value.changeCount;},
    async recordOwnedClipboard(expectedPlainText){
      if(!original||restored)throw Error('Capture the clipboard before test copy actions.');if(typeof expectedPlainText!=='string')throw Error('A fixture clipboard oracle is required.');
      const before=await transport.capture();validSnapshot(before);if(before.changeCount===lastChangeCount)throw Error('The copy action did not change the system clipboard.');
      const actual=await transport.plain();if(actual!==expectedPlainText)throw Error('System clipboard plain text differs from the fixture oracle.');
      const after=await transport.capture();validSnapshot(after);if(before.changeCount!==after.changeCount)throw Error('The clipboard changed during fixture verification.');
      lastChangeCount=after.changeCount;owned=true;ownedText=expectedPlainText;
      const formats=[...new Set(after.items.flatMap(item=>item.map(entry=>entry.type)))];
      return{formats:formats.filter(type=>PUBLIC_FORMATS.has(type)),unknownFormatCount:formats.filter(type=>!PUBLIC_FORMATS.has(type)).length,plainBytes:Buffer.byteLength(expectedPlainText)};
    },
    async readPlainText(){
      if(!owned||restored)throw Error('Only an acknowledged fixture clipboard may be read.');
      const before=await transport.capture();validSnapshot(before);if(before.changeCount!==lastChangeCount)throw Error('The acknowledged fixture clipboard changed before verification.');
      const value=await transport.plain(),after=await transport.capture();validSnapshot(after);
      if(value!==ownedText||after.changeCount!==lastChangeCount)throw Error('The acknowledged fixture clipboard changed before verification.');return value;
    },
    async restore(){if(!original||restored)return{restored:false};const value=await transport.restore(original);validSnapshot(value);if(JSON.stringify(value.items)!==JSON.stringify(original.items))throw Error('Clipboard restoration verification failed.');restored=true;owned=false;ownedText=undefined;original=undefined;return{restored:true};},
  };
}
