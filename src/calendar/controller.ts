import type {WorkBlockService, WorkBlockRead, WorkBlockRange, WorkBlockTarget, WorkBlockCreate, WorkBlockMutation} from '../core/workblocks.ts';

const DAY = 86_400_000;
const definitive = new Set(['invalid_workblock_request','request_limit','invalid_request','invalid_workblock','stale_revision','operation_collision','client_not_admitted','stale_session','limit']);
type Pending = {kind:'create'; input:WorkBlockCreate} | {kind:'move'; input:WorkBlockMutation & {range:WorkBlockRange}} | {kind:'title'; input:WorkBlockMutation & {title:string|null}} | {kind:'delete'; input:WorkBlockMutation};
export interface CalendarSnapshot {
  pending:boolean; running:boolean; error:string; freshnessError:string; version:number;
}

/** Each request is retained unchanged until acknowledged or definitively rejected.
 * A fresh read is never used to silently rebase a rejected command. */
export class CalendarController {
  private pending?:Pending;
  private running?:Promise<void>;
  private listeners=new Set<()=>void>();
  private error='';
  private freshnessError='';
  private changesAfter='0';
  private pollTimer?:ReturnType<typeof setTimeout>;
  private polling=false;
  private version=0;
  readonly service:WorkBlockService;
  constructor(service:WorkBlockService){this.service=service;}
  get state():CalendarSnapshot{return{pending:!!this.pending,running:!!this.running,error:this.error,freshnessError:this.freshnessError,version:this.version};}
  subscribe(listener:()=>void):()=>void{
    this.listeners.add(listener);if(this.listeners.size===1)this.schedulePoll();
    return()=>{this.listeners.delete(listener);if(!this.listeners.size){clearTimeout(this.pollTimer);this.pollTimer=undefined;}};
  }
  private schedulePoll():void{if(this.pollTimer||!this.listeners.size)return;this.pollTimer=setTimeout(()=>{this.pollTimer=undefined;void this.catchUp().finally(()=>this.schedulePoll());},5000);}
  async catchUp():Promise<void>{
    if(this.polling)return;this.polling=true;
    try{const page=await this.service.changes({after:this.changesAfter,limit:64});const changed=page.changes.some(change=>BigInt(change.sequence)>BigInt(this.changesAfter));if(BigInt(page.next)>BigInt(this.changesAfter))this.changesAfter=page.next;this.freshnessError='';if(changed)this.version++;}
    catch{this.freshnessError='Calendar could not check for updates. Previously loaded blocks may be out of date. Refresh to try again.';}
    finally{this.polling=false;this.publish();}
  }
  private publish():void{for(const listener of this.listeners)listener();}
  async flush():Promise<void>{if(this.running)await this.running;if(this.pending)throw new Error('Calendar has an unconfirmed change. Reopen Calendar and retry the pending change before closing.');}
  read(target:WorkBlockTarget):Promise<WorkBlockRead>{return this.service.read(target);}
  create(range:WorkBlockRange,title:string):Promise<void>{this.validateTitle(title);const operation=crypto.randomUUID();return this.start({kind:'create',input:{record:crypto.randomUUID(),generation:operation,operation,range:{...range},title}});}
  move(block:WorkBlockRead,range:WorkBlockRange):Promise<void>{return this.start({kind:'move',input:{...this.mutation(block),range:{...range}}});}
  title(block:WorkBlockRead,title:string):Promise<void>{this.validateTitle(title);return this.start({kind:'title',input:{...this.mutation(block),title}});}
  delete(block:WorkBlockRead):Promise<void>{return this.start({kind:'delete',input:this.mutation(block)});}
  private validateTitle(title:string):void{if(new TextEncoder().encode(title).length>512)throw new Error('Title must be at most 512 bytes.');}
  private mutation(block:WorkBlockRead):WorkBlockMutation{return{record:block.record,generation:block.generation,expectedRevision:[...block.revision],operation:crypto.randomUUID()};}
  private start(request:Pending):Promise<void>{
    if(this.pending) return Promise.reject(new Error('Retry the pending Calendar change first.'));
    Object.freeze(request.input);if('range'in request.input)Object.freeze(request.input.range);
    if('expectedRevision'in request.input)Object.freeze(request.input.expectedRevision);
    this.pending=Object.freeze(request);return this.retry();
  }
  retry():Promise<void>{
    if(this.running)return this.running;
    const request=this.pending;if(!request)return Promise.resolve();
    this.error='';
    const run=Promise.resolve().then(async()=>{
      try{
        switch(request.kind){
          case 'create':await this.service.create(request.input);break;
          case 'move':await this.service.move(request.input);break;
          case 'title':await this.service.title(request.input);break;
          case 'delete':await this.service.delete(request.input);break;
        }
        this.pending=undefined;this.version++;
      }catch(error){
        const failure=error as {code?:unknown;commitUncertain?:unknown};
        if(failure?.commitUncertain===false&&definitive.has(String(failure.code))){
          this.pending=undefined;this.version++;
          this.error=failure.code==='stale_revision'?'This block changed elsewhere. Your change was not applied; review its current values.':'Calendar could not apply this change. Review the block and try again.';
        }else this.error='Save is unconfirmed. Your exact change is retained. Retry to confirm it before making another change.';
        throw error;
      }finally{this.running=undefined;this.publish();}
    });
    this.running=run;this.publish();return run;
  }

