import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parse} from 'yaml';
import {JSDOM} from 'jsdom';
import {fixtureFiles,template} from './fixtures.mjs';
import {readRelationSources,wholeFileRelationOracle,authorRelationFrame,assertAuthorRelations} from './relation-oracle.mjs';

function frontmatter(source){const match=source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);assert.ok(match);return parse(match[1]);}
function sources(){
  const files=new Map([...fixtureFiles()].filter(([file])=>file.endsWith('.md')));
  files.set('Book 001.md',files.get('Book 001.md').replace('rating: 1\n','rating: 4\n').replace('author: "[[Author Ada]]"','author: "[[/Author%20Grace.md]]"'));
  return files;
}
const oracle=()=>wholeFileRelationOracle(sources(),frontmatter,template);
const frame=expected=>({paths:[...expected.paths],count:String(expected.count),average:String(expected.average),readonly:['true','true','true'],editing:false,diagnostics:false});

test('the literal template is an ordinary Ada relation even though Library filters it out',()=>{
  const result=oracle(),ada=result['Author Ada.md'],grace=result['Author Grace.md'];
  assert.equal(ada.count,36);assert.equal(grace.count,37);assert.equal(ada.sum,108);assert.equal(grace.sum,111);assert.equal(ada.average,3);assert.equal(grace.average,3);
  assert.ok(ada.paths.includes('Templates/Book.md'));assert.deepEqual(ada.ratings.find(item=>item.path==='Templates/Book.md'),{path:'Templates/Book.md',value:3});
  assert.deepEqual(grace.paths,['Book 001.md',...Array.from({length:36},(_,index)=>`Book ${String((index+1)*2).padStart(3,'0')}.md`)]);
  assert.equal(ada.paths.filter(file=>/^Book \d{3}\.md$/.test(file)).length,35,'The old numbered-books-only Ada oracle omitted the additional real source');
});
test('all72 original readable link spellings and complete bodies stay exact after the one intended reassignment',()=>{
  for(const change of [files=>files.set('Book 002.md',files.get('Book 002.md').replace('\n# Book 002','\nInserted corruption\n# Book 002')),files=>files.set('Book 003.md',files.get('Book 003.md').replace('[[Author Ada]]','[[/Author%20Ada.md]]')),files=>files.set('Book 001.md',files.get('Book 001.md').replace('[[/Author%20Grace.md]]','[[Author Grace]]')),files=>files.set('Book 002.md',files.get('Book 002.md').replace('Exact body marker 1','Changed body marker 1')),files=>files.set('Book 002.md',files.get('Book 002.md').replace('rating: 2','rating: 4'))]){
    const files=sources();change(files);assert.throws(()=>wholeFileRelationOracle(files,frontmatter,template));
  }
});
test('missing templates, extra Markdown, copied relations and changed template bytes cannot silently alter oracle membership',()=>{
  for(const change of [files=>files.delete('Templates/Book.md'),files=>files.set('Extra.md',template),files=>files.set('Templates/Book.md',template+'Extra byte\n'),files=>files.set('Not a book.md',files.get('Not a book.md').replace('type: project','type: project\nauthor: "[[Author Ada]]"'))]){
    const files=sources();change(files);assert.throws(()=>wholeFileRelationOracle(files,frontmatter,template));
  }
});
test('complete physical inventory includes nested template files and ignores only non-Markdown file formats',async()=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'zorid-relation-oracle-'));
  try{
    for(const [file,source] of sources()){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),source);}
    await fs.writeFile(path.join(root,'New base.base'),'views: []\n');
    const read=await readRelationSources(root);assert.equal(read.size,80);assert.equal(read.get('Templates/Book.md'),template);assert.equal(wholeFileRelationOracle(read,frontmatter,template)['Author Ada.md'].count,36);
    await fs.writeFile(path.join(root,'Templates','Extra.md'),template);assert.throws(()=>wholeFileRelationOracle(new Map([...read,['Templates/Extra.md',template]]),frontmatter,template));
    assert.equal((await readRelationSources(root)).size,81,'The reader does not conceal added files behind a fixture allowlist');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('physical inventory rejects symlinks instead of following or silently skipping them',async()=>{
  const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'zorid-relation-oracle-'));
  try{await fs.writeFile(path.join(root,'Original.md'),template);await fs.symlink('Original.md',path.join(root,'Alias.md'));await assert.rejects(readRelationSources(root),/symlinks/);}
  finally{await fs.rm(root,{recursive:true,force:true});}
});
test('strict derived projections reject wrong or duplicate paths even when count and average agree',()=>{
  const ada=oracle()['Author Ada.md'];assertAuthorRelations(frame(ada),ada);
  for(const change of [value=>value.paths.pop(),value=>{value.paths[0]='Missing properties.md';},value=>{value.paths[0]=value.paths[1];},value=>{value.count='35';},value=>{value.count='136';},value=>{value.average='';},value=>{value.average='3.1';},value=>{value.average='Error';},value=>{value.readonly[0]='false';},value=>{value.editing=true;},value=>{value.diagnostics=true;}]){
    const value=frame(ada);change(value);assert.throws(()=>assertAuthorRelations(value,ada));
  }
});
test('the serialized public DOM reader observes every clipped reverse link and all three read-only cells',()=>{
  const expected=oracle()['Author Ada.md'],dom=new JSDOM('<main></main>');
  try{
    const {document}=dom.window,root=document.querySelector('main');
    for(const property of ['books','bookCount','averageRating']){const cell=document.createElement('div');cell.setAttribute('role','gridcell');cell.dataset.path='Author Ada.md';cell.dataset.property='note.'+property;cell.setAttribute('aria-readonly','true');root.append(cell);if(property==='books'){cell.style.maxHeight='30px';cell.style.overflow='hidden';for(const file of expected.paths){const link=document.createElement('a');link.className='internal-link';link.dataset.href=file;link.textContent=file.replace(/\.md$/,'');cell.append(link);}}else cell.textContent=String(property==='bookCount'?expected.count:expected.average);}
    const read=new dom.window.Function('document','author',`return (${authorRelationFrame.toString()})(document,author);`);
    const observed=JSON.parse(JSON.stringify(read(document,'Author Ada.md')));assertAuthorRelations(observed,expected);assert.equal(observed.paths.length,36);
    root.append(root.lastChild.cloneNode(true));assert.equal(read(document,'Author Ada.md'),null,'Duplicate cells are not an exact projection');
  }finally{dom.window.close();}
});
