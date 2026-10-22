export const base = `filters:
  and:
    - file.ext == "md"
    - file.inFolder("Items")
formulas:
  bucket: note.status
views:
  - type: cards
    name: Grouped cards
    groupBy: {property: status, direction: ASC}
    groupOrder: [Todo, Done, Later]
    sort: [{property: rank, direction: ASC}]
    order: [file.name, rank]
  - type: list
    name: Grouped list
    groupBy: {property: status, direction: ASC}
    groupOrder: [Todo, Done, Later]
    sort: [{property: rank, direction: ASC}]
    markers: number
    order: [file.name, rank]
  - type: kanban
    name: Board
    groupBy: {property: status, direction: ASC}
    groupOrder: [Todo, Done, Later]
    sort: [{property: rank, direction: ASC}]
    order: [file.name, rank]
  - type: kanban
    name: Computed board
    groupBy: {property: formula.bucket, direction: ASC}
    groupOrder: [Todo, Done, Later]
    sort: [{property: rank, direction: ASC}]
    order: [file.name, rank]
`;
export const names = ['Alpha', 'Beta', 'Gamma', 'Delta'];
export function note(name, rank, status) { return `---\nstatus: ${status}\nrank: ${rank}\n---\n\n# ${name}\n\n${name} body must survive every layout interaction.\n`; }
export function fixtureFiles() { return new Map([
  ['Layouts.base', base], ...names.map((name, index) => [`Items/${name}.md`, note(name, index + 1, index % 2 ? 'Done' : 'Todo')]),
]); }
