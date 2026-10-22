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
// Exact authored Markdown/Base inputs from the owned Obsidian reference002 pass.
export const hoverTextFiles = new Map([
  ['Hover.base', 'filters: file.inFolder("HoverCases")\nviews:\n  - type: table\n    name: Hover\n    order: [file.name, note.kind]\n'],
  ['HoverCases/HoverTarget.md', '---\nkind: hover-fixture\n---\n# Hover target\n\nA **preview** paragraph for the owned reference hover.\n\nA second paragraph for entering the editor.\n'],
  ['MediaHover.base', 'filters: file.inFolder("HoverMedia")\nviews:\n  - type: table\n    name: Media hover\n    order: [file.name]\n'],
]);
export const hoverImagePath = 'HoverMedia/Pixel.png';
export const hoverImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
export function note(name, rank, status) { return `---\nstatus: ${status}\nrank: ${rank}\n---\n\n# ${name}\n\n${name} body must survive every layout interaction.\n`; }
export function fixtureFiles() { return new Map([
  ['Layouts.base', base], ...names.map((name, index) => [`Items/${name}.md`, note(name, index + 1, index % 2 ? 'Done' : 'Todo')]),
  ...hoverTextFiles, [hoverImagePath, hoverImage],
]); }
