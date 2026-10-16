import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMermaidRenderer, mermaidConfiguration, normalizeMermaidCodeText } from '../src/ui/mermaid-renderer.ts';
import type { MermaidEngine, MermaidMountOptions } from '../src/ui/mermaid-renderer.ts';
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
async function ticks() { for(let i=0;i<20;i++) await Promise.resolve(); }
const svg = (text='Diagram') => `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`;
function setup(t: TestContext, engineOverride?: Partial<MermaidEngine>) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {url:'https://zorid.test/'});
  const doc=dom.window.document,host=doc.querySelector<HTMLElement>('main')!,configs:Record<string,unknown>[]=[],calls:{id:string;source:string;host:HTMLElement}[]=[],errors:Error[]=[];
  let loads=0,allowed=true,requests=0;
  const engine:MermaidEngine={initialize(config){configs.push(config);},async render(id,source,host){calls.push({id,source,host});return {svg:svg()};},...engineOverride};
  const renderer=createMermaidRenderer({async loadEngine(document){assert.equal(document,doc);loads++;return engine;}});
  const trust={isAllowed:()=>allowed,requestAllow(){requests++;allowed=true;}};
  const mount=(options:Partial<MermaidMountOptions>={},container=host)=>renderer.mount(container,{source:'graph TD; A-->B',sourcePath:'Folder/note.md',trust,onError:error=>errors.push(error),...options});
  t.after(()=>{renderer.destroy();dom.window.close();});
  return {dom,doc,host,renderer,mount,engine,configs,calls,errors,trust,get loads(){return loads;},get requests(){return requests;},set allowed(value:boolean){allowed=value;}};
}

test('strict configuration and normalization preserve exact body source and diagram sizing overrides',async t=>{
  const f=setup(t),view=f.mount({source:'graph TD; A-->B\n\n'});await view.ready;
  assert.equal(f.calls[0].source,'graph TD; A-->B\n\n');assert.equal(normalizeMermaidCodeText('x\n\n'),'x\n');
  const config=f.configs[0];assert.equal(config.securityLevel,'strict');assert.equal(config.startOnLoad,false);assert.deepEqual(config.themeVariables,{fontFamily:'var(--font-mermaid)'});
  for(const type of ['flowchart','sequence','git','er'])assert.equal((config[type] as {useMaxWidth:boolean}).useMaxWidth,false);
  for(const type of ['gantt','journey','class','state','pie'])assert.equal((config[type] as {useMaxWidth:boolean}).useMaxWidth,true);
  const format=(config.gantt as {axisFormatter:[string,(date:Date)=>boolean][]}).axisFormatter[0];assert.equal(format[0],'%Y-%m-%d');assert.equal(format[1](new Date(2026,9,19)),true);assert.equal(format[1](new Date(2026,9,20)),false);
  (config.secure as string[]).push('modified');assert.ok(!(mermaidConfiguration().secure as string[]).includes('modified'));
  assert.equal(f.host.querySelector('.mermaid')?.textContent,'Diagram');assert.equal(f.doc.querySelector('.zorid-mermaid-measure'),null);
});

test('trust belongs to each mount and approval never automatically trusts another vault',async t=>{
  const f=setup(t);f.allowed=false;const first=f.mount();await first.ready;
  const other=f.doc.createElement('div');f.doc.body.append(other);const second=f.mount({trust:{isAllowed:()=>false,requestAllow(){}}},other);await second.ready;
  assert.equal(f.loads,0);assert.match(f.host.textContent! ,/graph TD/);f.host.querySelector<HTMLButtonElement>('button')!.click();await ticks();await first.ready;
  assert.equal(f.requests,1);assert.equal(f.loads,1);assert.ok(f.host.querySelector('svg'));assert.ok(other.querySelector('.is-guarded'));assert.equal(other.querySelector('svg'),null);
  f.allowed=false;await first.refreshTrust();assert.equal(f.host.querySelector('svg'),null);assert.ok(f.host.querySelector('.is-guarded'));
});

