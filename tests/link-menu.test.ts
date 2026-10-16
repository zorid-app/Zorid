import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLinkMenu, classifyLinkTarget, validatedExternalLink } from '../src/editor/link-menu.ts';
import type { LinkMenuHost, LinkMenuOptions, LinkSourceSnapshot, LinkTargetInput, ResolvedMenuFile } from '../src/editor/link-menu.ts';

function fixture(input: Partial<LinkTargetInput> = {}) {
  let snapshot: LinkSourceSnapshot | null = { ownerId: 'editor-A', sourcePath: 'notes/Source.md', revision: 7, text: 'before [[Target#Heading|alias]] after' };
  let file: ResolvedMenuFile | null = { path: 'notes/Target.md', identity: 'file-A', shortName: 'Target', mutable: true };
  let owned = true;
  const calls: unknown[][] = [];
  const host: LinkMenuHost = {
    currentSnapshot: () => snapshot, ownsTarget: () => owned, resolveInternal: () => file,
    openInternal: request => calls.push(['open', request]),
    openExternal: (url, mode, invocation) => calls.push(['external', url, mode, ...(invocation ? [invocation] : [])]),
    copyText: text => calls.push(['copy', text]),
    selectRange: (from, to) => calls.push(['select', from, to]),
    renameFile: path => calls.push(['rename', path]), moveFile: path => calls.push(['move', path]),
    openFileInWindow: path => calls.push(['window', path]),
    openWithDefaultApp: path => calls.push(['default', path]), revealInSystem: path => calls.push(['reveal', path]),
    copyVaultPath: path => calls.push(['vault-path', path]), copySystemPath: path => calls.push(['system-path', path]),
    applicationUrl: { label: 'as Zorid URL', copy: path => calls.push(['app-url', path]) },
  };
  const target = classifyLinkTarget({ kind: 'internal', href: 'Target#Heading', displayText: 'alias', span: { from: 9, to: 29 }, ...input }, snapshot)!;
  assert.ok(target);
  const options: LinkMenuOptions = { surface: 'editor', host, canSplit: true, canPopout: true, desktopApp: true, localFilesystem: true, macOS: true };
  return { target, host, calls, options, setSnapshot: (value: LinkSourceSnapshot | null) => { snapshot = value; }, getSnapshot: () => snapshot!, setFile: (value: ResolvedMenuFile | null) => { file = value; }, setOwned: (value: boolean) => { owned = value; } };
}
const ids = (entries: ReturnType<typeof buildLinkMenu>) => entries.map(entry => entry.id);

test('resolved editor link contributions follow ordered sections, with common file operations', () => {
  const f = fixture();
  const menu = buildLinkMenu(f.target, f.options);
  assert.deepEqual(ids(menu), ['link-new-tab', 'link-split', 'link-new-window', 'link-edit', 'link-copy-app-url', 'link-copy-vault-path', 'link-copy-system-path', 'link-rename', 'link-move', 'link-open-default', 'link-reveal-system']);
  assert.equal(menu.find(item => item.id === 'link-edit')?.label, 'Edit link');
  assert.equal(menu.find(item => item.id === 'link-copy-vault-path')?.section, 'info.copy');
  assert.equal(menu.find(item => item.id === 'link-reveal-system')?.label, 'Reveal in Finder');
  assert.ok(menu.every(item => item.enabled));
});

test('Reading internal order differs and adds copy display text, not edit-link', async () => {
  const f = fixture();
  const menu = buildLinkMenu(f.target, { ...f.options, surface: 'reading' });
  assert.deepEqual(ids(menu), ['link-new-tab', 'link-split', 'link-new-window', 'link-rename', 'link-move', 'link-copy-text', 'link-copy-app-url', 'link-copy-vault-path', 'link-copy-system-path', 'link-open-default', 'link-reveal-system']);
  assert.equal(await menu.find(item => item.id === 'link-copy-text')!.run(), true);
  assert.deepEqual(f.calls, [['copy', 'alias']]);
});

test('opening preserves link subpath except the explicitly file-based popout action', async () => {
  const f = fixture();
  await buildLinkMenu(f.target, f.options).find(item => item.id === 'link-new-tab')!.run();
  await buildLinkMenu(f.target, f.options).find(item => item.id === 'link-new-window')!.run();
  assert.deepEqual(f.calls, [
    ['open', { linkText: 'Target#Heading', sourcePath: 'notes/Source.md', destination: 'tab', create: false }],
    ['window', 'notes/Target.md'],
  ]);
});

