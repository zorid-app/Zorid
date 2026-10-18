import {Calendar} from 'fullcalendar';
import type {EventInput,EventDropInfo,EventResizeDoneInfo} from 'fullcalendar';
import themePlugin from 'fullcalendar/themes/monarch';
import dayGridPlugin from 'fullcalendar/daygrid';
import timeGridPlugin from 'fullcalendar/timegrid';
import listPlugin from 'fullcalendar/list';
import interactionPlugin from 'fullcalendar/interaction';
import {Temporal} from 'temporal-polyfill';
import type {WorkBlockRead,WorkBlockRange,WorkBlockService} from '../core/workblocks.ts';
import {calendarController,blockTitle,hasConflicts} from './controller.ts';

export interface CalendarView {hasPendingChanges():boolean;flush():Promise<void>;destroy():void;refresh():void;}
export interface CalendarViewState {view?:string;date?:string;}
const views=new Set(['dayGridMonth','timeGridWeek','timeGridDay','listWeek']);
const node=<K extends keyof HTMLElementTagNameMap>(tag:K,className='',text=''):HTMLElementTagNameMap[K]=>{const element=document.createElement(tag);element.className=className;element.textContent=text;return element;};
const button=(text:string,action:()=>void)=>{const element=node('button','',text);element.type='button';element.onclick=action;return element;};
const localZone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
export function localDateTime(ms:number,zone:string):string{return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDateTime().toString({fractionalSecondDigits:3});}
export function formRange(start:string,end:string,timezone:string):WorkBlockRange{
  const from=Temporal.PlainDateTime.from(start).toZonedDateTime(timezone,{disambiguation:'reject'}).epochMilliseconds;
  const until=Temporal.PlainDateTime.from(end).toZonedDateTime(timezone,{disambiguation:'reject'}).epochMilliseconds;
  if(until<=from)throw new Error('End must be after start.');
  if(until-from>31*86_400_000)throw new Error('A block can span at most 31 days.');
  return{start_ms:String(from),end_ms:String(until),timezone};
}