test('revocation while engine loads prevents render and shows source guard',async t=>{
  const f=setup(t),loading=deferred<MermaidEngine>();let rendered=0;
  const renderer=createMermaidRenderer({loadEngine:()=>loading.promise});t.after(()=>renderer.destroy());
  const view=renderer.mount(f.host,{source:'graph TD; A-->B',sourcePath:'a.md',trust:f.trust});await ticks();f.allowed=false;
  loading.resolve({initialize(){},async render(){rendered++;return {svg:svg()};}});await view.ready;assert.equal(rendered,0);assert.ok(f.host.querySelector('.is-guarded'));
});

test('render queue skips superseded and destroyed jobs and never invokes bindings',async t=>{
  const pending=deferred<{svg:string;bindFunctions?:unknown}>();let active=0,maximum=0,bindings=0;const sources:string[]=[];
  const f=setup(t,{async render(_id,source){sources.push(source);maximum=Math.max(maximum,++active);try{return source==='first'?await pending.promise:{svg:svg(source),bindFunctions(){bindings++;}};}finally{active--;}}});
  const first=f.mount({source:'first'});await ticks();const other=f.doc.createElement('div');f.doc.body.append(other);
  const second=f.mount({source:'old'},other);const cancelled=second.ready;second.update('middle');second.update('latest');await cancelled;
  const removedHost=f.doc.createElement('div');f.doc.body.append(removedHost);const removed=f.mount({source:'removed'},removedHost);removed.destroy();await removed.ready;
  pending.resolve({svg:svg('first'),bindFunctions(){bindings++;}});await Promise.all([first.ready,second.ready]);
  assert.deepEqual(sources,['first','latest']);assert.equal(maximum,1);assert.equal(bindings,0);assert.equal(f.configs.length,1);assert.equal(other.querySelector('text')?.textContent,'latest');
});

test('editing while rendering discards old SVG and settles old ready without cancelling engine work',async t=>{
  const pending=deferred<{svg:string}>();const f=setup(t,{async render(_id,source){return source==='old'?pending.promise:{svg:svg(source)};}});
  const view=f.mount({source:'old'}),old=view.ready;await ticks();view.update('new');await old;assert.equal(f.host.querySelector('svg'),null);
  pending.resolve({svg:svg('stale')});await view.ready;assert.equal(f.host.querySelector('text')!.textContent,'new');assert.equal(f.doc.querySelectorAll('.zorid-mermaid-measure').length,0);
});

test('destroy resolves ready during engine load and cannot attach a late diagram',async t=>{
  const f=setup(t),pending=deferred<MermaidEngine>();let rendered=0;
  const renderer=createMermaidRenderer({loadEngine:()=>pending.promise}),view=renderer.mount(f.host,{source:'a',sourcePath:'x',trust:f.trust});await ticks();view.destroy();await view.ready;
  pending.resolve({initialize(){},async render(){rendered++;return {svg:svg()};}});await ticks();assert.equal(rendered,0);assert.equal(f.host.childElementCount,0);renderer.destroy();
});

test('destroy removes pending measurement/error hosts and consumes a late rejection',async t=>{
  const pending=deferred<{svg:string}>();let temporary:HTMLElement|undefined;
  const f=setup(t,{render(id,_source,host){temporary=host;const error=host.ownerDocument.createElement('div');error.id=`d${id}`;host.ownerDocument.body.append(error);return pending.promise;}});
  const view=f.mount();await ticks();assert.ok(temporary?.isConnected);view.destroy();await view.ready;assert.equal(temporary!.isConnected,false);assert.equal(f.doc.querySelector('[id^="dm-zorid"]'),null);
  pending.reject(new Error('late failure'));await ticks();assert.deepEqual(f.errors,[]);assert.equal(f.host.childElementCount,0);
});

test('trust revoked during render suppresses SVG and retained Allow callback after disposal is inert',async t=>{
  const pending=deferred<{svg:string}>();const f=setup(t,{render:()=>pending.promise}),view=f.mount();await ticks();f.allowed=false;pending.resolve({svg:svg()});await view.ready;
  assert.ok(f.host.querySelector('.is-guarded'));const button=f.host.querySelector<HTMLButtonElement>('button')!;view.destroy();button.click();await ticks();assert.equal(f.requests,0);
});