  /** A month grid can cover 42 days. Each native query remains <=31 days,
   * with identical budgets per continuation and one collection fence across all
   * windows. Publish nothing from a mixed snapshot or an exhausted budget. */
  async window(from:number,until:number,isCurrent=()=>true):Promise<WorkBlockRead[]>{
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(until)||until<=from||until-from>62*DAY)throw new Error('Calendar range is unsupported.');
    const blocks=new Map<string,WorkBlockRead>();let watermark:string|undefined,totalBytes=0,pages=0;
    for(let start=from;start<until;start+=31*DAY){
      const query={fromMs:String(start),untilMs:String(Math.min(start+31*DAY,until)),limit:64,byteLimit:1_048_576};
      let cursor:string|null=null;const seen=new Set<string>();
      do{
        if(!isCurrent())return[];
        if(++pages>128)throw new Error('This Calendar range is too busy. Choose a shorter view.');
        const page=await this.service.windowPage({...query,cursor});
        if(!isCurrent())return[];
        if(watermark!==undefined&&watermark!==page.watermark)throw new Error('Calendar changed while loading. Refresh to load one consistent view.');
        watermark=page.watermark;totalBytes+=page.bytes;
        if(totalBytes>8_388_608)throw new Error('This Calendar range is too busy. Choose a shorter view.');
        for(const block of page.blocks){const key=JSON.stringify([block.record,block.generation]),previous=blocks.get(key);if(previous&&JSON.stringify(previous)!==JSON.stringify(block))throw new Error('Calendar changed while loading. Refresh to load one consistent view.');blocks.set(key,block);}
        if(page.incomplete!==!!page.cursor)throw new Error('Calendar returned an incomplete page. Refresh to try again.');
        cursor=page.cursor;if(cursor){if(seen.has(cursor))throw new Error('Calendar page did not advance. Refresh to try again.');seen.add(cursor);}
      }while(cursor);
    }
    // A fully fenced window already represents all changes through this
    // watermark. Advance the shared watcher and invalidate other pane views;
    // never regress a cursor if an older polling response is still in flight.
    if(watermark!==undefined&&BigInt(watermark)>BigInt(this.changesAfter)){this.changesAfter=watermark;this.version++;this.publish();}
    return [...blocks.values()].filter(block=>block.created&&!block.deleted&&block.block);
  }
}

const controllers=new WeakMap<WorkBlockService,CalendarController>();
export function calendarController(service:WorkBlockService):CalendarController{let controller=controllers.get(service);if(!controller){controller=new CalendarController(service);controllers.set(service,controller);}return controller;}
export function blockTitle(block:WorkBlockRead):string{return block.block?.titles.map(candidate=>candidate.title||'Untitled block').join(' / ')||'Untitled block';}
export function hasConflicts(block:WorkBlockRead):boolean{return (block.block?.ranges.length??0)>1||(block.block?.titles.length??0)>1||Object.values(block.unresolved).some(count=>count!=='0');}
