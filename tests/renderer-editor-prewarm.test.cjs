const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');

test('renderer prewarms its editor while platform admission is pending and contains prewarm failure',async()=>{
  const events=[];let admit,rejectEditor;
  const platform=new Promise(resolve=>{admit=resolve;});
  const editor=new Promise((_,reject)=>{rejectEditor=reject;});
  // Execute the real entry point with only its external module boundaries replaced.
  const source=fs.readFileSync(new URL('../src/main.ts',`file://${__filename}`),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},transformers:{before:[context=>{
    const visit=node=>ts.isImportDeclaration(node)?undefined:ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword
      ?context.factory.createCallExpression(context.factory.createIdentifier('loadEditor'),undefined,[]):ts.visitEachChild(node,visit,context);
    return node=>ts.visitNode(node,visit);
  }]}}).outputText.replace(/export\s*\{\s*\};?\s*$/,'');
  vm.runInNewContext(code,{exports:{},document:{querySelector:()=>({})},window:{zorid:{}},console:{error:()=>{}},
    Workspace:class{async start(value){events.push(['start',value]);}async cleanupFailedStartup(){events.push(['cleanup']);}},
    createPlatformAdapter(){events.push(['platform']);return platform;},pickDesktopVault(){throw Error('unexpected picker');},
    loadEditor(){events.push(['editor']);return editor;},renderStartupError(){events.push(['startup-error']);},legacyBrowserExport(){}});
  assert.deepEqual(events,[['editor'],['platform']]);
  rejectEditor(Error('optional prewarm failed'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.some(event=>event[0]==='startup-error'),false);
  admit('owned-platform');await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(events.at(-1),['start','owned-platform']);
});
