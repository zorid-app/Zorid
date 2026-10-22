// Independent, human-authored notes and expected values. No evaluator or source
// factory is used here; the fixture persists these through the normal adapter.
export const alias = '[[../Authors/Ada|A. Lovelace]]';
export const body = '# Pioneer\r\nBody café 🦀. Keep the Markdown body exactly.\r\n';
export const pioneer = [
  '---', 'type: book', `author: '${alias}' # Keep this alias`, `reference: '${alias}'`,
  'references:', '  - author: "[[../Authors/Grace|Grace H.]]"',
  'rating: 7', 'category: A', 'topics: [Rust, Design]',
  'published: 2026-01-02', 'website: https://example.test', '---',
].join('\r\n') + '\r\n' + body;
export const ordinaryBase = `filters: 'file.inFolder("Books")'
formulas:
  owner: author.asFile().name
  cross: 'file("Books/Pioneer").properties.author.asFile().name'
  nested: 'file("Books/Pioneer").properties.references[0].author.asFile().name'
  external: website.isType("url")
  missing: 'file("Books/Pioneer").properties.author.asFile().properties.notHere'
summaries:
  LinkNames: 'values.filter(value.isType("link")).map(value.asFile().name)'
  FileNames: 'values.filter(value.properties.author.isType("link")).map(value.properties.author.asFile().name)'
views:
  - type: table
    name: All
    order: [file, author, references, rating, category, topics, published, formula.owner, formula.cross, formula.nested, formula.external, formula.missing]
    sort: [{property: file.path, direction: ASC}]
    summaries: {rating: Sum, author: LinkNames, file: FileNames}
  - type: table
    name: Limited
    order: [file.name, rating, author]
    groupBy: {property: category, direction: ASC}
    sort: [{property: rating, direction: DESC}]
    limit: 2
    summaries: {rating: Sum, author: LinkNames}
`;
export const richBase = `filters: 'file.inFolder("Books")'
formulas:
  richHtml: 'html("<b>Ready</b><script>globalThis.__basesUnsafe = true</script>")'
  richImage: 'image("covers/diagram.png")'
  richIcon: 'icon("book-open")'
  richLink: 'link(file, icon("book"))'
  sample: random()
  formatted: 'date("2024-01-21T19:04:05.067Z").format("dddd, Do MMMM YYYY HH:mm:ss.SSS Z")'
  today: 'TODAY().format("YYYY-MM-DD")'
  missing: 'file("There is no such file").path'
  unsupportedRegex: '/(?=a)/.matches("a")'
  unknown: unknownFunction()
  cycleA: formula.cycleB
  cycleB: formula.cycleA
views:
  - type: table
    name: Rich
    order: [file.name, formula.richHtml, formula.richImage, formula.richIcon, formula.richLink, formula.sample, formula.formatted, formula.today, formula.missing, formula.unsupportedRegex, formula.unknown, formula.cycleA]
    sort: [{property: file.path, direction: ASC}]
`;
export const settings = `version: 1
futureSetting: retained
properties:
  reference: {type: link}
  published: {type: link}
  website: {type: link}
  author:
    type: relation
    relation:
      multiple: false
      targetFilter: 'type == "author"'
  books:
    type: reverseRelation
    reverseRelation: {property: author}
  bookCount:
    type: rollup
    rollup: {relation: books, aggregation: count}
  averageRating:
    type: rollup
    rollup: {relation: books, property: rating, aggregation: average}
  topics:
    type: multiselect
    options:
      - {value: Rust, color: orange}
      - {value: Design, color: blue}
      - {value: Compilers, color: purple}
`;
// Added only with optional settings, after no-registry assertions complete.
export const plainLinkNotes = new Map([
  ['2026-01-02.md', '# A dated filename\n'],
  ['Invalid.md', '---\nbroken: [\n---\nInvalid metadata must not hide file identity.\n'],
]);
export const plainLinkPaths = [
  '2026-01-02.md', 'Authors/Ada.md', 'Authors/Grace.md',
  'Books/Compiler.md', 'Books/Foundations.md', 'Books/Pioneer.md',
  'Inline host.md', 'Invalid.md', 'Not a book.md',
];
export const authorsBase = `filters: 'file.inFolder("Authors") && type == "author" && bookCount >= 1'
formulas:
  weighted: averageRating * bookCount
views:
  - type: table
    name: Authors
    order: [file.name, books, bookCount, averageRating, formula.weighted]
    sort: [{property: bookCount, direction: DESC}]
    summaries: {bookCount: Sum}
`;
export const inlinePrelude = '# Café 🦀\r\n\r\n';
export const inlinePrefix = inlinePrelude + '```base\r\n';
export const inlineNormalized = [
  'filters: file.path == this.file.path', 'views:',
  '  - type: table', '    name: Here', '    order: [file.name]', '',
].join('\n');
export const inlineBase = inlineNormalized.replaceAll('\n', '\r\n');
export const inlineNote = inlinePrefix + inlineBase + '```\r\nExact trailing body.\r\n';
export const files = new Map([
  ['Authors/Ada.md', '---\ntype: author\n---\nAda body.\n'],
  ['Authors/Grace.md', '---\ntype: author\n---\nGrace body.\n'],
  ['Books/Pioneer.md', pioneer],
  ['Books/Foundations.md', '---\ntype: book\nauthor: "[[../Authors/Ada|Ada]]"\nrating: 3\ncategory: A\n---\nFoundations body.\n'],
  ['Books/Compiler.md', '---\ntype: book\nauthor: "[[../Authors/Grace]]"\nrating: 5\ncategory: B\n---\nCompiler body.\n'],
  ['Not a book.md', '---\ntype: project\nrating: 1000\n---\nNot in Books.\n'],
  ['Books.base', ordinaryBase], ['Rich.base', richBase], ['Authors.base', authorsBase],
  ['Inline host.md', inlineNote],
]);
export const clockMs = Date.UTC(2024, 0, 21, 19, 4, 5, 67);
export const timezone = 'America/Toronto';
export const groupNames = [
  'ordinary notes without Properties.yaml infer source-relative links and nested cross-file metadata',
  'raw edit values preserve aliases, dates, nested values and durable CAS edits',
  'group and overall summaries use final limited rows with real target identities',
  'group summary previews have exact scope and reject stale group selection',
  'rich values remain typed and seeded formulas share native date/error semantics',
  'fenced Base reads prove exact UTF-8 source span and contextual identity',
  'optional property settings derive relation targets, reverse relations and rollups',
  'property settings source proof rejects forged source and wrong identity',
  'retained pins, foreign clients, close and restart preserve authority boundaries',
];
