// Deliberate fixture generation, never invoked by normal tests. Review changes to
// these bytes when updating Yjs; old fixtures should remain as compatibility tests.
import { writeFileSync } from 'node:fs';
import * as Y from 'yjs';
const doc = new Y.Doc();
doc.clientID = 101;
const content = doc.getText('content');
content.insert(0, 'Fixture 🦀 café\n');
const seed = Array.from(Y.encodeStateAsUpdate(doc));
const before = Y.encodeStateVector(doc);
content.delete(0, 8);
const deleted = Array.from(Y.encodeStateAsUpdate(doc, before));
const fixture = {
  producer: 'yjs@13.6.27', format: 'update-v1', root: 'content',
  seed, before: Array.from(before), deleted,
  expected: '🦀 café\n',
};
writeFileSync(new URL('yjs13-fixture.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
doc.destroy();
