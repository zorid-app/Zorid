import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { mountBaseRichValue } from '../src/bases/rich-values.ts';
import type { BaseRichPresentation, BaseRichValueOptions } from '../src/bases/rich-values.ts';
import type { BaseExpressionValue } from '../src/bases/expression.ts';
import { baseExpressionValue } from '../src/bases/expression.ts';
import { mountBasePropertyWidget } from '../src/bases/property-widgets.ts';
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function rich(kind: BaseRichPresentation['kind'], value: string, label?: BaseExpressionValue): BaseExpressionValue {
  return {type:'namespace', name:value, presentation:{kind,value,...(label ? {label} : {})},get(){throw new Error('Do not evaluate expression namespaces.');}} as BaseExpressionValue;
}
function setup(value: BaseExpressionValue, options: BaseRichValueOptions = {}) {
  const dom = new JSDOM('<main></main>',{pretendToBeVisual:true,runScripts:'dangerously'}), element = dom.window.document.querySelector('main')!;
  const errors:unknown[]=[]; const dispose=mountBaseRichValue(element,value,{onError:error=>{errors.push(error);},...options});
  return {dom,element,errors,dispose,close(){dispose();dom.window.close();}};
}

test('HTML is rebuilt from inert allowed nodes with active content and unsafe attributes removed', () => {
  const s=setup(rich('html','<b onclick="window.bad=1" style="color:red;position:fixed;background-image:url(https://evil.test/x)">Bold</b><script>window.bad=2</script><iframe src="https://evil.test"></iframe><svg onload="window.bad=3"><script>window.bad=4</script></svg><img src="javascript:alert(1)" onerror="window.bad=5"><a href="java&#x09;script:alert(1)" style="color:blue" id="app">Unsafe</a><x-custom onload="bad()">Plain</x-custom>'));
  assert.equal((s.dom.window as unknown as {bad?:number}).bad,undefined); assert.equal(s.element.querySelector('script,iframe,svg,x-custom'),null);
  assert.equal(s.element.querySelector('[onclick],[onerror],[onload],[id],[srcset]'),null); assert.equal(s.element.querySelector('img')!.getAttribute('src'),null); assert.equal(s.element.querySelector('a')!.getAttribute('href'),null);
  const bold=s.element.querySelector('b')!;assert.equal(bold.style.color,'red');assert.equal(bold.style.position,'');assert.equal(bold.style.backgroundImage,'');assert.match(s.element.textContent!,/BoldUnsafePlain/);s.close();
});

test('links preserve modifier/middle events and recursively render rich labels without nested anchors', () => {
  const calls:{path:string;event:MouseEvent|KeyboardEvent}[]=[];
  const label={type:'list',value:[rich('icon','check'),rich('html','<strong>Done</strong>'),rich('link','Other.md',baseExpressionValue('nested'))]} as BaseExpressionValue;
  const s=setup(rich('link','Target.md',label),{openFile:(path,event)=>{calls.push({path,event});}});const link=s.element.querySelector('a')!;
  assert.equal(s.element.querySelectorAll('a').length,1);assert.ok(link.querySelector('svg'));assert.ok(link.querySelector('strong'));assert.match(link.textContent!,/Done/);
  const event=new s.dom.window.MouseEvent('auxclick',{button:1,metaKey:true,bubbles:true,cancelable:true});link.dispatchEvent(event);assert.equal(calls[0].path,'Target.md');assert.equal(calls[0].event,event);assert.equal(event.defaultPrevented,true);s.close();
});

test('unsafe schemes never invoke link callbacks; HTTPS links carry external isolation attributes', () => {
  const opened:string[]=[];const s=setup({type:'list',value:[rich('link','javascript:alert(1)'),rich('link','data:text/html,evil'),rich('link','https://example.com',baseExpressionValue('External'))]},{openFile:path=>opened.push(path)});
  const links=[...s.element.querySelectorAll('a')];links.forEach(link=>link.dispatchEvent(new s.dom.window.MouseEvent('click',{bubbles:true,cancelable:true})));assert.deepEqual(opened,['https://example.com']);assert.equal(links[2].rel,'noopener noreferrer');assert.equal(links[2].referrerPolicy,'no-referrer');assert.equal(links[2].target,'_blank');s.close();
});

test('external images allow only HTTP(S), are lazy and send no referrer', () => {
  let loads=0;const s=setup({type:'list',value:[rich('image','https://images.test/cover.png'),rich('image','file:///secret.png'),rich('image','data:image/svg+xml,evil')]},{loadImage:async()=>{loads++;return null;}});
  const images=s.element.querySelectorAll('img');assert.equal(images[0].getAttribute('src'),'https://images.test/cover.png');assert.equal(images[0].loading,'lazy');assert.equal(images[0].referrerPolicy,'no-referrer');assert.equal(images[1].getAttribute('src'),null);assert.equal(images[2].getAttribute('src'),null);assert.equal(loads,0);s.close();
});

