import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, MetadataCache, parseMetadata, Vault } from '../src/core/index.ts';

test('metadata indexes basic YAML, aliases, tags and headings while excluding code/comments', () => {
  const note = parseMetadata('One.md', '---\ntags: [science, "nested/tag"]\naliases:\n  - First note\npublished: true\ncount: 3\n---\n# Heading\nText #inline #123 #nested/tag\n`#code [[Hidden]]`\n<!-- [[Hidden]] -->\n%% [[Hidden]] %%\n```md\n# Hidden heading\n[[Hidden]]\n```\n[[Visible#Section|Alias]] ![[image.png]]\n[link](<Some note.md#Here>)');
  assert.deepEqual(note.tags, ['science', 'nested/tag', 'inline']);
  assert.deepEqual(note.aliases, ['First note']);
  assert.equal(note.frontmatter.published, true);
  assert.equal(note.frontmatter.count, 3);
  assert.deepEqual(note.headings.map(item => item.heading), ['Heading']);
  assert.deepEqual(note.links.map(item => [item.target, item.fragment, item.embed]), [['Visible', '#Section', false], ['image.png', '', true], ['Some note.md', '#Here', false]]);
});

test('link destination offsets retain aliases, fragments and labels for precise rewrites', () => {
  const text = '😀 ![[A#Head|Label]] [shown](A.md#Head "Title") [b](<B name.md>)';
  const note = parseMetadata('Source.md', text);
  assert.deepEqual(note.links.map(link => text.slice(link.start, link.end)), ['A', 'A.md', 'B name.md']);
  assert.equal(note.links[1].fragment, '#Head');
});

test('wiki and Markdown links share basename, explicit-relative and root resolution', () => {
  const cache = new MetadataCache();
  cache.setFiles(['Source.md', 'A/Note.md', 'B/Note.md', 'A/Sub/Source.md', 'Images/photo.png']);
  for (const kind of ['wiki', 'markdown'] as const) {
    assert.equal(cache.resolveLink('Source.md', 'Note', kind), 'A/Note.md');
    assert.deepEqual(cache.resolveLinkCandidates('Source.md', 'Note', kind), ['A/Note.md', 'B/Note.md']);
    assert.equal(cache.resolveLink('A/Sub/Source.md', '../Note.md', kind), 'A/Note.md');
    assert.equal(cache.resolveLink('Source.md', '../A/Note.md', kind), 'A/Note.md');
    assert.equal(cache.resolveLink('A/Sub/Source.md', '/Images/photo.png', kind), 'Images/photo.png');
    assert.equal(cache.resolveLink('Source.md', 'photo.png', kind), 'Images/photo.png');
    assert.equal(cache.resolveLink('Source.md', '/photo.png', kind), null);
    assert.equal(cache.resolveLink('Source.md', '#Local', kind), 'Source.md');
    assert.equal(cache.resolveLink('Source.md', 'https://example.com', kind), null);
  }
});

test('exact root paths precede same-folder bare links while explicit relative links select the folder', () => {
  const cache = new MetadataCache();
  cache.setFiles(['Note.md', 'A/Note.md', 'Elsewhere/Only.md']);
  assert.equal(cache.resolveLink('A/Source.md', 'Note'), 'Note.md');
  assert.equal(cache.resolveLink('A/Source.md', './Note'), 'A/Note.md');
  assert.deepEqual(cache.resolveLinkCandidates('A/Source.md', 'Note'), ['Note.md']);
  assert.equal(cache.resolveLink('A/Source.md', './Only'), null);
  assert.equal(cache.resolveLink('A/Source.md', 'Only', 'markdown'), 'Elsewhere/Only.md');
  assert.equal(cache.resolveLink('A/Sub/Source.md', './../../Note'), 'Note.md');
});

test('suffix candidates prefer source-directory prefix, then path length, retaining tied index order', () => {
  const cache = new MetadataCache();
  cache.setFiles(['Q/Note.md', 'Other/Note.md', 'AB/Note.md', 'A/Deep/Note.md', 'X/Note.md']);
  assert.deepEqual(cache.resolveLinkCandidates('A/Source.md', 'Note'),
    ['AB/Note.md', 'A/Deep/Note.md', 'Q/Note.md', 'X/Note.md', 'Other/Note.md']);
  assert.equal(cache.resolveLink('A/Source.md', 'Note'), 'AB/Note.md');
  assert.deepEqual(cache.resolveLinkCandidates('Source.md', 'Deep/Note'), ['A/Deep/Note.md']);
  assert.equal(cache.resolveLink('Source.md', '/Deep/Note'), null);
  // A selected first result is insufficient for a shortest-link uniqueness check.
  assert.equal(cache.resolveLinkCandidates('A/Source.md', 'Note').length, 5);
});

