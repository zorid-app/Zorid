// Reconstructed from the retained Obsidian1.14.4 capture states, not the later
// mutated reference vault. Ordinary inferred properties: no Properties.yaml.
export const baselineBase=`filters:
  and:
    - file.ext == "md"
    - file.inFolder("Items")
views:
  - type: table
    name: Table
    order: [file.name, status, cost, favorite, due]
  - type: cards
    name: Cards
    order: [file.name, status, cost]
  - type: list
    name: List
    order: [file.name, status, cost]
  - type: kanban
    name: Board
    groupBy:
      property: status
      direction: ASC
    groupOrder: [Done, In progress, Planned]
    order: [file.name, cost]
`;
export const template=`---
status: Planned
cost: 7
literal: "{{date}}"
---

# Body must remain literal

{{title}}

- [ ] Template checkbox
`;
export function fixtureFiles(){return new Map([
  ['Reference.base',baselineBase],
  ['Items/Alpha.md','---\nstatus: Planned\ncost: 10\nfavorite: true\ndue: 2026-10-22\ntags:\n  - reference\n---\n\n# Alpha\n\nDisposable reference fixture.\n'],
  ['Items/Beta.md','---\nstatus: In progress\ncost: 20\nfavorite: false\ndue: 2026-10-23\ntags:\n  - reference\n---\n\n# Beta\n\nDisposable reference fixture.\n'],
  ['Items/Gamma.md','---\nstatus: Done\ncost: \nfavorite: false\ndue: \ntags:\n  - reference\n---\n\n# Gamma\n\nDisposable reference fixture.\n'],
]);}
export const singleBase=`filters:
  and:
    - file.ext == "md"
    - file.inFolder("Items")
newItemTemplate: Templates/Full.md
newItemFolder: Items
views:
  - type: table
    name: Solo
    order: [file.name, status, cost]
`;
