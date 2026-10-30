import type {DurableCheckpoints,CheckpointScope} from '../core/durable-checkpoints.ts';

interface Options {
  readonly checkpoints:DurableCheckpoints;
  readonly validate:()=>void;
  readonly admitted:(entryId:string)=>boolean;
  readonly recover:(entryId:string,savedPath?:string)=>Promise<void>;
}
const stopped=()=>Object.assign(new Error('The checkpoint recovery owner changed.'),{code:'note_recovery_cancelled'});

/** Discover retained recovery after the selected editor opens. Classify at most
 * one head per turn; clean history never loads source bodies or actors. Failed
 * keys remain queued for required flush; this owner cannot author a raw draft. */
export class DeferredNoteRecovery {
  private keys=new Set<string>();
  private discovery?:Promise<void>;
  private discovered=false;
  private discoveryError:unknown;
  private recoveryError:unknown;
  get error():unknown{return this.recoveryError??this.discoveryError;}
  private flushing?:Promise<void>;
  private backgroundTask?:Promise<void>;
  private backgroundStarted=false;
  private timer?:ReturnType<typeof setTimeout>;
  private retired=false;
  private rejectCancellation!:(error:Error)=>void;
  private cancellation=new Promise<never>((_resolve,reject)=>{this.rejectCancellation=reject;});
  private readonly options:Options;
  private readonly scope:CheckpointScope;
  constructor(options:Options){this.options=options;this.scope=Object.freeze({...options.checkpoints.scope});void this.cancellation.catch(()=>{});}
  private check():void{if(this.retired)throw stopped();this.options.validate();if(this.options.checkpoints.scope.vaultId!==this.scope.vaultId||this.options.checkpoints.scope.clientId!==this.scope.clientId)throw stopped();}
  private async io<T>(run:()=>Promise<T>):Promise<T>{this.check();const value=await Promise.race([run(),this.cancellation]);this.check();return value;}
  private async yield():Promise<void>{await this.io(()=>new Promise(resolve=>setTimeout(resolve,0)));}
  stop():void{if(this.retired)return;this.retired=true;if(this.timer!==undefined)clearTimeout(this.timer);this.timer=undefined;this.rejectCancellation(stopped());}
  start():void{
    if(this.retired||this.timer!==undefined||this.backgroundStarted)return;
    this.timer=setTimeout(()=>{this.timer=undefined;this.backgroundStarted=true;
      const task=this.recoverBackground();this.backgroundTask=task;void task.finally(()=>{if(this.backgroundTask===task)this.backgroundTask=undefined;}).catch(()=>{/* Failure remains owned; selected admission stays usable. */});
    },0);
  }
  discover():Promise<void>{
    if(this.discovered){this.check();return Promise.resolve();}
    if(this.discovery)return this.discovery;
    if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined;}
    const task=(async()=>{
      let cursor:string|undefined,highWater='0';
      do{
        const page=await this.io(()=>this.options.checkpoints.list({limit:100,cursor}));
        highWater=page.highWater;
        for(const row of page.items)if(!row.deleted&&row.key.startsWith('note/v1/'))this.keys.add(row.key);
        cursor=page.cursor??undefined;if(cursor)await this.yield();
      }while(cursor);
      do{
        const page=await this.io(()=>this.options.checkpoints.changes({after:highWater,limit:100,cursor}));
        for(const row of page.items)if(row.key.startsWith('note/v1/'))this.keys.add(row.key);
        cursor=page.cursor??undefined;if(cursor)await this.yield();
      }while(cursor);
      this.check();this.discovered=true;this.discoveryError=undefined;
    })().catch(error=>{this.discoveryError=error;throw error;});
    this.discovery=task;
    void task.finally(()=>{if(this.discovery===task)this.discovery=undefined;}).catch(()=>{});
    return task;
  }
  private async recoverKey(key:string):Promise<void>{
    this.check();const entryId=key.slice('note/v1/'.length);
    if(!entryId)throw new Error('Unsupported durable note recovery checkpoint; retained');
    // The canonical/independent state belongs to the existing loaded actor.
    // Never reread or replace it while a user edits or an exact CAS settles.
    if(!this.options.admitted(entryId)){
      const head=await this.io(()=>this.options.checkpoints.load(key));
      if(head&&head.encodedState!==null){
        const scope=this.options.checkpoints.scope;
        if(head.key!==key||head.vaultId!==scope.vaultId||head.clientId!==scope.clientId)throw new Error('Durable checkpoint scope changed; retained');
        if(typeof head.encodedState!=='string')throw new Error('Malformed durable note recovery checkpoint; retained');
        let raw:any;try{raw=JSON.parse(head.encodedState);}catch{throw new Error('Malformed durable note recovery checkpoint; retained');}
        if(!raw||raw.version!==1||raw.base?.entryId!==entryId)throw new Error('Unsupported durable note recovery checkpoint; retained');
        const clean=typeof raw.writer==='string'&&!!raw.writer&&raw.writer.length<=256&&!raw.writer.includes('\0')&&Number.isSafeInteger(raw.generation)&&raw.generation>=0&&!Object.is(raw.generation,-0)
          &&typeof raw.draft==='string'&&raw.conflict===false&&raw.operation===undefined
          &&typeof raw.base.content==='string'&&typeof raw.base.revision==='string'&&!!raw.base.revision&&raw.base.revision.length<=256&&!raw.base.revision.includes('\0')&&typeof raw.base.path==='string'
          &&!!raw.base.stat&&['ctime','mtime','size'].every(field=>typeof raw.base.stat[field]==='number'&&Number.isFinite(raw.base.stat[field])&&raw.base.stat[field]>=0)&&Number.isSafeInteger(raw.base.stat.size)
          &&raw.draft===raw.base.content;
        if(!clean)await this.io(()=>this.options.recover(entryId,typeof raw.base.path==='string'?raw.base.path:undefined));
      }
    }
    this.keys.delete(key);
  }
  private async recoverBackground():Promise<void>{
    await this.discover();
    for(const key of [...this.keys]){
      this.check();
      try{await this.recoverKey(key);}
      catch(error){this.check();this.recoveryError=error;}
      if(this.keys.size)await this.yield();
    }
  }
  flush():Promise<void>{
    if(this.flushing)return this.flushing;
    const task=(async()=>{
      if(this.backgroundTask)try{await this.backgroundTask;}catch{this.check();}
      await this.discover();
      for(const key of this.keys){await this.recoverKey(key);if(this.keys.size)await this.yield();}
      this.recoveryError=undefined;
    })().catch(error=>{this.recoveryError=error;throw error;});
    this.flushing=task;
    void task.finally(()=>{if(this.flushing===task)this.flushing=undefined;}).catch(()=>{});
    return task;
  }
}