test('phone and unresolved links have exact title/create conditions and no resolved-file commands', async () => {
  const f = fixture();
  f.setFile(null);
  const menu = buildLinkMenu(f.target, { ...f.options, surface: 'reading', phone: true });
  assert.deepEqual(ids(menu), ['link-title', 'link-create', 'link-copy-text']);
  assert.equal(menu[0].label, 'Target');
  assert.equal(menu[0].isLabel, true);
  assert.equal(await menu[0].run(), false);
  assert.equal(await menu[1].run(), true);
  assert.deepEqual(f.calls, [['open', { linkText: 'Target#Heading', sourcePath: 'notes/Source.md', destination: 'current', create: true }]]);
  const g = fixture();
  const phone = buildLinkMenu(g.target, { ...g.options, phone: true, mobileApp: true, desktopApp: false, canSplit: false, canPopout: false });
  assert.deepEqual(ids(phone).slice(0, 3), ['link-title', 'link-open', 'link-new-tab']);
  assert.equal(phone.find(item => item.id === 'link-open-default')?.label, 'Share');
  assert.ok(!ids(phone).includes('link-copy-system-path'));
  assert.ok(!ids(phone).includes('link-reveal-system'));
});

test('external menus use URL and display text distinctly and web viewer is conditional', async () => {
  const f = fixture({ kind: 'external', href: 'https://example.test', displayText: 'Site', span: undefined });
  const menu = buildLinkMenu(f.target, { ...f.options, surface: 'reading', webViewerEnabled: true });
  assert.deepEqual(ids(menu), ['link-open-browser', 'link-open-web-viewer', 'link-copy-text', 'link-copy-url']);
  await menu.find(item => item.id === 'link-open-browser')!.run();
  await menu.find(item => item.id === 'link-copy-url')!.run();
  await menu.find(item => item.id === 'link-copy-text')!.run();
  assert.deepEqual(f.calls, [['external', 'https://example.test/', 'browser'], ['copy', 'https://example.test'], ['copy', 'Site']]);
  assert.ok(!ids(buildLinkMenu(f.target, { ...f.options, surface: 'reading' })).includes('link-open-web-viewer'));
});

test('external reference links do not expose Edit link, while direct external links do', () => {
  const direct = fixture({ kind: 'external', href: 'https://example.test' });
  assert.deepEqual(ids(buildLinkMenu(direct.target, direct.options)), ['link-open-browser', 'link-edit', 'link-copy-url']);
  const reference = fixture({ kind: 'external-reference', href: 'https://example.test' });
  assert.deepEqual(ids(buildLinkMenu(reference.target, reference.options)), ['link-open-browser', 'link-copy-url']);
});

test('Edit link selects the authoritative token span; Edit tag excludes the hash', async () => {
  const f = fixture();
  await buildLinkMenu(f.target, f.options).find(item => item.id === 'link-edit')!.run();
  assert.deepEqual(f.calls, [['select', 9, 29]]);
  const snapshot: LinkSourceSnapshot = { ownerId: 'tag-view', sourcePath: 'Tag.md', revision: 1, text: '😀 #work/项目' };
  const target = classifyLinkTarget({ kind: 'tag', href: '#work/项目', span: { from: 3, to: snapshot.text.length } }, snapshot)!;
  const calls: unknown[] = [];
  const host: LinkMenuHost = { currentSnapshot: () => snapshot, ownsTarget: () => true, selectRange: (from, to) => calls.push([from, to]) };
  const menu = buildLinkMenu(target, { host, surface: 'editor' });
  assert.deepEqual(ids(menu), ['link-edit-tag']);
  await menu[0].run();
  assert.deepEqual(calls, [[4, snapshot.text.length]]);
  assert.deepEqual(buildLinkMenu(target, { host, surface: 'reading' }), []);
});