test('local image leases are aborted and released exactly once even when delivered after disposal', async () => {
  let deliver!: (resource:{url:string;dispose():void})=>void, signal:AbortSignal|undefined, released=0;
  const s=setup(rich('image','covers/book.png'),{loadImage:async(_source,requestSignal)=>{signal=requestSignal;return new Promise(resolve=>{deliver=resolve;});}});await tick();assert.equal(signal!.aborted,false);s.dispose();assert.equal(signal!.aborted,true);deliver({url:'blob:late',dispose(){released++;}});await tick();assert.equal(released,1);assert.equal(s.element.querySelector('img'),null);s.close();
});

test('mounted image resources release on destroy and unsafe host leases are refused', async () => {
  let releases=0;const s=setup({type:'list',value:[rich('image','one.png'),rich('html','<img src="two.png" alt="two">')]},{loadImage:async source=>({url:source==='one.png'?'blob:one':'javascript:alert(1)',dispose(){releases++;}})});await tick();const images=s.element.querySelectorAll('img');assert.equal(images[0].src,'blob:one');assert.equal(images[1].getAttribute('src'),null);assert.equal(releases,1);assert.match(String(s.errors[0]),/unsupported/);s.dispose();assert.equal(releases,2);s.close();
});

test('large HTML, cyclic labels and deep values terminate without executing getters', () => {
  const cyclic=rich('link','A.md') as BaseExpressionValue & {presentation:{kind:'link';value:string;label?:BaseExpressionValue}};cyclic.presentation.label=cyclic;
  const s=setup(cyclic);assert.match(s.element.textContent!,/cycle/);assert.equal(s.errors.length,1);s.close();
  const big=setup(rich('html','<b>x</b>'.repeat(50)),{maxNodes:10});assert.match(big.element.textContent!,/too large/);big.close();
  let gets=0;const getter={type:'namespace',name:'inert',get(){gets++;},get presentation(){gets++;return{kind:'html',value:'bad'};}} as unknown as BaseExpressionValue;const g=setup(getter);assert.equal(gets,0);assert.equal(g.element.textContent,'inert');g.close();
});

test('property hook keeps formula rich values readonly and passes captured image mount context', async () => {
  const dom=new JSDOM('<main></main>'),element=dom.window.document.querySelector('main')!, value=rich('image','cover.png'), row={path:'Original.md',values:{'formula.cover':value}};let edits=0,released=0;const requests:unknown[]=[];
  const presentation={row,property:'formula.cover',value,version:14};const dispose=mountBasePropertyWidget(element,presentation,{getDefinition:()=>undefined,commit(){edits++;},loadImage:async(source,signal,captured)=>{requests.push({source,signal,captured});return{url:'blob:cover',dispose(){released++;}};}});await tick();element.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.equal(edits,0);assert.equal(element.querySelector('input'),null);assert.equal(element.classList.contains('mod-error'),false);assert.equal((requests[0] as {captured:unknown}).captured,presentation);dispose();assert.equal(released,1);dom.window.close();
});


test('rich file-link opening carries its exact target witness and never runs label accessors', () => {
  let captured:unknown,gets=0;const value=rich('link','Target.md') as BaseExpressionValue & {presentation:BaseRichPresentation};value.presentation={kind:'link',value:'Target.md',target:{entryId:'target-1',revision:'r7'},label:{type:'string',get value(){gets++;return 'unsafe';}} as BaseExpressionValue};
  const s=setup(value,{openFile:(_path,_event,witness)=>{captured=witness;}});s.element.querySelector('a')!.dispatchEvent(new s.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));assert.deepEqual(captured,{entryId:'target-1',revision:'r7'});assert.equal(gets,0);s.close();
});
test('rich links forward core heading metadata independently from literal filename characters',()=>{
 for(const subpath of ['#^block',undefined]){
  let captured:unknown;const value=rich('link','People/A#B.md') as BaseExpressionValue & {presentation:BaseRichPresentation};
  value.presentation={kind:'link',value:'People/A#B.md',...(subpath?{subpath}:{}),target:{entryId:'ada',revision:'r1'}};
  const s=setup(value,{openFile:(_path,_event,witness)=>{captured=witness;}});s.element.querySelector('a')!.dispatchEvent(new s.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.deepEqual(captured,{entryId:'ada',revision:'r1',...(subpath?{subpath}:{})});s.close();
 }
});


test('list rendering never invokes accessor elements or array callback methods', () => {
  let gets=0;const getter:BaseExpressionValue[]=[];Object.defineProperty(getter,0,{enumerable:true,get(){gets++;return baseExpressionValue('executed');}});getter.length=1;const s=setup({type:'list',value:getter});assert.equal(gets,0);assert.match(s.element.textContent!,/inert own values/);s.close();
  const callbacks=[baseExpressionValue('safe')];Object.defineProperty(callbacks,'forEach',{get(){gets++;throw new Error('array method getter');}});const t=setup({type:'list',value:callbacks});assert.equal(gets,0);assert.equal(t.element.textContent,'safe');t.close();
});
