// Disposable, human-readable input data. These writes happen before app launch.
export const template = `---
type: book
status: Reading
rating: 3
topics:
  - Design
author: "[[Author Ada]]"
literal: "{{date}}"
---
# Literal template body

Keep {{title}}, {{date}}, $HOME and \`code\` literally.

- [ ] An ordinary checkbox
`;

export const base = `# Heavy-user fixture: unrelated keys/comments must survive UI edits.
fixtureSentinel: keep-me
newItemFolder: Created
newItemTemplate: Templates/Book.md
filters:
  and:
    - 'note.type == "book"'
    - '!file.inFolder("Templates")'
formulas:
  doubleRating: 'note.rating * 2'
properties:
  note.rating:
    displayName: Rating
views:
  - type: table
    name: Library
    order: [file.name, note.rating, note.status, note.topics, note.author, note.finished, note.done, formula.doubleRating]
    sort:
      - property: file.name
        direction: ASC
  - type: cards
    name: Covers
    order: [file.name, note.author, note.rating]
  - type: list
    name: Compact
    order: [file.name, note.status, note.rating]
  - type: kanban
    name: Reading board
    order: [file.name, note.rating, note.topics]
    groupBy:
      property: note.status
      direction: ASC
`;

export function fixtureFiles(count = 72) {
  const files = new Map([
    ['Library.base', base], ['Templates/Book.md', template],
    ['Authors.base', 'filters: \'note.type == "author"\'\nviews:\n  - type: table\n    name: Authors\n    order: [file.name, note.books, note.bookCount, note.averageRating]\n'],
    ['Author Ada.md', '---\ntype: author\ncountry: Canada\n---\nAuthor Ada body.\n'],
    ['Author Grace.md', '---\ntype: author\ncountry: USA\n---\nAuthor Grace body.\n'],
    ['Not a book.md', '---\ntype: project\nrating: 99\n---\nMust not appear in Library.\n'],
    ['Missing properties.md', '---\ntype: book\n---\nA heterogeneous row with no rating or status.\n'],
    ['Embed host.md', '---\ntype: project\n---\n# File embed\n\n![[Library.base#Library]]\n\n# Fenced embed\n\n```base\nfilters:\n  and:\n    - \'note.type == "book"\'\nviews:\n  - type: list\n    name: Embedded list\n    order: [file.name, note.rating]\n```\n'],
    ['Context One.md', '---\ntype: context\ncategory: One\n---\nFirst context.\n'],
    ['Context Two.md', '---\ntype: context\ncategory: Two\n---\nSecond context.\n'],
    ['Context.base', 'filters: \'note.category == this.category\'\nviews:\n  - type: table\n    name: Context\n    order: [file.name, note.category]\n'],
  ]);
  for (let i = 0; i < count; i++) {
    const name = `Book ${String(i + 1).padStart(3, '0')}`;
    const status = ['To read', 'Reading', 'Finished'][i % 3];
    const rating = i % 5 + 1;
    files.set(`${name}.md`, `---\ntype: book\nstatus: ${status}\nrating: ${rating}\ntopics:\n  - ${i % 2 ? 'Rust' : 'Design'}\nauthor: "[[${i % 2 ? 'Author Grace' : 'Author Ada'}]]"\nfinished: 2026-10-${String(i % 20 + 1).padStart(2, '0')}\ndone: ${i % 3 === 2}\ncategory: ${i % 2 ? 'Two' : 'One'}\nuntouched: "preserve ${i}"\n---\n# ${name}\n\nExact body marker ${i} 😀\n`);
  }
  return files;
}