test('attachment links retain ordinary internal actions, without image mutation commands', () => {
  const f = fixture({ href: 'media/diagram.png', displayText: 'Diagram', span: undefined });
  f.setFile({ path: 'media/diagram.png', identity: 'image-file' });
  const menu = buildLinkMenu(f.target, { ...f.options, surface: 'reading' });
  assert.ok(ids(menu).includes('link-new-tab'));
  assert.ok(ids(menu).includes('link-rename'));
  assert.ok(!menu.some(item => /remove image|delete image|reset size/i.test(item.label)));
});

test('external URL policy accepts explicit safe protocols and rejects executable/ambiguous targets', () => {
  for (const url of ['https://example.test/a%20b#part', 'http://localhost:3000', 'mailto:a@example.test', 'tel:+15551234567']) assert.ok(validatedExternalLink(url), url);
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/private', 'vbscript:hello', 'obsidian://open', '//example.test/path', 'relative/path', 'java\nscript:alert(1)', 'https://exa\tmple.test', 'mailto:', 'tel:', 'https://']) assert.equal(validatedExternalLink(url), null, url);
  const snapshot: LinkSourceSnapshot = { ownerId: 'a', sourcePath: 'a.md', revision: 1, text: 'anything' };
  assert.equal(classifyLinkTarget({ kind: 'external', href: 'javascript:alert(1)' }, snapshot), null);
  assert.equal(classifyLinkTarget({ kind: 'internal', href: 'https://example.test' }, snapshot), null);
  assert.equal(classifyLinkTarget({ kind: 'internal', href: 'C:\\private.txt' }, snapshot), null);
  assert.equal(classifyLinkTarget({ kind: 'internal', href: '//host/file' }, snapshot), null);
  assert.ok(classifyLinkTarget({ kind: 'internal', href: '../Sibling#Heading' }, snapshot));
  assert.ok(classifyLinkTarget({ kind: 'internal', href: '#Heading' }, snapshot));
  assert.equal(classifyLinkTarget({ kind: 'tag', href: '#a OR path:secret' }, snapshot), null);
});

test('span capture rejects invalid coordinates and stores an immutable UTF-16 source slice', () => {
  const snapshot: LinkSourceSnapshot = { ownerId: 'a', sourcePath: 'a.md', revision: 1, text: '😀 link' };
  for (const span of [{ from: -1, to: 4 }, { from: 1.5, to: 3 }, { from: 4, to: 3 }, { from: 0, to: 99 }]) assert.equal(classifyLinkTarget({ kind: 'internal', href: 'Note', span }, snapshot), null);
  const target = classifyLinkTarget({ kind: 'internal', href: 'Note', span: { from: 3, to: 7 } }, snapshot)!;
  assert.equal(target.span?.text, 'link');
  assert.ok(Object.isFrozen(target));
  assert.ok(Object.isFrozen(target.span));
  assert.equal(classifyLinkTarget({ kind: 'tag', href: '#link', span: { from: 3, to: 7 } }, snapshot), null);
});

test('delayed actions reject changed revision, view, path, source span, ownership or disposal', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => f.setSnapshot({ ...f.getSnapshot(), revision: 8 }),
    f => f.setSnapshot({ ...f.getSnapshot(), ownerId: 'editor-B' }),
    f => f.setSnapshot({ ...f.getSnapshot(), sourcePath: 'Other.md' }),
    f => f.setSnapshot({ ...f.getSnapshot(), text: 'before [[Changed#Heading|alias]] after' }),
    f => f.setOwned(false), f => f.setSnapshot(null),
  ];
  for (const change of changes) {
    const f = fixture(), menu = buildLinkMenu(f.target, f.options);
    change(f);
    for (const entry of menu) assert.equal(await entry.run(), false, entry.id);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(buildLinkMenu(f.target, f.options), []);
  }
});

