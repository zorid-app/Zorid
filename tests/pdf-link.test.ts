import test from 'node:test';
import assert from 'node:assert/strict';
import {Vault,MemoryAdapter} from '../src/core/index.ts';
import {pdfMarkdownLink} from '../src/ui/pdf-link.ts';
const setup=async(seed:Record<string,string>={'Folder/Paper.pdf':'pdf'})=>{const vault=new Vault(new MemoryAdapter(seed));await vault.initialize();return vault;};
test('PDF copy links reuse path policy with the audited empty source, always without embedding',async()=>{
  const vault=await setup();assert.equal(pdfMarkdownLink(vault,'Folder/Paper.pdf','#page=2','Paper, page 2'),'[[Paper.pdf#page=2|Paper, page 2]]');
  assert.equal(pdfMarkdownLink(vault,'Folder/Paper.pdf','#page=2','Paper, page 2',{newLinkFormat:'relative'}),'[[./Folder/Paper.pdf#page=2|Paper, page 2]]');
  assert.equal(pdfMarkdownLink(vault,'Folder/Paper.pdf','#page=2','Paper, page 2',{newLinkFormat:'absolute',useMarkdownLinks:true}),'[Paper, page 2](Folder/Paper.pdf#page=2)');
});
test('ambiguous basenames keep the full PDF target and selection tuple',async()=>{
  const vault=await setup({'A/Paper.pdf':'a','B/Paper.pdf':'b'});assert.equal(pdfMarkdownLink(vault,'B/Paper.pdf','#page=3&selection=0,1,2,4','Paper, page 3'),'[[B/Paper.pdf#page=3&selection=0,1,2,4|Paper, page 3]]');
});
test('Markdown path/alias escaping preserves already encoded annotation ids',async()=>{
  const vault=await setup({'Folder/Paper (draft)%.pdf':'pdf'});assert.equal(pdfMarkdownLink(vault,'Folder/Paper (draft)%.pdf',"#page=2&annotation=id%20(7)%2F",'Paper [draft] | draft, page 2',{useMarkdownLinks:true,newLinkFormat:'absolute'}),'[Paper \\[draft\\] | draft, page 2](Folder/Paper%20%28draft%29%25.pdf#page=2&annotation=id%20%287%29%2F)');
});
test('unrepresentable wiki delimiters use an exact Markdown link instead of changing the destination',async()=>{
  const vault=await setup({'A|B.pdf':'pdf'});assert.equal(pdfMarkdownLink(vault,'A|B.pdf','#page=1','A|B, page 1'),'[A|B, page 1](A|B.pdf#page=1)');
  const normal=await setup();assert.equal(pdfMarkdownLink(normal,'Folder/Paper.pdf','#page=1','Paper ]] label'),'[Paper \\]\\] label](Paper.pdf#page=1)');
});
test('missing/non-PDF targets and malformed fragments provide no copy-link capability',async()=>{
  const vault=await setup({'Note.md':'note','Paper.pdf':'pdf'});for(const[path,fragment]of[['Missing.pdf','#page=1'],['Note.md','#page=1'],['Paper.pdf','page=1'],['Paper.pdf','#page=1\nBAD']])assert.equal(pdfMarkdownLink(vault,path,fragment,'label'),null);
});

test('generated links render their full alias and resolve reserved literal PDF filenames exactly',async()=>{
  const {JSDOM}=await import('jsdom'),{renderMarkdownInline}=await import('../src/ui/markdown-inline.ts');
  const vault=await setup({'A#B.pdf':'hash','A%20B.pdf':'literal percent','A B.pdf':'space','Plain.pdf':'plain'}),dom=new JSDOM('<main></main>');
  try{for(const[path,alias]of[['A#B.pdf','A#B, page 1'],['A%20B.pdf','A%20B, page 1'],['Plain.pdf','Label [[x'],['Plain.pdf','Label]']]){
    const link=pdfMarkdownLink(vault,path,'#page=1',alias)!,parent=dom.window.document.querySelector('main')!;parent.replaceChildren();let opened:string|undefined,kind:'wiki'|'markdown'|undefined;
    renderMarkdownInline(parent,link,(target,type)=>{opened=target;kind=type;});const anchor=parent.querySelector('a');assert.ok(anchor,link);assert.equal(parent.textContent,alias);anchor.click();assert.equal(vault.metadata.resolveLink('',opened!,kind),path,link);
  }}finally{dom.window.close();}
});
