import {deflateSync} from 'node:zlib';
// Disposable, human-readable input data. These writes happen before app launch.
export function coverPNG(){
  const width=96,height=64,raw=Buffer.alloc((width*4+1)*height);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*4+1)+1+x*4;raw[i]=40+x*2;raw[i+1]=50+y*2;raw[i+2]=170;raw[i+3]=255;}
  const chunk=(name,data)=>{const type=Buffer.from(name),crcData=Buffer.concat([type,data]);let crc=0xffffffff;for(const byte of crcData){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);type.copy(result,4);data.copy(result,8);result.writeUInt32BE((crc^0xffffffff)>>>0,data.length+8);return result;};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
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
summaries:
  RatingTotal: 'values.sum()'
properties:
  note.rating:
    displayName: Rating
views:
  - type: table
    name: Library
    order: [file.name, note.rating, note.status, note.topics, note.author, note.finished, note.done, formula.doubleRating, note.appointment, note.priority, note.keywords]
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
    ['Library.base', base], ['Templates/Book.md', template],['cover.png',coverPNG()],
    ['Authors.base', 'filters: \'note.type == "author"\'\nviews:\n  - type: table\n    name: Authors\n    order: [file.name, note.books, note.bookCount, note.averageRating]\n'],
    ['Rich.base', `filters: 'file.name == "Book 001"'
formulas:
  iconLink: 'link(file, icon("book"))'
  coverImage: 'image("cover.png")'
  safeHTML: 'html("<b>Ready</b><script>globalThis.__basesUnsafe = true</script>")'
views:
  - type: table
    name: Rich values
    order: [file.name, formula.iconLink, formula.coverImage, formula.safeHTML]
`],
    ['Author Ada.md', '---\ntype: author\ncountry: Canada\n---\nAuthor Ada body.\n'],
    ['Author Grace.md', '---\ntype: author\ncountry: USA\n---\nAuthor Grace body.\n'],
    ['Not a book.md', '---\ntype: project\nrating: 99\n---\nMust not appear in Library.\n'],
    ['Missing properties.md', '---\ntype: book\n---\nA heterogeneous row with no rating or status.\n'],
    ['Embed host.md', '---\ntype: project\n---\n# File embed\n\n![[Library.base#Books table]]\n\n# Fenced embed\n\n```base\nfilters:\n  and:\n    - \'note.type == "book"\'\nviews:\n  - type: list\n    name: Embedded list\n    order: [file.name, note.rating]\n```\n'],
    ['Context One.md', '---\ntype: context\ncategory: One\n---\nFirst context.\n'],
    ['Context Two.md', '---\ntype: context\ncategory: Two\n---\nSecond context.\n'],
    ['Context.base', 'filters: \'note.category == this.category\'\nviews:\n  - type: table\n    name: Context\n    order: [file.name, note.category]\n'],
  ]);
  for (let i = 0; i < count; i++) {
    const name = `Book ${String(i + 1).padStart(3, '0')}`;
    const status = ['To read', 'Reading', 'Finished'][i % 3];
    const rating = i % 5 + 1;
    files.set(`${name}.md`, `---\ntype: book\nstatus: ${status}\nrating: ${rating}\ncover: "[[cover.png]]"\ntopics:\n  - ${i % 2 ? 'Rust' : 'Design'}\nauthor: "[[${i % 2 ? 'Author Grace' : 'Author Ada'}]]"\nfinished: 2026-10-${String(i % 20 + 1).padStart(2, '0')}\ndone: ${i % 3 === 2}\nappointment: "2026-10-01T09:00"\npriority: Low\nkeywords: [alpha]\ncategory: ${i % 2 ? 'Two' : 'One'}\nuntouched: "preserve ${i}"\n---\n# ${name}\n\nExact body marker ${i} 😀\n`);
  }
  return files;
}
