import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readFixture} from './owned-fixtures.mjs';

const books=Array.from({length:72},(_,index)=>`Book ${String(index+1).padStart(3,'0')}.md`);
const otherMarkdown=['Author Ada.md','Author Grace.md','Context One.md','Context Two.md','Embed host.md','Missing properties.md','Not a book.md','Templates/Book.md'];
const expectedMarkdown=[...books,...otherMarkdown].sort();

/** Read every ordinary Markdown file, including templates, without querying a
 * Base or using its membership filter as a relationship source selection. */
export async function readRelationSources(vault){
  const root=path.resolve(vault),sources=new Map();let visited=0;
  assert.equal(await fs.realpath(root),root,'Owned relation vault has no aliased ancestors');
  async function visit(relative='',depth=0){
    assert.ok(depth<=4,'Bounded owned relation fixture depth');
    const directory=path.join(root,relative),stat=await fs.lstat(directory);
    assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'Owned relation directory is not a symlink');
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      assert.ok(++visited<=256,'Bounded complete owned relation inventory');
      assert.equal(entry.isSymbolicLink(),false,'Owned relation inventory cannot follow symlinks');
      const file=relative?relative+'/'+entry.name:entry.name;
      if(entry.isDirectory())await visit(file,depth+1);
      else{assert.ok(entry.isFile(),'Ordinary owned fixture file');if(/\.md$/i.test(file))sources.set(file,await readFixture(root,file));}
    }
  }
  await visit();return sources;
}

/** Handwritten heavy-journey contract. This recognizes only its three authored
 * link spellings; it is not a second production link resolver or query engine. */
export function wholeFileRelationOracle(sources,frontmatter,template){
  assert.deepEqual([...sources.keys()].sort(),expectedMarkdown,'Every owned Markdown source participates in the independent oracle');
  assert.equal(sources.get('Templates/Book.md'),template,'The complete literal template stays byte-identical');
  const result={'Author Ada.md':{paths:[],ratings:[]},'Author Grace.md':{paths:[],ratings:[]}};
  for(const [file,source] of sources){
    assert.equal(typeof source,'string');const properties=frontmatter(source);
    const index=books.indexOf(file);
    if(index>=0){
      assert.equal(properties.author,index===0?'[[/Author%20Grace.md]]':index%2?'[[Author Grace]]':'[[Author Ada]]',`${file} retains its exact intended author text`);
      assert.equal(properties.rating,index===0?4:index%5+1,`${file} retains its intended post-undo numeric rating`);
      const body=source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
      assert.equal(body,`# ${file.slice(0,-3)}\n\nExact body marker ${index} 😀\n`,`${file} retains its complete body after the frontmatter boundary`);
    }else if(file==='Templates/Book.md'){assert.equal(properties.author,'[[Author Ada]]');assert.equal(properties.rating,3);}
    else assert.equal(properties.author,undefined,`${file} has no authored relation`);
    if(properties.author===undefined)continue;
    const target={'[[Author Ada]]':'Author Ada.md','[[Author Grace]]':'Author Grace.md','[[/Author%20Grace.md]]':'Author Grace.md'}[properties.author];
    assert.ok(target,'Only the fixture\'s explicit author links are admitted');
    assert.ok(typeof properties.rating==='number'&&Number.isFinite(properties.rating),'Related rating is a finite number');
    result[target].paths.push(file);result[target].ratings.push({path:file,value:properties.rating});
  }
  const expected={
    'Author Ada.md':[...books.filter((_,index)=>index>0&&index%2===0),'Templates/Book.md'].sort(),
    'Author Grace.md':books.filter((_,index)=>index===0||index%2===1).sort(),
  };
  for(const [author,entry] of Object.entries(result)){
    entry.paths.sort();entry.ratings.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    assert.deepEqual(entry.paths,expected[author],'Exact vault-wide incoming relationship membership for '+author);
    entry.count=entry.paths.length;entry.sum=entry.ratings.reduce((sum,item)=>sum+item.value,0);entry.average=entry.sum/entry.count;
  }
  assert.equal(result['Author Ada.md'].count,36,'35 numbered books plus the ordinary template note');
  assert.equal(result['Author Grace.md'].count,37,'The original 36 books plus reassigned Book001');
  return result;
}

/** Serialized public DOM observation; reads all links within each derived cell,
 * independently of its clipped geometry or the currently visible link text. */
export function authorRelationFrame(document,author){
  const find=property=>[...document.querySelectorAll('[role="gridcell"]')].filter(cell=>cell.dataset.path===author&&cell.dataset.property==='note.'+property);
  const fields=['books','bookCount','averageRating'].map(find);
  if(fields.some(cells=>cells.length!==1))return null;
  const [books,count,average]=fields.map(cells=>cells[0]);
  return{paths:[...books.querySelectorAll('a.internal-link[data-href]')].map(link=>link.dataset.href),count:count.textContent.trim(),average:average.textContent.trim(),
    readonly:fields.map(cells=>cells[0].getAttribute('aria-readonly')),editing:fields.some(cells=>!!cells[0].querySelector('input,textarea,[contenteditable="true"],[data-base-editing]')||cells[0].hasAttribute('data-base-editing')),
    diagnostics:fields.some(cells=>cells[0].matches('.mod-error')||!!cells[0].querySelector('.mod-error,[role="alert"]'))};
}
export function assertAuthorRelations(frame,expected){
  assert.ok(frame,'All three derived cells are present exactly once');
  assert.deepEqual([...frame.paths].sort(),expected.paths,'Reverse relation shows every exact referring file once');
  assert.equal(frame.count,String(expected.count),'Rollup count is exact, not a substring');
  assert.ok(frame.average!==''&&Number.isFinite(Number(frame.average))&&Math.abs(Number(frame.average)-expected.average)<0.000001,'Average rollup covers the same complete incoming file set');
  assert.deepEqual(frame.readonly,['true','true','true'],'Reverse relation and both rollups are read-only');
  assert.equal(frame.editing,false);assert.equal(frame.diagnostics,false);
}
