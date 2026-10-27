import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryAdapter,Vault} from '../src/core/index.ts';
import {BaseDocument} from '../src/bases/document.ts';
import {readProperties} from '../src/core/properties.ts';
import {planCollectionEntryCreation} from '../src/databases/creation.ts';
import type {DatabaseCollection} from '../src/core/databases.ts';
const collection:DatabaseCollection={id:'abcdefghijkl',name:'Books',revision:'schema-r1',deleted:false,properties:[{id:'123456789abc',name:'Title',datatype:'text',options:[],default:'Schema default'}]};
test('collection New copies the full literal template body and unmanaged frontmatter without reusing identity',async()=>{
  const body='# Literal {{date}}\r\n\r\n- [ ] Keep every body byte\r\n![[cover.png]]\r\n';
  const template='---\r\n_id: old-entry\r\n_type: Other collection\r\nTitle: Template title\r\ncustom: [keep, this]\r\n---\r\n'+body;
  const vault=new Vault(new MemoryAdapter({'Templates/Book.md':template}));await vault.initialize();
  const document=BaseDocument.parse('views:\n - type: table\n   name: Books\n   source: {kind: collection, id: abcdefghijkl}\n   newItemTemplate: Templates/Book.md\n   filters: note["123456789abc"] == "Filtered title"\n');
  const plan=await planCollectionEntryCreation({vault,collection,document,basePath:'Library.base',viewIndex:0,validate(){}});
  const properties=new Map(readProperties(plan.body).map(property=>[property.key,property.value]));assert.equal(properties.has('_id'),false);assert.equal(properties.has('_type'),false);assert.deepEqual(properties.get('custom'),['keep','this']);assert.ok(plan.body.endsWith(body));assert.deepEqual(plan.values,{'123456789abc':'Filtered title'});assert.deepEqual((await vault.adapter.list()).filter(entry=>entry.type==='file').map(entry=>entry.path),['Templates/Book.md'],'planning does not create or import files');
});
test('an impossible datatype filter leaves a valid template value as creation fallback',async()=>{
  const vault=new Vault(new MemoryAdapter({'Template.md':'---\nTitle: Template title\n---\nBody'}));await vault.initialize();
  const document=BaseDocument.parse('views:\n - type: table\n   name: Books\n   source: {kind: collection, id: abcdefghijkl}\n   newItemTemplate: Template.md\n   filters: note["123456789abc"] == 5\n');
  const plan=await planCollectionEntryCreation({vault,collection,document,basePath:'Library.base',viewIndex:0,validate(){}});assert.deepEqual(plan.values,{'123456789abc':'Template title'});assert.ok(plan.body.endsWith('Body'));
});
