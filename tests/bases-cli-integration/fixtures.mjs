// Independent synthetic source and numeric oracles; no query evaluator lives here.
export const clockMs = Date.UTC(2026, 9, 22, 12);
export const folders = [['books-dir', 'Books'], ['authors-dir', 'Authors']];

export const settings = `# Rich property definitions over ordinary Markdown files.
version: 1
futureSetting: keep-me
properties:
  rating: {type: number}
  published: {type: date}
  code: {type: text}
  done: {type: checkbox}
  status:
    type: status
    options:
      - {value: Todo, category: todo, color: gray}
      - {value: Reading, category: in-progress, color: blue}
      - {value: Done, category: done, color: green}
  priority:
    type: select
    options: [{value: Low}, {value: High}]
  topics:
    type: multiselect
    options: [{value: Rust, color: orange}, {value: Design, color: blue}]
  author:
    type: relation
    relation: {multiple: false, targetFilter: 'type == "author"'}
  books:
    type: reverseRelation
    reverseRelation: {property: author}
  bookCount:
    type: rollup
    rollup: {relation: books, aggregation: count}
  totalRating:
    type: rollup
    rollup: {relation: books, property: rating, aggregation: sum}
  averageRating:
    type: rollup
    rollup: {relation: books, property: rating, aggregation: average}
`;

export const library = `# Standalone CLI fixture: retain this comment and unrelated setting.
fixtureSentinel: keep-me
filters: 'note.type == "book"'
formulas:
  scaledRating: 'note.rating * 2'
  authorKind: 'note.author.asFile().properties.type'
  authorBookCount: 'note.author.asFile().properties.bookCount'
  publishedYear: 'note.published.format("YYYY")'
summaries:
  ScaledTotal: 'values.sum()'
  RatingTotal: 'values.sum()'
  Count: 'values.length'
views:
  - type: table
    name: All books
    order: [file.path, note.rating, note.status, note.topics, note.author, note.published, note.code, note.done, note.priority, formula.scaledRating, formula.authorKind, formula.authorBookCount, formula.publishedYear]
    sort: [{property: file.path, direction: ASC}]
    groupBy: {property: note.status, direction: ASC}
    summaries: {note.rating: Sum, formula.scaledRating: ScaledTotal}
  - type: cards
    name: Top rated
    filters: 'note.rating >= 3'
    order: [file.path, note.rating, formula.scaledRating]
    sort: [{property: note.rating, direction: DESC}]
    limit: 2
    summaries: {note.rating: Sum}
  - type: list
    name: Reading list
    filters: 'note.status == "Reading"'
    order: [file.path, note.rating]
    sort: [{property: file.path, direction: ASC}]
    summaries: {note.rating: RatingTotal}
  - type: kanban
    name: Board
    order: [file.path, note.rating, note.status]
    sort: [{property: file.path, direction: ASC}]
    groupBy: {property: note.status, direction: ASC}
    summaries: {note.rating: Sum}
  - type: table
    name: Empty
    filters: 'note.rating > 10'
    order: [file.path, note.rating]
    summaries: {note.rating: Count}
`;

export const authorsBase = `filters: 'note.type == "author"'
views:
  - type: table
    name: Author stats
    order: [file.path, note.books, note.bookCount, note.totalRating, note.averageRating]
    sort: [{property: file.path, direction: ASC}]
    summaries: {note.bookCount: Sum, note.totalRating: Sum}
`;

function book(name, rating, status, author, topics, crlf = false) {
  const source = `---
type: book
rating: ${rating}
status: ${status}
topics: [${topics.join(', ')}]
author: "[[Authors/${author}]]"
published: 2026-10-01
code: '2026-10-01'
done: ${status === 'Done'}
priority: Low
untouched: "Keep {{date}}, $HOME and 😀 literally"
---
# ${name}

Exact ${name} body. A normal note, not a database-owned record.
`;
  return crlf ? source.replaceAll('\n', '\r\n') : source;
}

export const files = [
  {id: 'property-definitions', path: 'Properties.yaml', source: settings},
  {id: 'library', path: 'Library.base', source: library},
  {id: 'authors-base', path: 'Authors.base', source: authorsBase},
  {id: 'ada', path: 'Authors/Ada.md', source: '---\ntype: author\ncountry: Canada\n---\nAda body; derived books/counts must never be written here.\n'},
  {id: 'grace', path: 'Authors/Grace.md', source: '---\ntype: author\ncountry: USA\n---\nGrace body; deleting this note must not delete books.\n'},
  {id: 'atlas', path: 'Books/Atlas 😀.md', source: book('Atlas', 5, 'Reading', 'Ada', ['Rust', 'Design'], true)},
  {id: 'birch', path: 'Books/Birch.md', source: book('Birch', 3, 'Done', 'Ada', ['Design'])},
  {id: 'cedar', path: 'Books/Cedar.md', source: book('Cedar', 4, 'Todo', 'Grace', ['Rust'])},
  {id: 'delta', path: 'Books/Delta.md', source: book('Delta', 2, 'Reading', 'Grace', [])},
  {id: 'empty', path: 'Books/Empty.md', source: '---\ntype: book\n---\nNo rating, status, author or other structured fields.\n'},
  {id: 'project', path: 'Other.md', source: '---\ntype: project\nrating: 99\n---\nMust not appear in the Books Base.\n'},
];

export const editedCedar = files.find(file => file.id === 'cedar').source
  .replace('rating: 4\n', 'rating: 6\n')
  .replace('status: Todo\n', 'status: Done\n')
  .replace('topics: [Rust]\n', 'topics: [Rust, Design]\n')
  .replace('author: "[[Authors/Grace]]"', 'author: "[[Authors/Ada]]"');

export const editedLibrary = library
  .replace("scaledRating: 'note.rating * 2'", "scaledRating: 'note.rating * 3'")
  .replace("ScaledTotal: 'values.sum()'", "ScaledTotal: 'values.sum() + 1'");

export const viewTypes = {'All books': 'table', 'Top rated': 'cards', 'Reading list': 'list', Board: 'kanban', Empty: 'table'};
export const expected = {
  initial: {total: 14, scaledTotal: 28, scale: 2, top: ['atlas', 'cedar'], topTotal: 9,
    rating: {atlas: 5, birch: 3, cedar: 4, delta: 2},
    groups: {Done: ['birch'], Reading: ['atlas', 'delta'], Todo: ['cedar'], missing: ['empty']},
    authors: {ada: {books: ['atlas', 'birch'], count: 2, total: 8, average: 4}, grace: {books: ['cedar', 'delta'], count: 2, total: 6, average: 3}}},
  edited: {total: 16, scaledTotal: 32, scale: 2, top: ['cedar', 'atlas'], topTotal: 11,
    rating: {atlas: 5, birch: 3, cedar: 6, delta: 2},
    groups: {Done: ['birch', 'cedar'], Reading: ['atlas', 'delta'], missing: ['empty']},
    authors: {ada: {books: ['atlas', 'birch', 'cedar'], count: 3, total: 14, average: 14 / 3}, grace: {books: ['delta'], count: 1, total: 2, average: 2}}},
};
expected.configured = {...expected.edited, scale: 3, scaledTotal: 49};
