import {EditorView} from '@codemirror/view';
import {createDiagnosticLatch} from './diagnostics.mjs';
import {createEditor} from '../../src/ui/editor.ts';
import type {EditorHandle} from '../../src/ui/editor.ts';
import '../../src/ui/styles.css';
import '../../src/ui/reference-defaults.css';
import '../../src/editor/table-controls.css';
import '../../src/editor/live-lists.css';
import '../../src/editor/live-inline.css';
import '../../src/editor/live-math.css';
import '../../src/editor/live-fences.css';
import '../../src/editor/live-callouts.css';
import '../../src/editor/image-embed-controls.css';
import '../../src/editor/wiki-completion.css';
import '../../src/editor/folding.css';
import '../../src/editor/find-panel.css';
import './floor.css';

const rendererModuleEntryEpoch=performance.timeOrigin+performance.now();
const rendererEvents:any[]=[];
const mark=(kind:string,data:Record<string,unknown>={})=>{rendererEvents.push({kind,rendererEpoch:performance.timeOrigin+performance.now(),...data});};
mark('renderer-module-entry',{at:rendererModuleEntryEpoch});
const bridge=(window as any).editorFloor,host=document.querySelector<HTMLElement>('#editor')!,status=document.querySelector('#status')!;
const epoch=()=>performance.timeOrigin+performance.now(),frames=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
const diagnostics=createDiagnosticLatch();
const errors:string[]=[],probes:any[]=[],trusted:{data:string;at:number;trusted:boolean;type:string}[]=[];
let editor:EditorHandle|undefined,view:EditorView|undefined,fixture:any,ready=false,disposed=false,firstViewportEpoch:number|undefined,finishing=false;
const guard=()=>ready&&!disposed&&!!view&&view.contentDOM.isConnected&&fixture?.id===identity;
let identity:string|undefined;
document.addEventListener('beforeinput',event=>{const input=event as InputEvent;if(view?.contentDOM.contains(input.target as Node)&&['x','y'].includes(input.data??''))trusted.push({data:input.data!,at:epoch(),trusted:input.isTrusted,type:input.inputType});},true);
const digest=async(text:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const fail=(error:unknown)=>{errors.push(error instanceof Error?error.message:String(error));mark('renderer-error',{message:errors.at(-1),at:epoch()});};
const startup=(async()=>{
 const before=epoch(),settings=await bridge.bootstrap(),after=epoch();const clockVerified=settings.mainEpoch>=before-5&&settings.mainEpoch<=after+5;
 mark('bootstrap-complete',{at:after,timeOrigin:performance.timeOrigin,clockBracket:[before,after],mainEpoch:settings.mainEpoch,clockVerified});
 if(settings.mode==='first-folder-selection'){status.textContent='Owned fixture folder selection';await frames();mark('selection-shell-visible',{at:epoch()});fixture=await bridge.select();}
 else fixture=await bridge.load();
 identity=fixture.id;mark('fixture-body-delivered',{at:epoch(),bytes:fixture.bytes,id:fixture.id});
 mark('create-editor-start',{at:epoch()});
 editor=createEditor(host,{value:fixture.text,mode:'live',paths:()=>['Fixture.md'],interactionState:{active:false},canMutate:guard,isCurrent:guard,
  validateChange:()=>{if(!guard())throw Error('Fixture interaction guard denied the edit');},onChangeRejected:fail,open:()=>{},
  // Enable the same live embed/Base extension slots. This declared plain fixture
  // must never invoke a replacement renderer or manufacture metadata authority.
  renderEmbed:()=>{throw Error('Unexpected embed in plain Markdown floor fixture');},renderBase:()=>{throw Error('Unexpected Base in plain Markdown floor fixture');},
  onChange:value=>{
   const sequence=probes.length+1,insert=value.slice(fixture.caret+sequence-1,fixture.caret+sequence),name=insert==='x'?'ready':insert==='y'?'deadline':'unknown';
   const event=trusted.findLast(item=>item.data===insert&&epoch()-item.at<1000);
   if(probes.some(probe=>probe.name===name)||name==='unknown'||sequence>2){fail(Error('Unexpected or repeated editor change'));return;}
   const caret=view!.state.selection.main.head,probe:any={name,insert,sequence,appliedEpoch:epoch(),identity,guard:guard(),trusted:event?.trusted===true,inputType:event?.type??null,caret,expectedCaret:fixture.caret+sequence,documentLength:view!.state.doc.length};probes.push(probe);
   mark('input-applied',probe);
   probe.journalPending=bridge.journal({name,insert,sequence,identity,from:fixture.caret+sequence-1,caret,beforeLength:fixture.bytes+sequence-1,afterLength:view!.state.doc.length,appliedEpoch:probe.appliedEpoch}).then((ack:any)=>{probe.journal=ack;mark('journal-ack',{name,at:epoch(),ackEpoch:ack.ackEpoch});},fail);
   probe.paintPending=frames().then(()=>{probe.caretAfterPaint=view?.state.selection.main.head;probe.expectedCaretAfterPaint=fixture.caret+probes.length;mark('input-painted',{name,at:epoch(),caret:probe.caretAfterPaint});});
   diagnostics.trackProbe(name,[probe.journalPending,probe.paintPending]);
  }});
 mark('create-editor-end',{at:epoch()});
 view=EditorView.findFromDOM(host.querySelector('.cm-editor')!)!;if(!view)throw Error('Production EditorView not found');
 const initialDocumentLength=view.state.doc.length,initialPrefixMatches=view.state.doc.sliceString(0,fixture.prefix.length)===fixture.prefix;
 if(initialDocumentLength!==fixture.bytes||!initialPrefixMatches)throw Error('Initial fixture document does not match its identity');
 mark('restore-start',{at:epoch()});
 editor.restoreViewState?.({selection:{ranges:[{anchor:fixture.caret,head:fixture.caret}],mainIndex:0},scrollTop:0,scrollLeft:0});
 mark('restore-end',{at:epoch()});
 ready=true;editor.setInteractionState?.({active:true});mark('focus-start',{at:epoch()});editor.focus();mark('focus-end',{at:epoch()});mark('ready-frames-start',{at:epoch()});await frames();mark('ready-frames-end',{at:epoch()});
 const bounds=view.contentDOM.getBoundingClientRect(),visible=bounds.width>0&&bounds.height>0&&bounds.top<innerHeight&&bounds.bottom>0;
 firstViewportEpoch=epoch();
 const visibleText=[...host.querySelectorAll('.cm-line')].slice(0,5).map(line=>line.textContent).join('\n');
 const evidence={at:firstViewportEpoch,id:identity,initialDocumentLength,initialPrefixMatches,editable:guard()&&view.contentDOM.getAttribute('contenteditable')==='true',visible,viewportMatches:visibleText.includes('Startup editor floor')&&visibleText.includes('Visible first paragraph.'),clockVerified,caret:view.state.selection.main.head,visibleText};
 bridge.event('editor-ready',evidence);status.textContent='Production editor mounted; awaiting two separately labeled probes';return evidence;
})().catch(error=>{fail(error);return null;});
bridge.onFinish(async()=>{
 if(finishing)return;finishing=true;
 try{
  const initial=await diagnostics.finish(startup);await frames();
  // Full-body materialization and hashing are deliberately outside the deadline
  // path. They prove later text was not truncated to make first paint look fast.
  const checkedEpoch=epoch(),value=editor?.getValue()??'',inserted=probes.map(probe=>probe.insert).join('');
  const restored=fixture?value.slice(0,fixture.caret)+value.slice(fixture.caret+inserted.length):value;
  const sourceSha=await digest(restored),editedSha=await digest(value);
  const body={checkedEpoch,sourceSha,editedSha,sourceMatches:sourceSha===fixture?.sha256,editedMatches:!!fixture&&value.length===fixture.bytes+probes.length&&value.slice(fixture.caret,fixture.caret+inserted.length)===inserted};
  mark('full-body-checked',{at:epoch(),sourceSha,editedSha});
  await bridge.result({floorOnly:true,fixtureId:identity,expectedBytes:fixture?.bytes,initialDocumentLength:initial?.initialDocumentLength,initialPrefixMatches:initial?.initialPrefixMatches,viewportMatches:initial?.viewportMatches,clockVerified:initial?.clockVerified,readyIdentity:initial?.id,editableAtReady:initial?.editable&&initial?.visible,firstViewportEpoch,body,probes:probes.map(({journalPending,paintPending,...probe})=>probe),errors,rendererEvents,rendererModuleEntryEpoch,rendererTimeOrigin:performance.timeOrigin});
 }catch(error){fail(error);await bridge.result({floorOnly:true,probes:[],errors,rendererEvents,rendererModuleEntryEpoch,rendererTimeOrigin:performance.timeOrigin});}
});
addEventListener('beforeunload',()=>{disposed=true;editor?.destroy();});
