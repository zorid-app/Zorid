import type { DocumentSourceId } from '../core/document-semantics.ts';
import type { CoreSearchExplanation, DocumentRichSearchPage, ExplanationNode, SearchFileChunk, SearchLocation, SearchSort, SearchSpec } from '../core/document-search-types.ts';
import { icon } from './icons.ts';

/** Aggregation and request/source admission belong to the controller. These are
 * bounded already-validated projections, never independent search results. */
export type DocumentSearchGroup = Pick<SearchFileChunk, 'entry'|'occurrenceCount'|'locations'|'snippets'> & { readonly outputComplete:boolean };
export interface DocumentSearchFrame {
  readonly scopeId:string;
  readonly requestId:string;
  readonly spec:SearchSpec;
  readonly phase:'idle'|'loading'|'results'|'error';
  readonly groups:readonly DocumentSearchGroup[];
  readonly result?:Pick<DocumentRichSearchPage, 'snapshot'|'totals'|'coverage'|'coverageComplete'|'outputComplete'|'complete'|'explanation'> & {readonly source:DocumentSourceId};
  readonly stale:boolean;
  readonly displayTruncated:boolean;
  readonly canExplain:boolean;
  readonly message?:string;
  readonly actions:readonly ('loadMore'|'refresh'|'retry'|'rebuild')[];
}
export interface DocumentSearchIdentity {readonly scopeId:string;readonly requestId:string}
export interface DocumentSearchCallbacks {
  onSearch(identity:DocumentSearchIdentity, spec:SearchSpec):void;
  onOpen(identity:DocumentSearchIdentity, entry:SearchFileChunk['entry'], location:SearchLocation|undefined, modifiers:{readonly primary:boolean;readonly shift:boolean;readonly alt:boolean}):void;
  onAction(identity:DocumentSearchIdentity, action:DocumentSearchFrame['actions'][number]):void;
}
export interface DocumentSearchView { render(frame:DocumentSearchFrame):void;focusQuery(select?:boolean):void;destroy():void }
const sorts:readonly [SearchSort,string][] = [
  ['nameAsc','File name (A to Z)'],['nameDesc','File name (Z to A)'],
  ['modifiedDesc','Modified time (new to old)'],['modifiedAsc','Modified time (old to new)'],
  ['createdDesc','Created time (new to old)'],['createdAsc','Created time (old to new)'],
];
let sequence = 0;

/** Presentation only: no source IO, query parser, counting, sorting or pin/cursor
 * ownership. Highlight slices are exactly the core-supplied local UTF16 spans. */
