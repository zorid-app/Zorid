import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'yaml';
import {fixtureFiles,alpha,beta,bodies,initial} from './fixtures.mjs';
import {applyRawEdit,rawEdits} from './raw-oracle.mjs';
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
  const original=fixtureFiles().get('Properties.yaml'),before=parse(original).properties;let source=applyRawEdit(original,'priorityOption');source=applyRawEdit(source,'topicOption');const expected=structuredClone(before);expected.priority.options.push({value:'Picker priority'});expected.topics.options.push({value:'Picker topic'});assert.deepEqual(parse(source).properties,expected);assert.ok(source.startsWith('# Keep this ordinary registry comment exactly.\n'));assert.equal(Object.keys(rawEdits).length,16);
  assert.throws(()=>applyRawEdit(original,'not-a-step'));assert.throws(()=>applyRawEdit('missing expected bytes','tableText'));assert.throws(()=>applyRawEdit('blurb: "Original text" # keep this scalar comment\nblurb: "Original text" # keep this scalar comment','tableText'));
});