export function createCalendarView(host:HTMLElement,service:WorkBlockService|undefined,saved:CalendarViewState={},onState?:(state:CalendarViewState)=>void):CalendarView{
  const root=node('section','calendar-view');root.setAttribute('aria-label','Calendar');host.append(root);
  if(!service){root.append(node('h2','','Calendar'),node('p','calendar-status','Calendar is not available for this vault on this platform.'));return{hasPendingChanges(){return false;},async flush(){},destroy(){root.remove();},refresh(){}};}
  const controller=calendarController(service),controls=node('div','calendar-controls'),title=node('h2','calendar-heading','Calendar');
  const status=node('div','calendar-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const retry=button('Retry pending change',()=>{void controller.retry().catch(()=>{});});
  const canvas=node('div','calendar-grid'),editor=node('section','calendar-editor');editor.hidden=true;editor.setAttribute('aria-label','Work block details');
  let disposed=false,loadSerial=0,selectionSerial=0,loading=false,loadError='',formError='',selected:WorkBlockRead|undefined,records=new Map<string,WorkBlockRead>(),range={from:0,until:0};
  let knownVersion=controller.state.version,editing=false,ownsRequest=false;
  const form=node('form'),heading=node('h3','','Add work block'),candidates=node('div','calendar-candidates');
  const field=(labelText:string,type:string)=>{const label=node('label','calendar-field',labelText),input=node('input');input.type=type;if(type==='datetime-local')input.step='0.001';label.append(input);form.append(label);return input;};
  form.append(heading,candidates);
  const name=field('Title','text'),start=field('Start','datetime-local'),end=field('End','datetime-local'),zone=field('Time zone','text');
  name.maxLength=512;name.required=true;start.required=true;end.required=true;zone.required=true;
  const errors=node('p','calendar-form-error');errors.setAttribute('role','alert');
  const formButtons=node('div','calendar-form-buttons');
  const cancel=()=>{if(controller.state.pending)return;selectionSerial++;editing=false;selected=undefined;editor.hidden=true;calendar.unselect();formError='';paintStatus();};
  const attempt=async(operation:()=>Promise<void>)=>{
    if(controller.state.pending)return;
    formError='';ownsRequest=true;
    try{await operation();if(disposed)return;editing=false;editor.hidden=true;selected=undefined;}
    catch(error){if(!controller.state.pending)ownsRequest=false;if(!disposed){formError=controller.state.error||(error instanceof Error?error.message:'The change could not be saved.');if(selected)void inspect(selected);}}
    if(!disposed)paintStatus();
  };
  const saveTitle=button('Save title',()=>{if(!name.reportValidity()||!selected)return;const block=selected;void attempt(()=>controller.title(block,name.value.trim()));});
  const parseRange=()=>{try{const value=formRange(start.value,end.value,zone.value.trim());formError='';return value;}catch{formError='Enter valid start and end times and an IANA time zone (for example America/Toronto). End must be later, within 31 days; ambiguous or skipped daylight-saving times need a different time.';paintStatus();return null;}};
  const saveTime=button('Save time',()=>{const value=parseRange(),block=selected;if(value&&block)void attempt(()=>controller.move(block,value));});
  const add=button('Add block',()=>{if(!name.reportValidity())return;const value=parseRange();if(value)void attempt(()=>controller.create(value,name.value.trim()));});
  let confirmingDelete=false;
  const remove=button('Delete block',()=>{if(!selected)return;confirmingDelete=true;deleteConfirm.hidden=false;confirmDelete.focus();});
  const deleteConfirm=node('div','calendar-delete-confirm','Delete this entire block, including its alternative values? ');
  const confirmDelete=button('Confirm delete',()=>{const block=selected;if(block)void attempt(()=>controller.delete(block));});
  deleteConfirm.append(confirmDelete,button('Keep block',()=>{confirmingDelete=false;deleteConfirm.hidden=true;}));deleteConfirm.hidden=true;
  formButtons.append(add,saveTitle,saveTime,remove,button('Cancel',cancel));form.append(errors,formButtons,deleteConfirm);editor.append(form);
  form.onsubmit=event=>{event.preventDefault();if(selected)saveTime.click();else add.click();};
  editor.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();cancel();}};
  function paintStatus():void{
    const state=controller.state;
    status.textContent=state.error||loadError||state.freshnessError||(state.running?'Saving…':loading?'Loading calendar…':'');
    retry.hidden=!state.pending||state.running;errors.textContent=formError;
    for(const input of [name,start,end,zone])input.disabled=state.pending;
    for(const control of [add,saveTitle,saveTime,remove,confirmDelete])control.disabled=state.pending;
    newButton.disabled=state.pending;calendar.setOption('editable',!state.pending);
    deleteConfirm.hidden=!confirmingDelete;
  }
  function openForm(block:WorkBlockRead|undefined,value:WorkBlockRange,titleValue=''):void{
    if(disposed||controller.state.pending)return;
    selected=block;editing=true;formError='';confirmingDelete=false;
    heading.textContent=block?'Edit work block':'Add work block';name.value=block?blockTitle(block):titleValue;
    try{start.value=localDateTime(Number(value.start_ms),value.timezone);end.value=localDateTime(Number(value.end_ms),value.timezone);}catch{start.value='';end.value='';}
    zone.value=value.timezone;add.hidden=!!block;saveTitle.hidden=saveTime.hidden=remove.hidden=!block;
    candidates.replaceChildren();
    if(block&&hasConflicts(block)){
      candidates.append(node('p','','This block has concurrent or unresolved values. All alternatives remain stored. Saving a field explicitly replaces its displayed alternatives; other fields remain unchanged.'));
      for(const candidate of block.block?.titles??[])candidates.append(node('p','','Title: '+(candidate.title||'Untitled block')));
      for(const candidate of block.block?.ranges??[]){const r=candidate.range;candidates.append(button('Use time: '+new Date(Number(r.start_ms)).toLocaleString()+' – '+new Date(Number(r.end_ms)).toLocaleString()+' ('+r.timezone+')',()=>{start.value=localDateTime(Number(r.start_ms),r.timezone);end.value=localDateTime(Number(r.end_ms),r.timezone);zone.value=r.timezone;}));}
    }
    editor.hidden=false;paintStatus();name.focus();
  }
  async function inspect(block:WorkBlockRead):Promise<void>{
    const serial=++selectionSerial;
    try{const current=await controller.read({record:block.record,generation:block.generation});if(disposed||serial!==selectionSerial||controller.state.pending)return;
      if(!current.created||current.deleted||!current.block){formError='This block is no longer available.';editing=false;editor.hidden=true;await refresh();paintStatus();return;}
      const value=current.block.ranges[0]?.range;if(value)openForm(current,value);else{formError='This block has no displayable time. Refresh Calendar to retry.';paintStatus();}
    }catch{if(!disposed&&serial===selectionSerial){loadError='Could not read this block. Refresh Calendar to retry.';paintStatus();}}
  }
  const defaultRange=(date=new Date())=>{const value=new Date(date);value.setMinutes(0,0,0);value.setHours(value.getHours()+1);return{start_ms:String(value.getTime()),end_ms:String(value.getTime()+3_600_000),timezone:localZone()};};
  const newButton=button('Add work block',()=>{selectionSerial++;openForm(undefined,defaultRange());});
  controls.append(button('Previous',()=>calendar.prev()),button('Today',()=>calendar.today()),button('Next',()=>calendar.next()),title);
  const switcher=node('select');switcher.setAttribute('aria-label','Calendar view');
  for(const [value,label]of [['dayGridMonth','Month'],['timeGridWeek','Week'],['timeGridDay','Day'],['listWeek','List']]){const option=node('option','',label);option.value=value;switcher.append(option);}
  switcher.onchange=()=>calendar.changeView(switcher.value);controls.append(switcher,newButton,button('Refresh',()=>{void refresh();}));
  root.append(controls,status,retry,editor,canvas);
  const propose=(info:EventDropInfo|EventResizeDoneInfo)=>{
    const block=records.get(String(info.event.extendedProps.blockKey)),startMs=info.event.start?.getTime(),endMs=info.event.end?.getTime();
    // Always revert the optimistic library state. A form makes move/resize
    // reviewable, cancellable and fully available without a pointing device.
    info.revert();
    if(!block||startMs===undefined||endMs===undefined||controller.state.pending)return;
    const original=block.block?.ranges[0]?.range;if(!original)return;
    const serial=++selectionSerial;
    void controller.read({record:block.record,generation:block.generation}).then(current=>{
      if(disposed||serial!==selectionSerial)return;
      if(JSON.stringify(current.revision)!==JSON.stringify(block.revision)){loadError='This block changed during the gesture. Review its current values.';void inspect(current);return;}
      openForm(current,{start_ms:String(startMs),end_ms:String(endMs),timezone:original.timezone});heading.textContent='Review time change';start.focus();
    }).catch(()=>{if(!disposed){loadError='Could not read this block. Refresh Calendar to retry.';paintStatus();}});
  };
  const calendar=new Calendar(canvas,{
    plugins:[themePlugin,dayGridPlugin,timeGridPlugin,listPlugin,interactionPlugin],
    initialView:views.has(saved.view??'')?saved.view:'dayGridMonth',
    ...(saved.date&&/^\d{4}-\d{2}-\d{2}$/.test(saved.date)?{initialDate:saved.date}:{}),
    eventInteractive:true,headerToolbar:false,height:'100%',timeZone:'local',editable:true,selectable:true,nowIndicator:true,
    eventDrop:propose,eventResize:propose,
    eventClick:info=>{const block=records.get(String(info.event.extendedProps.blockKey));if(block)void inspect(block);},
    eventContent:info=>{const text=node('span','',info.timeText+' '+info.event.title);return{domNodes:[text]};},
    select:info=>{selectionSerial++;const startDate=new Date(info.start);if(info.allDay)startDate.setHours(9,0,0,0);openForm(undefined,{start_ms:String(startDate.getTime()),end_ms:String(info.allDay?startDate.getTime()+3_600_000:info.end.getTime()),timezone:localZone()});},
    datesSet:info=>{if(range.from!==info.start.getTime()||range.until!==info.end.getTime())selectionSerial++;title.textContent=info.view.title;switcher.value=info.view.type;range={from:info.start.getTime(),until:info.end.getTime()};onState?.({view:info.view.type,date:localDateTime(info.view.currentStart.getTime(),localZone()).slice(0,10)});void refresh();},
  });
  async function refresh():Promise<void>{
    if(disposed||!range.until)return;
    const serial=++loadSerial;loading=true;loadError='';paintStatus();
    try{
      const blocks=await controller.window(range.from,range.until,()=>!disposed&&serial===loadSerial);
      if(disposed||serial!==loadSerial)return;
      const next=new Map<string,WorkBlockRead>(),events:EventInput[]=[];
      for(const block of blocks){const key=JSON.stringify([block.record,block.generation]);next.set(key,block);for(const [index,candidate]of (block.block?.ranges??[]).entries())events.push({id:key+':'+index,title:blockTitle(block)+(hasConflicts(block)?' (review alternatives)':''),start:Number(candidate.range.start_ms),end:Number(candidate.range.end_ms),allDay:false,editable:!hasConflicts(block),extendedProps:{blockKey:key}});}
      records=next;calendar.batchRendering(()=>{calendar.getEventSources().forEach(source=>source.remove());calendar.addEventSource(events);});
    }catch{if(!disposed&&serial===loadSerial){loadError='Calendar could not load a consistent view. Previously loaded blocks may be out of date. Refresh to retry, or choose a shorter view.';}}
    finally{if(!disposed&&serial===loadSerial){loading=false;paintStatus();}}
  }
  const unsubscribe=controller.subscribe(()=>{if(disposed)return;if(ownsRequest&&!controller.state.pending&&!controller.state.error){ownsRequest=false;editing=false;selected=undefined;editor.hidden=true;formError='';}paintStatus();if(controller.state.version!==knownVersion){knownVersion=controller.state.version;void refresh();}});
  const focusRefresh=()=>{void controller.catchUp();void refresh();};window.addEventListener('focus',focusRefresh);
  // Observer also covers a parked tab being reattached or moved between splits.
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(root.isConnected)calendar.render();}):undefined;resize?.observe(root);
  calendar.render();paintStatus();
  return{
    hasPendingChanges(){return editing||controller.state.pending;},
    async flush(){await controller.flush();if(editing)throw new Error('Save or cancel the Calendar form before leaving this tab.');},
    refresh(){void refresh();},
    destroy(){disposed=true;loadSerial++;selectionSerial++;unsubscribe();window.removeEventListener('focus',focusRefresh);resize?.disconnect();calendar.destroy();root.remove();},
  };
}
