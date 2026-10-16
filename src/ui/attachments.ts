import type { Vault } from '../core/vault.ts';

const mimeTypes: Record<string,string> = {
  png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
  svg:'image/svg+xml', bmp:'image/bmp', avif:'image/avif', pdf:'application/pdf',
  mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg', m4a:'audio/mp4',
  mp4:'video/mp4', webm:'video/webm', mov:'video/quicktime',
};
export function attachmentType(path:string):string { return mimeTypes[path.split('.').at(-1)!.toLowerCase()] ?? 'application/octet-stream'; }
export function isImage(path:string):boolean { return attachmentType(path).startsWith('image/'); }

/** Dimensions in the final alt segment, matching the observed integer width[xheight] syntax. */
export function imageAlt(value = ''): {alt:string; width?:number; height?:number} {
  const split=value.lastIndexOf('|'), tail=value.slice(split+1);
  const match=/^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(tail);
  if(!match)return {alt:value};
  const width=Number(match[1]),height=match[2]===undefined?undefined:Number(match[2]);
  if(!Number.isSafeInteger(width) || (height!==undefined&&!Number.isSafeInteger(height)))return {alt:value};
  return {alt:split<0?'':value.slice(0,split),width,...(height?{height}:{})};
}

export interface AttachmentLease {
  url:string;
  type:string;
  /** Fresh transferable bytes on each call, valid only while this lease and owner remain live. */
  arrayBuffer?():Promise<ArrayBuffer>;
  release():void;
}
interface Resource { refs:number; url?:string; blob?:Blob; stale:boolean; promise:Promise<string> }

/** Shared per-vault object URLs: bounded reads, duplicate-load coalescing and explicit ownership. */
export class AttachmentResources {
  private vault:Vault;
  private current=new Map<string,Resource>();
  private resources=new Set<Resource>();
  private queue:(()=>void)[]=[];
  private running=0;
  private disposed=false;
  private off:(()=>void)[];
  constructor(vault:Vault){
    this.vault=vault;
    this.off=[vault.on('modify',change=>this.invalidate(change.path)),...(['create','delete','rename'] as const).map(event=>vault.on(event,()=>this.invalidate()))];
  }
  private drain():void { while(this.running<4 && this.queue.length)this.queue.shift()!(); }
  private read(path:string):Promise<Uint8Array>{
    return new Promise((resolve,reject)=>{
      this.queue.push(()=>{
        this.running++;
        Promise.resolve().then(()=>{if(this.disposed)throw new Error('Attachment view closed');return this.vault.readBinary(path);})
          .then(resolve,reject).finally(()=>{this.running--;this.drain();});
      });this.drain();
    });
  }
  async acquire(path:string):Promise<AttachmentLease>{
    if(this.disposed)throw new Error('Attachment view closed');
    let resource=this.current.get(path);
    const type=attachmentType(path);
    if(!resource){
      resource={refs:0,stale:false,promise:Promise.resolve('')};
      const created=resource;
      created.promise=this.read(path).then(bytes=>{
        if(this.disposed)throw new Error('Attachment view closed');
        const copy=new Uint8Array(bytes.byteLength);copy.set(bytes);
        created.blob=new Blob([copy.buffer],{type});
        created.url=URL.createObjectURL(created.blob);
        return created.url;
      });
      this.current.set(path,created);this.resources.add(created);
    }
    resource.refs++;
    const selected=resource;
    try {
      const url=await selected.promise;
      if(this.disposed)throw new Error('Attachment view closed');
      let released=false;
      return {url,type,arrayBuffer:async()=>{
        const ensureLive=()=>{if(this.disposed)throw new Error('Attachment view closed');if(released||!selected.blob)throw new Error('Attachment lease released');};
        ensureLive();
        // Blob is immutable and shared with the object URL. Every returned buffer is
        // independent, so transferring it to a PDF worker cannot detach another lease.
        const bytes=await selected.blob!.arrayBuffer();ensureLive();return bytes;
      },release:()=>{if(released)return;released=true;this.release(path,selected);}};
    } catch(error){ this.release(path,selected);throw error; }
  }
  private release(path:string,resource:Resource):void{
    resource.refs--;
    if(resource.refs>0)return;
    if(this.current.get(path)===resource)this.current.delete(path);
    if(resource.url){URL.revokeObjectURL(resource.url);resource.url=undefined;}
    resource.blob=undefined;this.resources.delete(resource);
  }
  invalidate(path?:string):void{
    if(path){const entry=this.current.get(path);if(entry)entry.stale=true;this.current.delete(path);}
    else {for(const entry of this.current.values())entry.stale=true;this.current.clear();}
  }
  destroy():void{
    if(this.disposed)return;this.disposed=true;this.off.forEach(off=>off());
    for(const entry of this.resources){if(entry.url){URL.revokeObjectURL(entry.url);entry.url=undefined;}entry.blob=undefined;}
    this.resources.clear();this.current.clear();this.drain();
  }
}