test('resolved target identity is checked again, including replacement at the same path', async () => {
  for (const next of [null, { path: 'notes/Moved.md', identity: 'file-A' }, { path: 'notes/Target.md', identity: 'replacement' }]) {
    const f = fixture(), menu = buildLinkMenu(f.target, f.options);
    f.setFile(next);
    for (const entry of menu.filter(item => item.id !== 'link-edit')) assert.equal(await entry.run(), false, entry.id);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture(); f.setFile(null);
  const create = buildLinkMenu(f.target, f.options).find(item => item.id === 'link-create')!;
  f.setFile({ path: 'notes/Target.md', identity: 'new-file' });
  assert.equal(await create.run(), false);
});

test('untrusted resolver paths and unavailable capabilities do not expose actions', () => {
  for (const path of ['/etc/passwd', '../outside.md', 'C:/secret.txt', 'a//b.md', 'a/./b.md', 'a\\b.md']) {
    const f = fixture(); f.setFile({ path, identity: 'unsafe' });
    assert.deepEqual(ids(buildLinkMenu(f.target, f.options)), ['link-edit']);
  }
  const f = fixture();
  const host = { currentSnapshot: f.host.currentSnapshot, ownsTarget: f.host.ownsTarget };
  assert.deepEqual(buildLinkMenu(f.target, { host, surface: 'editor' }), []);
});

test('read-only state disables mutations and is rechecked after the menu opens', async () => {
  const f = fixture(), menu = buildLinkMenu(f.target, f.options);
  f.setSnapshot({ ...f.getSnapshot(), readOnly: true });
  assert.equal(await menu.find(item => item.id === 'link-rename')!.run(), false);
  assert.equal(await menu.find(item => item.id === 'link-move')!.run(), false);
  assert.equal(await menu.find(item => item.id === 'link-edit')!.run(), true);
  const readOnlyMenu = buildLinkMenu(f.target, f.options);
  assert.equal(readOnlyMenu.find(item => item.id === 'link-rename')!.enabled, false);
  assert.equal(readOnlyMenu.find(item => item.id === 'link-new-tab')!.enabled, true);
});

test('callback failures propagate and no fallback navigation or mutation is attempted', async () => {
  const f = fixture();
  const host: LinkMenuHost = { ...f.host, renameFile: () => Promise.reject(new Error('denied')) };
  const menu = buildLinkMenu(f.target, { ...f.options, host });
  await assert.rejects(menu.find(item => item.id === 'link-rename')!.run(), /denied/);
  assert.deepEqual(f.calls, []);
});

test('move rechecks destination mutability and copy URL preserves the displayed href spelling', async () => {
  const f = fixture();
  const move = buildLinkMenu(f.target, f.options).find(item => item.id === 'link-move')!;
  f.setFile({ path: 'notes/Target.md', identity: 'file-A', mutable: false });
  assert.equal(await move.run(), false);
  assert.ok(!ids(buildLinkMenu(f.target, f.options)).includes('link-move'));
  const g = fixture({ kind: 'external', href: ' https://EXAMPLE.test ', span: undefined });
  const menu = buildLinkMenu(g.target, g.options);
  await menu.find(item => item.id === 'link-copy-url')!.run();
  await menu.find(item => item.id === 'link-open-browser')!.run();
  assert.deepEqual(g.calls, [['copy', ' https://EXAMPLE.test '], ['external', 'https://example.test/', 'browser']]);
});

test('phone open/create and web-viewer receive invocation modifiers while fixed destinations ignore them', async () => {
  const invocation = { altKey: false, ctrlKey: false, metaKey: true, shiftKey: true, button: 0 };
  const f = fixture();
  const menu = buildLinkMenu(f.target, { ...f.options, phone: true });
  await menu.find(item => item.id === 'link-open')!.run(invocation);
  await menu.find(item => item.id === 'link-new-tab')!.run(invocation);
  assert.deepEqual(f.calls, [
    ['open', { linkText: 'Target#Heading', sourcePath: 'notes/Source.md', destination: 'current', create: false, invocation }],
    ['open', { linkText: 'Target#Heading', sourcePath: 'notes/Source.md', destination: 'tab', create: false }],
  ]);
  const g = fixture(); g.setFile(null);
  await buildLinkMenu(g.target, g.options).find(item => item.id === 'link-create')!.run(invocation);
  assert.deepEqual(g.calls, [['open', { linkText: 'Target#Heading', sourcePath: 'notes/Source.md', destination: 'current', create: true, invocation }]]);
  const h = fixture({ kind: 'external', href: 'https://example.test', span: undefined });
  const external = buildLinkMenu(h.target, { ...h.options, webViewerEnabled: true });
  await external.find(item => item.id === 'link-open-web-viewer')!.run(invocation);
  await external.find(item => item.id === 'link-open-browser')!.run(invocation);
  assert.deepEqual(h.calls, [['external', 'https://example.test/', 'web-viewer', invocation], ['external', 'https://example.test/', 'browser']]);
});
