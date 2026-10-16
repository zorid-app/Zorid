import test from 'node:test';
import assert from 'node:assert/strict';
import { createPdfDisplayMenu, createPdfSidebarMenu, createPdfPageMenu, createPdfThumbnailMenu, createPdfOutlineMenu, normalizePdfMenuText } from '../src/ui/pdf-menus.ts';
import type { PdfMenuSession, PdfLinkRequest } from '../src/ui/pdf-menus.ts';
const labels = (menu: PdfMenuSession) => menu.items.map(item => 'type' in item ? '---' : item.label);
const clipboard = () => {
  const values: string[] = [], links: PdfLinkRequest[] = [];
  return { values, links, writeClipboard(text: string) { values.push(text); }, generateMarkdownLink(request: PdfLinkRequest) { links.push(request); return `[[Book.pdf${request.subpath}|${request.alias}]]`; } };
};

test('display options preserve order, check states, exact spread values and real capabilities', async () => {
  const values: unknown[] = [];
  const state = { scale: 'page-width', spread: 1 as const, adaptToTheme: true };
  const host = { setScale(value: string) { values.push(value); }, setSpread(value: number) { values.push(value); }, setAdaptToTheme(value: boolean) { values.push(value); } };
  const menu = createPdfDisplayMenu(state, host);
  assert.deepEqual(labels(menu), ['Fit width', 'Fit height', '---', 'Single page', 'Two-page (odd)', 'Two-page (even)', '---', 'Adapt to theme']);
  assert.deepEqual(menu.items.filter(item => 'checked' in item).map(item => 'checked' in item && item.checked), [true, false, false, true, false, true]);
  await menu.run('pdf-spread-even'); assert.deepEqual(values, [2]);
  assert.equal(await menu.run('pdf-fit-height'), false);
  await createPdfDisplayMenu(state, host).run('pdf-fit-height');
  await createPdfDisplayMenu(state, host).run('pdf-adapt-theme');
  assert.deepEqual(values, [2, 'page-height', false]);
  assert.deepEqual(labels(createPdfDisplayMenu(state, {})), []);
  assert.deepEqual(labels(createPdfDisplayMenu(state, { setScale() {} })), ['Fit width', 'Fit height']);
  assert.deepEqual(labels(createPdfDisplayMenu({scale:'1',spread:0}, {setAdaptToTheme(){}})), []);
});

test('sidebar toggles active views, disables absent outline, and reveals only after opening it', async () => {
  const events: unknown[] = [], host = { switchSidebar(value: number) { events.push(value); }, revealCurrentOutlineItem() { events.push('reveal'); } };
  const missing = createPdfSidebarMenu({ open: true, active: 1, hasOutline: false }, host);
  assert.deepEqual(labels(missing), ['Thumbnails', 'Table of contents', '---', 'Reveal page in table of contents']);
  assert.equal(await missing.run('pdf-reveal-outline'), false);
  assert.equal(await missing.run('pdf-sidebar-outline'), false);
  assert.equal(await missing.run('pdf-sidebar-thumbnails'), true); assert.deepEqual(events, [0]);
  const available = { open: false, active: 2 as const, hasOutline: true };
  await createPdfSidebarMenu(available, host).run('pdf-reveal-outline'); assert.deepEqual(events, [0, 2, 'reveal']);
  await createPdfSidebarMenu({ ...available, open: true }, host).run('pdf-reveal-outline'); assert.deepEqual(events, [0, 2, 'reveal', 'reveal']);
});

test('page menus order lookup, selection and annotation sections and preserve exact clipboard payloads', async () => {
  const host = clipboard(), context = { desktop: true, macOS: true, page: 2, basename: 'Book', selectionText: 'A\nB\0', selection: [0, 1, 2, 3] as const, annotation: { id: '12R', subtype: 'Highlight', text: 'Marked text' } };
  let lookup = 0;
  const menu = createPdfPageMenu(context, { ...host, lookupSelection() { lookup++; } });
  assert.deepEqual(labels(menu), ['Look up “A B”', '---', 'Copy', 'Copy as quote', 'Copy link to selection', '---', 'Copy annotation', 'Copy link to annotation']);
  await menu.run('pdf-lookup-selection'); assert.equal(lookup, 1);
  await createPdfPageMenu(context, host).run('pdf-copy');
  await createPdfPageMenu(context, host).run('pdf-copy-quote');
  await createPdfPageMenu(context, host).run('pdf-copy-selection-link');
  await createPdfPageMenu(context, host).run('pdf-copy-annotation');
  await createPdfPageMenu(context, host).run('pdf-copy-annotation-link');
  assert.deepEqual(host.values, ['A B', '> A B\n\n[[Book.pdf#page=2&selection=0,1,2,3|Book, page 2]]', '[[Book.pdf#page=2&selection=0,1,2,3|Book, page 2]]', '> Marked text\n\n[[Book.pdf#page=2&annotation=12R|Book, page 2]]', '[[Book.pdf#page=2&annotation=12R|Book, page 2]]']);
  assert.deepEqual(host.links[0], { page: 2, subpath: '#page=2&selection=0,1,2,3', alias: 'Book, page 2' });
});