test('case-insensitive names retain actual spelling and prefer existing extension candidates', () => {
  const cache = new MetadataCache();
  cache.setFiles(['Folder/Photo.PNG', 'Folder/Photo.PNG.md', 'Other/Report.PDF.md', 'Café.md']);
  assert.equal(cache.resolveLink('Source.md', 'PHOTO.png', 'markdown'), 'Folder/Photo.PNG');
  assert.equal(cache.resolveLink('Source.md', 'folder/photo.png'), 'Folder/Photo.PNG');
  assert.equal(cache.resolveLink('Source.md', 'Report.pdf'), 'Other/Report.PDF.md');
  assert.equal(cache.resolveLink('Source.md', 'Cafe%CC%81'), 'Café.md');
  cache.remove('Folder/Photo.PNG');
  assert.equal(cache.resolveLink('Source.md', 'photo.png'), 'Folder/Photo.PNG.md');
  cache.clear();
  assert.deepEqual(cache.resolveLinkCandidates('Source.md', 'photo.png'), []);
  cache.indexBatch([['One/New.md', ''], ['Two/New.md', '']]);
  assert.deepEqual(cache.resolveLinkCandidates('Source.md', 'NEW'), ['One/New.md', 'Two/New.md']);
  cache.setFiles(['Replacement/New.md']);
  assert.deepEqual(cache.resolveLinkCandidates('Source.md', 'new'), ['Replacement/New.md']);
});

test('backlinks distinguish ambiguous notes and decode Markdown destinations', () => {
  const cache = new MetadataCache();
  cache.index('Target name.md', '');
  cache.index('One.md', '[[Target name|Alias]] [target](Target%20name.md#Heading)');
  cache.index('Two.md', '[[missing]]');
  assert.deepEqual(cache.backlinks('Target name.md').map(link => link.source), ['One.md', 'One.md']);
  cache.remove('One.md');
  assert.deepEqual(cache.backlinks('Target name.md'), []);
});

test('metadata reads quoted commas, nested YAML, BOM and dot-delimited frontmatter', () => {
  const source='\uFEFF---\r\naliases: ["one, two", three]\r\ntags: ["work/project"]\r\nconfig: {visible: true, count: 2}\r\n...\r\n# Visible\r\n[[Target]]';
  const note=parseMetadata('Note.md',source);
  assert.deepEqual(note.aliases,['one, two','three']);
  assert.deepEqual(note.tags,['work/project']);
  assert.deepEqual(note.frontmatter.config,{visible:true,count:2});
  assert.equal(note.headings[0].line,5);
  assert.equal(source.slice(note.links[0].start,note.links[0].end),'Target');
});


test('extensionless filenames do not override the note-name lookup policy', () => {
  const cache = new MetadataCache();
  cache.setFiles(['Folder', 'Other/Folder.md']);
  assert.equal(cache.resolveLink('Source.md', 'Folder'), 'Other/Folder.md');
  cache.remove('Other/Folder.md');
  assert.equal(cache.resolveLink('Source.md', 'Folder'), null);
});

test('rename rewrites shared Markdown/wiki basename references only for the selected destination', async () => {
  const adapter = new MemoryAdapter(), vault = new Vault(adapter);
  await adapter.mkdir('A'); await adapter.mkdir('B');
  await adapter.write('A/Note.md', 'first'); await adapter.write('B/Note.md', 'second');
  await adapter.write('Source.md', '[[note#Heading|shown]] [shown](NOTE.md#Heading)');
  await vault.initialize();
  assert.equal(vault.metadata.backlinks('A/Note.md').length, 2);
  await vault.rename('B/Note.md', 'B/Other.md');
  assert.equal(await vault.read('Source.md'), '[[note#Heading|shown]] [shown](NOTE.md#Heading)');
  await vault.rename('A/Note.md', 'A/Renamed.md');
  assert.equal(await vault.read('Source.md'), '[[A/Renamed#Heading|shown]] [shown](A/Renamed.md#Heading)');
  assert.equal(vault.metadata.backlinks('A/Renamed.md').length, 2);
});
