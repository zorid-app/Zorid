import assert from 'node:assert/strict';

// Inert disposable inputs, never positive creation evidence. Expected bytes are
// authored independently of the app's reference parser or configuration writer.
const base=name=>`# C2 configuration comment sentinel\nextraC2: keep\nfilters: 'note.kind == "safety" && file.name == "A"'\nviews:\n  - type: table\n    name: ${name}\n    order: [file.name, score]\n  - type: list\n    name: Other\n    order: [file.name]\n`;
const mountedHost=name=>`# C2 mounted host 😀\n\n![[C2 Mounted.base#${name}|Keep draft alias]]\n\n![[/C2 Mounted.base#${name}|Keep origin alias]]\n\n![[C2 Mounted.base#Other]]\n\nExact mounted host body.\n`;
const nestedChild=name=>`# C2 nested child\n\n![[C2 Nested.base#${name}|Keep nested alias]]\n\n[Read nested](C2%20Nested.base#${name.replaceAll(' ','%20')})\n\nExact nested child body.\n`;
const fence=name=>`# C2 fence prelude 😀\n\n\`\`\`base\n# Inline configuration sentinel\nfilters: 'note.kind == "safety" && file.name == "A"'\nviews:\n  - type: table\n    name: ${name}\n    order: [file.name, score]\n\`\`\`\n\nExact fence trailing body 🦀.\n`;
export const mountedRename={
  base:'C2 Mounted.base',host:'C2 Mounted host.md',from:'Mounted old',to:'Mounted renamed',
  beforeBase:base('Mounted old'),afterBase:base('Mounted renamed'),beforeHost:mountedHost('Mounted old'),afterHost:mountedHost('Mounted renamed'),
  draft:'Retain invalid number draft',
};
export const nestedRename={
  base:'C2 Nested.base',child:'C2 Nested child.md',outer:'C2 Nested outer.md',clean:'C2 Nested clean.md',from:'Nested old',to:'Nested renamed',
  beforeBase:base('Nested old'),afterBase:base('Nested renamed'),beforeChild:nestedChild('Nested old'),
  outerSource:'# C2 nested outer\n\n![[C2 Nested child]]\n\nExact outer body stays unchanged.\n',
  cleanBefore:'# C2 nested clean\n![[C2 Nested.base#Nested old]]\n',cleanAfter:'# C2 nested clean\n![[C2 Nested.base#Nested renamed]]\n',
};
export const fencedRename={
  host:'C2 Fenced host.md',from:'Fence old',to:'Fence renamed',beforeHost:fence('Fence old'),afterHost:fence('Fence renamed'),
  sentinel:'C2 Fence link sentinel.md',sentinelSource:'# Ordinary Markdown fragments\n[[C2 Fenced host.md#Fence old|Keep note fragment]]\n[Read](C2%20Fenced%20host.md#Fence%20old)\n',
};
export function mountedRenameFixtures(){return new Map([
  [mountedRename.base,mountedRename.beforeBase],[mountedRename.host,mountedRename.beforeHost],
  [nestedRename.base,nestedRename.beforeBase],[nestedRename.child,nestedRename.beforeChild],[nestedRename.outer,nestedRename.outerSource],[nestedRename.clean,nestedRename.cleanBefore],
  [fencedRename.host,fencedRename.beforeHost],[fencedRename.sentinel,fencedRename.sentinelSource],
]);}
export function nestedRenamedExternal(external){
  assert.ok(external.includes('#Nested old|')&&external.includes('#Nested%20old)'));
  return external.replace('#Nested old|','#Nested renamed|').replace('#Nested%20old)','#Nested%20renamed)');
}

export function assertLogicalCellSelection(before,after){
  assert.ok(before.selected,'Populated logical cell selection is a required precondition');
  assert.deepEqual(after.selected,before.selected,'Logical row/property selection survives clean inline remount');
}

export function assertMountedRenameRetention(before,after,{base,name,draft=false,renderedName=name}={}){
  assert.ok(before.sessionId&&after.connected&&after.inEmbed,'Mounted Base remains inside its original embed');
  assert.ok(before.rootId);assert.equal(after.rootId,before.rootId,'Rename must retain the original embed binding root');
  assert.equal(after.sessionId,before.sessionId,'Rename must retain the mounted Base session DOM');
  assert.equal(after.binding,base+' — '+name,'Mounted binding follows the saved exact name');
  if(before.selected)assert.deepEqual(after.selected,before.selected,'Logical cell selection survives rename');
  if(draft){
    assert.ok(before.input?.id&&after.input?.connected,'Existing input draft stays connected');
    assert.deepEqual(after.input,before.input,'Draft node, text and input selection survive in place');
  }else assert.equal(after.gridName,renderedName,'Current rendered view follows the saved exact name');
}


const publicationNote=name=>`# C2 publication host 😀\n\nLiteral publication prelude {{title}}.\n\n\`\`\`base\n# Retained inline source sentinel\nfilters: 'note.kind == "safety" && file.name == "A"'\nviews:\n  - type: table\n    name: ${name}\n    order: [file.name, score]\n\`\`\`\n\nLiteral trailing {{date}} 🦀.\n`;
export const hoverPublication={launcher:'C2 Hover publication.base',file:'C2 Publication/Hover target.md',from:'Hover original',to:'Hover accepted',before:publicationNote('Hover original'),after:publicationNote('Hover accepted')};
export const newPublication={launcher:'C2 New publication.base',template:'Templates/C2 publication.md',folder:'C2 Publication/New',from:'New original',to:'New accepted',before:publicationNote('New original'),after:publicationNote('New accepted')};
export function publicationFixtures(){return new Map([
  [hoverPublication.launcher,`filters: 'file.path == "${hoverPublication.file}"'\nviews: [{type: table, name: Hover launcher, order: [file.name]}]\n`],
  [hoverPublication.file,hoverPublication.before],
  [newPublication.launcher,`filters: 'file.path == "A.md"'\nnewItemFolder: ${newPublication.folder}\nnewItemTemplate: ${newPublication.template}\nviews: [{type: table, name: New launcher, order: [file.name]}]\n`],
  [newPublication.template,newPublication.before],[newPublication.folder+'/.keep','Owned C2 New output folder.\n'],
]);}
export function assertInlinePublicationFrame(before,after,{file,name,failed=false}){
  assert.ok(before.hostId&&after.hostConnected&&after.nodeInHost,'Original note host retains its own inline node');
  assert.equal(after.hostId,before.hostId,'Own save never replaces or transfers the hover/New host');
  assert.ok(after.connected&&after.inEmbed);
  assert.equal(after.binding,file,'Inline binding remains the original containing note');
  assert.equal(after.gridName,name,'Only the acknowledged configuration may publish');
  assertLogicalCellSelection(before,after);
  if(failed){
    assert.equal(after.rootId,before.rootId,'Failed source must not remount its binding root');
    assert.equal(after.sessionId,before.sessionId,'Failed source must not remount its session');
    assert.equal(after.propertyBlocked,true,'Pending failed configuration blocks property mutation');
  }
}