test('page availability excludes mobile, widgets, invalid selection ranges and invented blank-page actions', async () => {
  const host = clipboard(), context = {desktop:true,page:1,basename:'Book'};
  assert.deepEqual(labels(createPdfPageMenu(context,host)), []);
  assert.deepEqual(labels(createPdfPageMenu({...context,desktop:false,selectionText:'text'},host)), []);
  assert.deepEqual(labels(createPdfPageMenu({...context,page:0,selectionText:'text'},host)), []);
  assert.deepEqual(labels(createPdfPageMenu({...context,selection:[0,-1,0,2]},host)), []);
  assert.deepEqual(labels(createPdfPageMenu({...context,annotation:{id:'a',subtype:'Widget',text:'field'}},host)), []);
  assert.deepEqual(labels(createPdfPageMenu({...context,annotation:{id:'a',subtype:'Link'}},host)), ['Copy link to annotation']);
  assert.deepEqual(labels(createPdfPageMenu({...context,selectionText:'text'},{})), []);
  const disabled = createPdfPageMenu({...context,selectionText:'text',canCopy:false},host);
  assert.equal(await disabled.run('pdf-copy'),false); assert.deepEqual(host.values,[]);
  let native = 0;
  await createPdfPageMenu({...context,selectionText:'text'}, {...host,copyNativeSelection(){native++;}}).run('pdf-copy');
  assert.equal(native,1); assert.deepEqual(host.values,[]);
});

test('selection cleanup delegates Unicode normalization without pretending generic normalization is PDF.js', () => {
  let received = '';
  assert.equal(normalizePdfMenuText('a\r\nb\0', value => {received=value;return value.toUpperCase();}), 'A B');
  assert.equal(received, 'a b\0');
});

test('thumbnail and outline links use supplied formatting and resolved destinations', async () => {
  const host = clipboard();
  const thumbnail = createPdfThumbnailMenu({page:3,basename:'Book'},host);
  assert.deepEqual(labels(thumbnail), ['Copy link to page 3']); await thumbnail.run('pdf-copy-page-link');
  assert.equal(host.values[0],'[[Book.pdf#page=3|Book, page 3]]');
  const outline = createPdfOutlineMenu({title:'Chapter\n  Two',markdownLink:'[section](Book.pdf#page=3&offset=10,20)'},host);
  assert.deepEqual(labels(outline), ['Copy link to “Chapter Two”']); await outline.run('pdf-copy-section-link');
  assert.equal(host.values[1],'[section](Book.pdf#page=3&offset=10,20)');
  assert.deepEqual(labels(createPdfOutlineMenu({markdownLink:'link'},host)), ['Copy link to section']);
  assert.deepEqual(labels(createPdfOutlineMenu({title:'Title',markdownLink:null},host)), []);
  assert.deepEqual(labels(createPdfThumbnailMenu({page:2,basename:'Book'},{writeClipboard(){}})), []);
});

test('captured menus reject stale, dismissed, disposed, duplicate and unknown callbacks', async () => {
  let live = true, called = 0;
  const host = { isCurrent:()=>live,setScale(){called++;} }, state = {scale:'1',spread:0 as const};
  const stale = createPdfDisplayMenu(state,host); live=false; assert.equal(await stale.run('pdf-fit-width'),false); live=true;
  const disposed = createPdfDisplayMenu(state,host); disposed.dispose(); assert.equal(await disposed.run('pdf-fit-width'),false);
  const dismissed = createPdfDisplayMenu(state,host); await dismissed.run(null); assert.equal(await dismissed.run('pdf-fit-width'),false);
  const active = createPdfDisplayMenu(state,host); assert.equal(await active.run('unknown'),false); assert.equal(await active.run('pdf-fit-width'),true); assert.equal(await active.run('pdf-fit-width'),false);
  assert.equal(called,1);
  const failure = createPdfDisplayMenu(state,{setScale(){throw new Error('failed');}});
  await assert.rejects(failure.run('pdf-fit-width'),/failed/); assert.equal(await failure.run('pdf-fit-width'),false);
});

test('disposal during asynchronous sidebar activation prevents a late reveal', async () => {
  let finish!:()=>void, reveals=0;
  const menu=createPdfSidebarMenu({open:false,active:0,hasOutline:true},{switchSidebar(){return new Promise<void>(resolve=>finish=resolve);},revealCurrentOutlineItem(){reveals++;}});
  const running=menu.run('pdf-reveal-outline');menu.dispose();finish();await running;assert.equal(reveals,0);
});
