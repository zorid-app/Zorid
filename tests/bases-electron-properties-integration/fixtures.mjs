// Disposable prelaunch data; none of these files is claimed as user-created.
export const vaultName='PropertiesVault';
export const alpha='Items/Alpha.md',beta='Items/Beta.md';
export const bodies={
  [alpha]:'# Alpha body\n\nKeep Unicode 🌱, `literal code`, {{date}}, $HOME and this body exactly.\n',
  [beta]:'# Beta body\n\nSecond immutable body sentinel.\n',
};
export const initial={
  [alpha]:{type:'sample',blurb:'Original text',tags:['seed'],reference:'[[../Targets/Ada|Ada reference]]',status:'Planned',priority:'Low',topics:['Legacy','Design'],peers:['[[Beta|Beta alias]]','unresolved literal'],author:'[[../Targets/Ada|Original Ada]]',rating:3,done:false,due:'2026-10-22',appointment:'2026-10-22T09:00:00-04:00',notes:['original item'],untouched:'leave me'},
  [beta]:{type:'sample',blurb:'Second text',tags:[],reference:'[[../Targets/Grace]]',status:'Working',priority:'High',topics:['Design'],peers:[],author:'[[../Targets/Grace]]',rating:2,done:true,due:'2026-10-23',appointment:'2026-10-23T10:00',notes:[],untouched:'leave beta'},
};
const order='[file.name, note.blurb, note.tags, note.reference, note.status, note.priority, note.topics, note.peers, note.author, note.incoming, note.peerCount, note.rating, note.done, note.due, note.appointment, note.notes]';
export function fixtureFiles(){
  const files=new Map([
    ['Properties.base',`# Supplemental property interaction fixture\nfixtureSentinel: preserve-property-campaign\nfilters: 'note.type == "sample"'\nviews:\n  - type: table\n    name: Property table\n    order: ${order}\n    sort: [{property: file.name, direction: ASC}]\n  - type: cards\n    name: Property cards\n    order: ${order}\n  - type: list\n    name: Property list\n    order: ${order}\n  - type: kanban\n    name: Property board\n    order: ${order}\n    groupBy: {property: note.status, direction: ASC}\n`],
    ['Properties.yaml',`properties:
  blurb: {type: text}
  tags: {type: tags}
  reference: {type: link}
  status:
    type: status
    options:
      - {value: Planned, category: todo, color: gray}
      - {value: Working, category: in-progress, color: orange}
      - {value: Complete, category: done, color: green}
  priority:
    type: select
    options: [{value: Low, color: gray}, {value: High, color: red}]
  topics:
    type: multiselect
    options: [{value: Design, color: blue}, {value: Rust, color: orange}]
  peers:
    type: relation
    relation: {multiple: true, targetFilter: 'type == "sample"'}
  author:
    type: relation
    relation: {targetFilter: 'type == "person"'}
  incoming: {type: reverseRelation, reverseRelation: {property: peers}}
  peerCount: {type: rollup, rollup: {relation: incoming, aggregation: count}}
  rating: {type: number}
  done: {type: checkbox}
  due: {type: date}
  appointment: {type: datetime}
  notes: {type: list}
`],
    ['Targets/Ada.md','---\ntype: person\n---\nAuthor Ada sentinel.\n'],
    ['Targets/Grace.md','---\ntype: person\n---\nAuthor Grace sentinel.\n'],
  ]);
  for(const file of [alpha,beta])files.set(file,`---\n${Object.entries(initial[file]).map(([key,value])=>`${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n${bodies[file]}`);
  return files;
}