export function createDocumentSearchView(parent:HTMLElement, callbacks:DocumentSearchCallbacks):DocumentSearchView {
  const doc=parent.ownerDocument, id=++sequence;
  const make=<K extends keyof HTMLElementTagNameMap>(tag:K, cls='', text?:string):HTMLElementTagNameMap[K]=>{
    const node=doc.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;
  };
  const root=make('section','document-search');root.setAttribute('aria-label','Search vault');
  const bar=make('div','document-search-bar'), fieldWrap=make('div','document-search-field');
  const field=make('input');field.type='search';field.placeholder='Search vault…';field.setAttribute('aria-label','Search vault');field.autocomplete='off';field.spellcheck=false;
  const button=(label:string,glyph:string)=>{const node=make('button','document-search-button');node.type='button';node.title=label;node.setAttribute('aria-label',label);node.append(icon(glyph,16,doc));return node;};
  const clear=button('Clear search','close'), caseButton=make('button','document-search-button document-search-case','Aa');caseButton.type='button';caseButton.title='Match case';caseButton.setAttribute('aria-label','Match case');caseButton.setAttribute('aria-pressed','false');
  const settings=button('Search options','settings'), options=make('div','document-search-options');options.id=`document-search-options-${id}`;options.hidden=true;settings.setAttribute('aria-controls',options.id);settings.setAttribute('aria-expanded','false');
  fieldWrap.append(icon('search',16,doc),field,clear);bar.append(fieldWrap,caseButton,settings);
  const check=(label:string)=>{const wrap=make('label'),input=make('input');input.type='checkbox';wrap.append(input,doc.createTextNode(label));options.append(wrap);return input;};
  const collapse=check('Collapse all results'), context=check('Show more context'), explain=check('Explain search');
  const info=make('div','document-search-info'), totals=make('span','document-search-total'), sort=make('select','document-search-sort');sort.setAttribute('aria-label','Sort search results');
  for(const [value,label]of sorts){const option=make('option','',label);option.value=value;sort.append(option);}info.append(totals,sort);
  const status=make('p','document-search-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.id=`document-search-status-${id}`;field.setAttribute('aria-describedby',status.id);
  const explanation=make('div','document-search-explanation'), results=make('div','document-search-results'), actions=make('div','document-search-actions');
  root.append(bar,options,info,status,explanation,results,actions);parent.append(root);
  let frame:DocumentSearchFrame|undefined, disposed=false, composing=false, epoch=0, groupEpoch=0, scope='', compositionScope='', compositionRequest='', collapsed=new Map<string,boolean>();
  const live=(stamp=epoch)=>!disposed&&!!frame&&stamp===epoch;
  const identity=():DocumentSearchIdentity=>({scopeId:frame!.scopeId,requestId:frame!.requestId});
  const groupKey=(group:DocumentSearchGroup)=>group.entry.id;
  const emit=(changes:Partial<SearchSpec>)=>{if(!live()||composing)return;callbacks.onSearch(identity(),{...frame!.spec,query:field.value,...changes});};
  field.addEventListener('input',event=>{clear.disabled=composing||!field.value;if(!(event as InputEvent).isComposing)emit({});});
  field.addEventListener('compositionstart',()=>{composing=true;compositionScope=frame?.scopeId??'';compositionRequest=frame?.requestId??'';clear.disabled=true;});
  field.addEventListener('compositionend',()=>{composing=false;if(!live())return;if(compositionScope!==frame!.scopeId||compositionRequest!==frame!.requestId){field.value=frame!.spec.query;}else emit({});clear.disabled=!field.value;});
  field.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&!composing&&event.keyCode!==229){event.preventDefault();emit({});}});
  clear.addEventListener('click',()=>{if(!live()||composing)return;field.value='';emit({query:''});field.focus();});
  caseButton.addEventListener('click',()=>emit({caseSensitive:!frame?.spec.caseSensitive}));
  sort.addEventListener('change',()=>emit({sort:sort.value as SearchSort}));
  context.addEventListener('change',()=>emit({context:context.checked?'section':'line'}));
  explain.addEventListener('change',()=>{if(frame?.canExplain)emit({explain:explain.checked});});
  settings.addEventListener('click',()=>{if(!live())return;options.hidden=!options.hidden;settings.setAttribute('aria-expanded',String(!options.hidden));});
  collapse.addEventListener('change',()=>{if(!live())return;for(const group of frame!.groups)collapsed.set(groupKey(group),collapse.checked);paintGroups();});
  const countText=(count:DocumentRichSearchPage['totals']['files'])=>count.relation==='unknown'?'Unknown':`${count.value.toLocaleString('en-US')}${count.relation==='atLeast'?'+':''}`;
  function open(group:DocumentSearchGroup, location:SearchLocation|undefined,event:MouseEvent,stamp:number,groupStamp:number):void{
    if(!live(stamp)||groupStamp!==groupEpoch)return;callbacks.onOpen(identity(),group.entry,location,{primary:event.metaKey||event.ctrlKey,shift:event.shiftKey,alt:event.altKey});
  }
  function paintGroups():void{
    const stamp=epoch, groupStamp=++groupEpoch, focused=results.contains(doc.activeElement)?(doc.activeElement as HTMLElement).dataset.focusKey:undefined;
    const fragment=doc.createDocumentFragment();
    for(const group of frame!.groups){
      const key=groupKey(group),closed=collapsed.get(key)??collapse.checked, section=make('section','document-search-file');section.dataset.entryId=key;
      const header=make('div','document-search-file-header'), disclosure=button(closed?'Expand file results':'Collapse file results','right'), title=make('button','document-search-title');title.type='button';
      const body=make('div','document-search-contexts');body.id=`document-search-file-${id}-${fragment.childNodes.length}`;body.hidden=closed;disclosure.setAttribute('aria-controls',body.id);disclosure.setAttribute('aria-expanded',String(!closed));
      disclosure.dataset.focusKey=`disclosure:${key}`;title.dataset.focusKey=`title:${key}`;
      const path=group.entry.path, slash=path.lastIndexOf('/');title.append(make('span','document-search-name',path.slice(slash+1)||path));
      if(slash>=0)title.append(make('span','document-search-path',path.slice(0,slash)));
      title.title=path;title.addEventListener('click',event=>open(group,undefined,event,stamp,groupStamp));
      const badge=make('span','document-search-badge',group.occurrenceCount.toLocaleString('en-US'));badge.setAttribute('aria-label',`${group.occurrenceCount.toLocaleString('en-US')} matches in this file`);
      const setClosed=(value:boolean)=>{if(!live(stamp)||groupStamp!==groupEpoch)return;collapsed.set(key,value);body.hidden=value;disclosure.setAttribute('aria-expanded',String(!value));disclosure.setAttribute('aria-label',value?'Expand file results':'Collapse file results');disclosure.title=value?'Expand file results':'Collapse file results';};
      disclosure.addEventListener('click',()=>setClosed(!body.hidden));
      header.addEventListener('keydown',event=>{
        if(!live(stamp)||groupStamp!==groupEpoch||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey)return;
        if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();setClosed(event.key==='ArrowLeft');}
        else if(event.key==='ArrowUp'||event.key==='ArrowDown'){
          const nodes=[...results.querySelectorAll<HTMLButtonElement>('.document-search-title')],index=nodes.indexOf(title),next=index+(event.key==='ArrowDown'?1:-1);
          if(nodes[next]){event.preventDefault();nodes[next].focus();}
        }
      });
      header.append(disclosure,title,badge);section.append(header,body);
      const locations=new Map(group.locations.map(location=>[location.index,location]));
      for(let index=0;index<group.snippets.length;index++){
        const snippet=group.snippets[index], row=make('button','document-search-snippet');row.type='button';row.dataset.focusKey=`snippet:${key}:${index}`;
        const primary=locations.get(snippet.primaryLocationIndex)!;
        const label=snippet.origin==='source'?'':snippet.origin==='propertyKey'?`Property: ${snippet.key??''}`:snippet.origin==='propertyValue'?`Property value: ${snippet.key??''}`:snippet.origin==='filename'?'File name':'File path';
        if(label)row.append(make('span','document-search-origin',label));
        const text=make('span','document-search-excerpt');if(snippet.clippedBefore)text.append(make('span','document-search-ellipsis','…'));
        let offset=0;
        for(const highlight of snippet.highlights){text.append(doc.createTextNode(snippet.text.slice(offset,highlight.utf16[0])));text.append(make('mark','',snippet.text.slice(highlight.utf16[0],highlight.utf16[1])));offset=highlight.utf16[1];}
        text.append(doc.createTextNode(snippet.text.slice(offset)));if(snippet.clippedAfter)text.append(make('span','document-search-ellipsis','…'));row.append(text);
        row.addEventListener('click',event=>open(group,primary,event,stamp,groupStamp));body.append(row);
      }
      if(!group.outputComplete)body.append(make('p','document-search-file-pending','More results in this file are available.'));
      fragment.append(section);
    }
    results.replaceChildren(fragment);
    if(focused){const node=[...results.querySelectorAll<HTMLElement>('[data-focus-key]')].find(node=>node.dataset.focusKey===focused);node?.focus({preventScroll:true});}
  }
  function paintExplanation(value:CoreSearchExplanation|null):void{
    explanation.replaceChildren();explanation.hidden=!frame!.spec.explain;
    if(explanation.hidden)return;
    if(!value){explanation.append(make('p','',frame!.phase==='loading'?'Preparing search explanation…':'Search explanation is unavailable.'));return;}
    if(!value.root){explanation.append(make('p','','Enter a query to explain its meaning.'));return;}
    const render=(node:ExplanationNode):HTMLElement=>{const item=make('li'), label=make('span','',node.operand===null?node.kind:`${node.kind}: ${node.operand}`);item.append(label);if(node.scope)item.append(make('span','document-search-origin',` (${node.scope})`));if(node.children.length){const list=make('ul');for(const child of node.children)list.append(render(child));item.append(list);}return item;};
    const list=make('ul');list.append(render(value.root));explanation.append(list);
  }
  return {render(next){
    if(disposed)return;epoch++;frame=next;
    if(scope!==next.scopeId){scope=next.scopeId;collapsed.clear();collapse.checked=false;}
    const keys=new Set(next.groups.map(groupKey));for(const key of collapsed.keys())if(!keys.has(key))collapsed.delete(key);
    if(!composing&&field.value!==next.spec.query)field.value=next.spec.query;
    clear.disabled=composing||!field.value;caseButton.setAttribute('aria-pressed',String(next.spec.caseSensitive));sort.value=next.spec.sort;context.checked=next.spec.context==='section';explain.checked=next.spec.explain;explain.disabled=!next.canExplain;
    explain.title=next.canExplain?'':'Search explanations are unavailable.';
    const result=next.result;totals.textContent=result?`${countText(result.totals.occurrences)} matches in ${countText(result.totals.files)} files`:'';
    const notes:string[]=[];
    if(next.message)notes.push(next.message);
    if(next.phase==='loading')notes.push('Searching…');
    if(next.stale)notes.push('Results are from an earlier snapshot. Refresh to update them.');
    if(result&&!result.coverageComplete)notes.push('Some vault files have incomplete search data.');
    if(result&&!result.coverage.scanComplete)notes.push('Search is still scanning files.');
    if(result&&result.coverage.unavailableFiles>0)notes.push('Some files could not be searched.');
    else if(result&&result.coverage.scanComplete&&!result.coverage.queryCoverageComplete)notes.push('Search coverage is incomplete.');
    if(result&&!result.outputComplete)notes.push('More results are available.');
    if(next.displayTruncated)notes.push('Only part of the results is shown.');
    if(next.phase==='results'&&result?.complete&&result.totals.files.relation==='exact'&&result.totals.files.value===0&&!next.stale)notes.push('No matching files.');
    if(next.phase==='idle')notes.push('Enter a query to search your vault.');
    if(next.phase==='error'&&!next.message)notes.push('Search could not be completed. Try again.');
    const text=notes.join(' ');if(status.textContent!==text)status.textContent=text;
    root.setAttribute('aria-busy',String(next.phase==='loading'));paintGroups();paintExplanation(result?.explanation??null);
    actions.replaceChildren();const stamp=epoch;
    for(const action of next.actions){const node=make('button','',({loadMore:'Load more results',refresh:'Refresh results',retry:'Try search again',rebuild:'Rebuild search index'})[action]);node.type='button';node.addEventListener('click',()=>{if(live(stamp))callbacks.onAction(identity(),action);});actions.append(node);}
  },focusQuery(select=false){if(disposed)return;field.focus();if(select)field.select();},destroy(){if(disposed)return;disposed=true;epoch++;frame=undefined;collapsed.clear();root.remove();}};
}
