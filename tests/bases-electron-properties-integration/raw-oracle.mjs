import assert from 'node:assert/strict';
// Every replacement is preauthored independently of actual saved bytes and the
// product serializer. Including delimiters makes both quote/comment loss and
// unrelated formatting changes fail the full-source assertion.
export const rawEdits={
  tableText:['blurb: "Original text" # keep this scalar comment','blurb: "Table text 🌱" # keep this scalar comment'],
  tableTag:['tags:\n  - seed\nreference:','tags:\n  - seed\n  - table-tag\nreference:'],
  tableLink:['reference: "[[../Targets/Ada|Ada reference]]"','reference: "[[/Targets/Grace.md]]"'],
  tableStatus:['status: "Planned"','status: "Working"'],
  tablePriority:['priority: "Low"','priority: "Picker priority"'],
  tableTopics:['topics:\n  - Legacy\n  - Design\npeers:','topics:\n  - Legacy\n  - Design\n  - Picker topic\npeers:'],
  addPeer:['peers:\n  - "[[Beta|Beta alias]]"\n  - unresolved literal\nauthor:','peers:\n  - "[[Beta|Beta alias]]"\n  - unresolved literal\n  - "[[/Items/Alpha.md]]"\nauthor:'],
  removePeer:['peers:\n  - "[[Beta|Beta alias]]"\n  - unresolved literal\n  - "[[/Items/Alpha.md]]"\nauthor:','peers:\n  - "[[Beta|Beta alias]]"\n  - unresolved literal\nauthor:'],
  cardsText:['blurb: "Table text 🌱" # keep this scalar comment','blurb: "Cards text 🌱" # keep this scalar comment'],
  cardsTag:['tags:\n  - seed\n  - table-tag\nreference:','tags:\n  - seed\n  - table-tag\n  - cards-tag\nreference:'],
  listPriority:['priority: "Picker priority"','priority: "High"'],
  listLink:['reference: "[[/Targets/Grace.md]]"','reference: "[[/Targets/Ada.md]]"'],
  boardStatus:['status: "Working"','status: "Complete"'],
  boardTopics:['topics:\n  - Legacy\n  - Design\n  - Picker topic\npeers:','topics:\n  - Legacy\n  - Design\n  - Picker topic\n  - Rust\npeers:'],
  priorityOption:['      - value: High\n        color: red\n  topics:','      - value: High\n        color: red\n      - value: Picker priority\n  topics:'],
  topicOption:['      - value: Rust\n        color: orange\n  peers:','      - value: Rust\n        color: orange\n      - value: Picker topic\n  peers:'],
};
export function applyRawEdit(source,name){
  const edit=rawEdits[name];assert.ok(edit,'Named preauthored raw edit: '+name);const [before,after]=edit;
  const index=source.indexOf(before);assert.ok(index>=0,'Expected raw span before '+name);assert.equal(source.indexOf(before,index+before.length),-1,'Unique expected span '+name);
  return source.slice(0,index)+after+source.slice(index+before.length);
}