test('parse errors preserve source, render error text safely and clean owned artifacts',async t=>{
  const f=setup(t,{async render(id,_source,host){const extra=host.ownerDocument.createElement('div');extra.id=`d${id}`;host.ownerDocument.body.append(extra);throw {str:'<img onerror="bad()">'};}});
  const source='graph TD; <broken>';const view=f.mount({source});await view.ready;
  assert.equal(f.host.querySelector('code')!.textContent,source);assert.equal(f.host.querySelector('.zorid-mermaid-error')!.textContent,'Error parsing Mermaid diagram!\n\n<img onerror="bad()">');
  assert.equal(f.host.querySelector('img'),null);assert.equal(f.doc.querySelector('[id^="dm-zorid"]'),null);assert.equal(f.doc.querySelector('.zorid-mermaid-measure'),null);assert.equal(f.errors.length,1);
});

test('engine load failure can retry and does not strand later queue jobs',async t=>{
  const f=setup(t);let attempts=0;
  const renderer=createMermaidRenderer({async loadEngine(){if(++attempts===1)throw new Error('missing module');return f.engine;}});t.after(()=>renderer.destroy());
  const view=renderer.mount(f.host,{source:'a',sourcePath:'x',trust:f.trust});await view.ready;assert.match(f.host.textContent!,/missing module/);
  await view.update('b');assert.equal(attempts,2);assert.ok(f.host.querySelector('svg'));
});

test('detached/hidden hosts defer engine loading and visibility refresh resumes render',async t=>{
  const f=setup(t);f.host.remove();let visible=false;const view=f.mount({isVisible:()=>visible});await ticks();assert.equal(f.loads,0);
  f.doc.body.append(f.host);await ticks();assert.equal(f.loads,0);visible=true;view.refreshVisibility();await view.ready;assert.equal(f.loads,1);
});

test('link repair delegates internal targets and external SVG anchors without invoking bindings',async t=>{
  const links:{target:string;path:string;kind:string}[]=[];
  const f=setup(t,{async render(){return {svg:'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g class="internal-link"><g class="label"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Other note</div></foreignObject></g></g><a xlink:href="https://example.test"><text>External</text></a><a href="javascript:bad()"><text>Bad</text></a><script>bad()</script><rect onclick="bad()"/></svg>'};}});
  const view=f.mount({openLink(_event,target,path,kind){links.push({target,path,kind});}});await view.ready;
  const anchors=f.host.querySelectorAll('a');for(const anchor of anchors)anchor.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.deepEqual(links,[{target:'Other note',path:'Folder/note.md',kind:'internal'},{target:'https://example.test',path:'Folder/note.md',kind:'external'}]);assert.equal(f.host.querySelector('script'),null);assert.equal(f.host.querySelector('[onclick]'),null);assert.equal(anchors[0].getAttribute('href'),'#');
});

test('multiple diagrams namespace markers and preserve style selector boundaries',async t=>{
  const f=setup(t,{async render(){return {svg:'<svg xmlns="http://www.w3.org/2000/svg"><style>#arrow {fill:red} #arrow-extra {fill:blue}</style><defs><marker id="arrow"/></defs><path marker-end="url(#arrow)"/></svg>'};}});
  const other=f.doc.createElement('div');f.doc.body.append(other);const a=f.mount(),b=f.mount({},other);await Promise.all([a.ready,b.ready]);
  const first=f.host.querySelector('marker')!.id,second=other.querySelector('marker')!.id;assert.notEqual(first,second);assert.equal(f.host.querySelector('path')!.getAttribute('marker-end'),`url(#${first})`);assert.match(f.host.querySelector('style')!.textContent!,/#arrow-extra/);
});

test('service disposal cancels queued mounts and rejects future ownership',async t=>{
  const pending=deferred<{svg:string}>(),f=setup(t,{render:()=>pending.promise});const a=f.mount();await ticks();const b=f.mount();f.renderer.destroy();await Promise.all([a.ready,b.ready]);assert.equal(f.host.childElementCount,0);assert.throws(()=>f.mount(),/closed/);pending.resolve({svg:svg()});await ticks();assert.equal(f.host.childElementCount,0);
});
