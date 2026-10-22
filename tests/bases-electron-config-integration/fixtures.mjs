// Disposable prelaunch data. It is deliberately independent of production
// parsers, evaluators and exporters; positive campaign writes use real UI input.
export const vaultName='Bases configuration acceptance';
export const records=Array.from({length:12},(_,index)=>{
  const id=index+1;
  return {id,path:`Records/Item ${String(id).padStart(2,'0')}.md`,name:`Item ${String(id).padStart(2,'0')}`,kind:'config',status:['Todo','Doing','Done'][index%3],score:[2,2,4,1,3,4,2,5,5,3,1,2][index],enabled:id%4!==0,priority:id%2?'High':'Low'};
});
export const exportRecords=Array.from({length:1005},(_,index)=>{
  const ordinal=index+1,name=`Export ${String(ordinal).padStart(4,'0')}`;
  return {path:`Export/${name}.md`,name,ordinal,label:ordinal%113===0?`Quoted "${ordinal}"\tpipe | slash \\ and\nnext line`:`Label ${ordinal}`};
});
export const base=`# Configuration acceptance: keep this comment and all extension fields.
fixtureSentinel: config-keep
pluginRoot: {version: 19, nested: [one, two]}
filters:
  and:
    - 'note.kind == "config"'
formulas:
  twice: 'note.score * 2'
views:
  - type: table
    name: Configuration
    pluginView: {color: amber, retained: true}
    order: [file.name, note.score, note.status, note.enabled, note.priority, formula.twice]
    sort: [{property: file.name, direction: ASC}]
  - type: kanban
    name: Board
    pluginView: {boardExtension: keep}
    order: [file.name, note.score]
    groupBy: {property: note.status, direction: ASC, extension: keep}
`;
export const recoveredInline=`# Recovery host

Before the Base stays intact.

\`\`\`base
filters: 'note.kind == "config"'
views:
  - type: table
    name: Recovered inline
    order: [file.name, note.score]
\`\`\`

After the Base stays intact.
`;
export const repairedStandalone=`# Standalone recovery preserves author text.
pluginRoot: {recovered: true}
filters: 'note.kind == "config"'
views:
  - type: table
    name: Recovered standalone
    order: [file.name, note.score]
`;
export function fixtureFiles(){
  const files=new Map([
    ['Configuration.base',base],
    ['Properties.yaml',`properties:\n  kind: {type: text}\n  score: {type: number}\n  ordinal: {type: number}\n  enabled: {type: checkbox}\n  status: {type: select, options: [{value: Todo}, {value: Doing}, {value: Done}]}\n  priority: {type: select, options: [{value: High}, {value: Low}]}\n`],
    ['Invalid.base','views: [\n'],
    ['Recovery host.md','# Recovery host\n\nBefore the Base stays intact.\n\n```base\nviews: [\n```\n\nAfter the Base stays intact.\n'],
    ['Unknown.base',`# Unknown renderer and fields must remain inspectable.\nfixtureSentinel: unknown-keep\npluginRoot: {version: 23, values: [x, y]}\nfilters: 'note.kind == "config"'\nviews:\n  - type: future-grid\n    name: Future view\n    order: [file.name, note.score]\n    pluginView: {future: true, amount: 17}\n`],
    ['Large export.base',`filters: 'note.kind == "export"'\nproperties:\n  note.ordinal: {displayName: Ordinal}\n  note.label: {displayName: Label}\nviews:\n  - type: table\n    name: Large export\n    order: [file.name, note.ordinal, note.label]\n    sort: [{property: note.ordinal, direction: ASC}]\n`],
  ]);
  for(const item of records)files.set(item.path,`---\nkind: config\nstatus: ${item.status}\nscore: ${item.score}\nenabled: ${item.enabled}\npriority: ${item.priority}\n---\n# ${item.name}\n\nOriginal body ${item.id} stays exact.\n`);
  for(const item of exportRecords)files.set(item.path,`---\nkind: export\nordinal: ${item.ordinal}\nlabel: ${JSON.stringify(item.label)}\n---\nExport body ${item.ordinal}.\n`);
  return files;
}
