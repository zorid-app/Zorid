import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {JSDOM} from 'jsdom';
import {fixtureFiles,alpha,beta,bodies,initial} from './fixtures.mjs';
import {applyRawEdit,rawEdits} from './raw-oracle.mjs';
import {unresolvedRelationWitness} from './campaign.mjs';
function properties(source){const match=/^---\n([\s\S]*?)\n---\n/.exec(source);assert.ok(match);return {properties:parse(match[1]),body:source.slice(match[0].length)};}

test('prelaunch six-file fixture has exact note models and independent comment/quote sentinels',()=>{
  const files=fixtureFiles();assert.equal(files.size,6);
  for(const file of [alpha,beta]){const note=properties(files.get(file));assert.deepEqual(note.properties,initial[file]);assert.equal(note.body,bodies[file]);}
  assert.match(files.get(alpha),/^blurb: "Original text" # keep this scalar comment$/m);assert.match(files.get(alpha),/^untouched: 'leave me' # keep this unrelated comment$/m);
  assert.deepEqual(parse(files.get('Properties.base')).views.map(view=>view.type),['table','cards','list','kanban']);assert.equal(parse(files.get('Properties.yaml')).properties.status.options[1].category,'in-progress');
});

test('every preauthored property edit yields its intended semantic model without dropping unrelated raw bytes',()=>{
  const files=fixtureFiles(),expected=structuredClone(initial[alpha]);let raw=files.get(alpha);
  const steps=[
    ['tableText','blurb','Table text 🌱'],['tableTag','tags',['seed','table-tag']],['tableLink','reference','[[/Targets/Grace.md]]'],
    ['tableStatus','status','Working'],['tablePriority','priority','Picker priority'],['tableTopics','topics',['Legacy','Design','Picker topic']],
    ['addPeer','peers',['[[Beta|Beta alias]]','unresolved literal','[[/Items/Alpha.md]]']],['removePeer','peers',['[[Beta|Beta alias]]','unresolved literal']],
    ['cardsText','blurb','Cards text 🌱'],['cardsTag','tags',['seed','table-tag','cards-tag']],['listPriority','priority','High'],['listLink','reference','[[/Targets/Ada.md]]'],
    ['boardStatus','status','Complete'],['boardTopics','topics',['Legacy','Design','Picker topic','Rust']],
  ];
  for(const [name,key,value]of steps){raw=applyRawEdit(raw,name);expected[key]=value;const result=properties(raw);assert.deepEqual(result.properties,expected,name);assert.equal(result.body,bodies[alpha]);assert.match(raw,/^# Keep this frontmatter comment exactly\.$/m);assert.match(raw,/^blurb: "[^"\n]+" # keep this scalar comment$/m);assert.match(raw,/^untouched: 'leave me' # keep this unrelated comment$/m);assert.match(raw,/^author: "\[\[\.\.\/Targets\/Ada\|Original Ada\]\]"$/m);}
  assert.equal(steps.length,14);assert.equal(files.get(beta),fixtureFiles().get(beta));
});

test('registry option raw patches preserve exact comment and every unchanged definition',()=>{
  const original=fixtureFiles().get('Properties.yaml'),before=parse(original).properties;let source=applyRawEdit(original,'priorityOption');source=applyRawEdit(source,'topicOption');const expected=structuredClone(before);expected.priority.options.push({value:'Picker priority'});expected.topics.options.push({value:'Picker topic'});assert.deepEqual(parse(source).properties,expected);assert.ok(source.startsWith('# Keep this ordinary registry comment exactly.\n'));assert.equal(Object.keys(rawEdits).length,18);
  assert.throws(()=>applyRawEdit(original,'not-a-step'));assert.throws(()=>applyRawEdit('missing expected bytes','tableText'));assert.throws(()=>applyRawEdit('blurb: "Original text" # keep this scalar comment\nblurb: "Original text" # keep this scalar comment','tableText'));
});

test('mixed-list fixture stays unconfigured and its missing relation has no target file in any layout',()=>{
  const files=fixtureFiles(),registry=parse(files.get('Properties.yaml')).properties;
  assert.equal(Object.hasOwn(registry,'mixedRaw'),false,'Raw List editing must not depend on a declared property type');
  assert.deepEqual(registry.missingAuthor,{type:'relation',relation:{targetFilter:'type == "person"'}});
  assert.equal(files.has('Targets/Missing.md'),false);assert.equal(files.has('Targets/Missing'),false);
  assert.equal(properties(files.get(alpha)).properties.missingAuthor,'[[../Targets/Missing|Missing person]]');
  const views=parse(files.get('Properties.base')).views;assert.equal(views.length,4);
  for(const view of views)assert.deepEqual(view.order.slice(-2),['note.mixedRaw','note.missingAuthor'],view.type);
});

test('handwritten mixed-list add/remove sources retain exact types, readable links, unrelated source and full body',()=>{
  const files=fixtureFiles(),original=files.get(alpha),base=structuredClone(initial[alpha]);
  const added=[42,true,null,[7,'nested'],{nested:[false,3]},'[[../Targets/Ada#^block|Ada alias]]','Native mixed item'];
  const removed=[42,null,[7,'nested'],{nested:[false,3]},'[[../Targets/Ada#^block|Ada alias]]','Native mixed item'];
  let source=original;
  for(const [name,values]of [['addMixedRaw',added],['removeMixedBoolean',removed]]){
    source=applyRawEdit(source,name);const note=properties(source);
    assert.deepEqual(note.properties,{...base,mixedRaw:values},name);assert.equal(note.body,bodies[alpha]);
    assert.equal(note.properties.mixedRaw[0],42);assert.equal(typeof note.properties.mixedRaw[0],'number');
    assert.match(source,/^  - "\[\[\.\.\/Targets\/Ada#\^block\|Ada alias\]\]"$/m);
    assert.match(source,/^missingAuthor: "\[\[\.\.\/Targets\/Missing\|Missing person\]\]"$/m);
    const [oldSpan,newSpan]=rawEdits[name];assert.equal(source.replace(newSpan,oldSpan),name==='addMixedRaw'?original:applyRawEdit(original,'addMixedRaw'),'Only the independently authored property span changes');
  }
  assert.notEqual(source,original,'Restart must retain a distinct edited value rather than a round trip back to the fixture');
  assert.deepEqual(initial[alpha],base,'Expected mutations do not alter the prelaunch model');assert.equal(files.get(beta),fixtureFiles().get(beta));
});

function missingPresentation(){
  const dom=new JSDOM('<section class="pane is-active"><div class="bases-session" data-base-controller-version="7" data-base-controller-updating="false" data-base-controller-error="false"><div class="bases-session-content" aria-busy="false"><span id="missing" data-property="note.missingAuthor" data-base-widget-version="7"><span class="multi-select-pill is-unresolved" title="Unresolved relation or target outside available choices. Its stored value is preserved."><span class="multi-select-pill-content">Missing person</span></span></span></div></div></section>');
  const document=dom.window.document,selector='.pane.is-active #missing',element=document.querySelector(selector),pill=element.firstElementChild;
  dom.window.HTMLElement.prototype.getClientRects=function(){return this.isConnected&&!this.closest('[hidden]')?[{width:100,height:20}]:[];};
  return{dom,document,selector,element,pill,session:document.querySelector('.bases-session'),content:document.querySelector('.bases-session-content')};
}
test('missing relation public oracle rejects navigable, ambiguous, stale and unavailable presentations',()=>{
  const f=missingPresentation();try{assert.deepEqual(unresolvedRelationWitness(f.document,f.selector),{property:'note.missingAuthor',label:'Missing person',title:'Unresolved relation or target outside available choices. Its stored value is preserved.',unresolved:true,navigationSemantics:false,widgetVersion:'7'});}finally{f.dom.window.close();}
  for(const state of ['role-link','internal-link','anchor','href','wrong-label','wrong-title','not-unresolved','duplicate','old-widget','no-widget','updating','error','busy','hidden','inert','editing','inactive']){
    const f=missingPresentation();try{
      if(state==='role-link')f.pill.setAttribute('role','link');if(state==='internal-link')f.pill.classList.add('internal-link');if(state==='anchor')f.pill.append(f.document.createElement('a'));if(state==='href')f.pill.setAttribute('href','#');
      if(state==='wrong-label')f.pill.firstElementChild.textContent='Other person';if(state==='wrong-title')f.pill.title='Loaded link';if(state==='not-unresolved')f.pill.classList.remove('is-unresolved');if(state==='duplicate')f.element.append(f.pill.cloneNode(true));
      if(state==='old-widget')f.element.dataset.baseWidgetVersion='6';if(state==='no-widget')delete f.element.dataset.baseWidgetVersion;if(state==='updating')f.session.dataset.baseControllerUpdating='true';if(state==='error')f.session.dataset.baseControllerError='true';if(state==='busy')f.content.setAttribute('aria-busy','true');
      if(state==='hidden')f.pill.hidden=true;if(state==='inert')f.element.setAttribute('inert','');if(state==='editing')f.element.dataset.baseEditing='draft';if(state==='inactive')f.document.querySelector('.pane').classList.remove('is-active');
      assert.equal(unresolvedRelationWitness(f.document,f.selector),false,state);
    }finally{f.dom.window.close();}
  }
});
