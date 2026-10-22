import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {delay} from '../tasks-electron-integration/cdp.mjs';
import {MOD} from '../bases-electron-integration/ui.mjs';
import {hoverImagePath, hoverImage} from './fixtures.mjs';

const popup = '[role="dialog"][aria-label="File preview"]';
const note = 'HoverCases/HoverTarget.md';
const link = `.pane.is-active [role="gridcell"][data-path="${note}"][data-property="file.name"] a.internal-link`;
const paragraph = `${popup} .bases-file-hover-preview p`;
const editor = `${popup} .bases-file-hover-editor .cm-content[contenteditable="true"]`;
const count = c => c.ui.dom(`return document.querySelectorAll(${JSON.stringify(popup)}).length;`);
async function move(c, point, modifiers = 0, label = 'hover pointer') {
  await c.cdp.call('Input.dispatchMouseEvent', {type: 'mouseMoved', ...point, modifiers});
  c.evidence.actions.push({action: 'trusted-hover-mouse', label, point, modifiers, at: Date.now()});
}
async function away(c) { await move(c, {x: 1000, y: 780}); await delay(400); }
async function show(c, selector = link) {
  await away(c); await move(c, await c.ui.point(selector), MOD.meta, 'modifier-bearing entry');
  await c.ui.wait(`const p=document.querySelector(${JSON.stringify(popup)});return document.querySelectorAll(${JSON.stringify(popup)}).length===1&&p?.getAttribute('aria-busy')!=='true'&&!p.inert;`, 'One admitted real file preview');
}
async function dismissed(c, label) { await c.ui.wait(`return document.querySelectorAll(${JSON.stringify(popup)}).length===0;`, label); }

export async function hoverJourney(c, expected, step) {
  await step(c, 'hover-reference-fixture-modifier-entry-retention-edit-and-exact-durable-source', async () => {
    await c.cdp.call('Emulation.setDeviceMetricsOverride', {width: 1024, height: 800, deviceScaleFactor: 2, mobile: false});
    await c.cdp.call('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: 'dark'}]});
    await c.ui.openFile('Hover.base'); await c.ui.idle();
    await c.ui.wait(`return innerWidth===1024&&innerHeight===800&&devicePixelRatio===2&&document.documentElement.dataset.theme==='dark';`, 'Matched hover reference viewport/theme');
    await away(c); const source = await c.ui.point(link); await move(c, source, 0, 'ordinary entry'); await delay(750);
    assert.equal(await count(c), 0, 'Ordinary hover never opens the default modifier-required preview'); await c.screenshot('hover-02-ordinary-reference-fixture');
    await show(c);
    await c.ui.wait(`const p=document.querySelector(${JSON.stringify(popup)});return p?.querySelector('.bases-file-hover-preview')?.textContent.includes('A preview paragraph for the owned reference hover.')&&p.querySelector('.metadata-properties-heading')?.getAttribute('aria-expanded')==='false'&&p.querySelector('button[aria-label="Open link"]');`, 'Reference body and initially collapsed Properties/Open link controls');
    const geometry = await c.ui.dom(`const a=document.querySelector(${JSON.stringify(link)}).getBoundingClientRect(),p=document.querySelector(${JSON.stringify(popup)}).getBoundingClientRect();return {anchor:{x:a.x,y:a.y,right:a.right,bottom:a.bottom},popup:{x:p.x,y:p.y,width:p.width,height:p.height},focusedInside:document.querySelector(${JSON.stringify(popup)}).contains(document.activeElement)};`);
    assert.ok(Math.abs(geometry.popup.width - 452) <= 1, 'Default outer preview width is452CSSpx'); assert.ok(Math.abs(geometry.popup.x - geometry.anchor.x) <= 1, 'Available-space placement aligns left');
    assert.ok(Math.abs(geometry.popup.y - geometry.anchor.bottom - 10) <= 1, 'Available-space placement has10px gap'); assert.equal(geometry.focusedInside, false, 'Preview does not steal focus');
    c.evidence.checks.push({name: 'hover-matched-reference-geometry-observation', reference: 'owned Obsidian1.14.4 pass002 captures03/06', geometry, note: 'No font or popup-height pixel-parity assertion'}); await c.screenshot('hover-03-modifier-mouse-reference-fixture');
    await move(c, await c.ui.point(link), 0, 'modifier flag removed at target'); await delay(450); assert.equal(await count(c), 1);
    await move(c, await c.ui.point(paragraph), 0, 'enter rendered popup'); await delay(450); assert.equal(await count(c), 1); await c.screenshot('hover-05-enter-popup-body');
    await c.ui.click(paragraph); await c.ui.wait(`const e=document.querySelector(${JSON.stringify(editor)});return e&&e.contains(document.activeElement);`, 'Click body enters focused editable shared note view'); await c.screenshot('hover-06-click-to-edit');
    const desired = expected[note] + '\nHover campaign durable edit survives preview teardown.\n';
    await c.ui.type(editor, desired); await c.ui.wait(`return document.querySelector(${JSON.stringify(editor)})?.textContent.includes('Hover campaign durable edit survives preview teardown.');`, 'Literal body edit is visible');
    // Parent navigation invokes the accepted flush/dispose path for the dirty editor.
    await c.ui.openFile(note); await dismissed(c, 'Parent navigation flushes and dismisses the edited preview');
    await c.saved(note, source => assert.equal(source, desired), 'hover-shared-buffer-exact-durable-source'); expected[note] = desired;
    await c.ui.wait(`return [...document.querySelectorAll('.pane.is-active .cm-content')].some(e=>e.textContent.includes('Hover campaign durable edit survives preview teardown.'));`, 'Ordinary note editor observes the same saved preview edit'); assert.equal(await c.read(note), desired);
    await c.ui.openFile('Hover.base'); await c.ui.idle(); await show(c); await c.ui.button('Search', '.pane.is-active .bases-session'); await dismissed(c, 'Clean outside toolbar click dismisses preview'); await c.ui.key('Escape');
    await show(c); await c.ui.openFile('Items/Alpha.md'); await dismissed(c, 'Clean Base parent navigation disposes the preview');
  });

  await step(c, 'hover-Zorid-key-after-entry-release-retention-separate-from-reference', async () => {
    await c.ui.openFile('Hover.base'); await c.ui.idle(); await away(c); await move(c, await c.ui.point(link)); await delay(400); assert.equal(await count(c), 0);
    await c.cdp.call('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: MOD.meta});
    try { await c.ui.wait(`return document.querySelectorAll(${JSON.stringify(popup)}).length===1;`, 'Zorid Meta pressed after entry opens preview'); }
    finally { await c.cdp.call('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 0}); }
    c.evidence.actions.push({action: 'Zorid-only-physical-key-after-hover-and-release', referenceParity: false, at: Date.now()});
    await delay(500); assert.equal(await count(c), 1, 'Zorid key release alone retains preview'); await c.screenshot('hover-zorid-key-after-entry-release');
    await c.ui.openFile('Items/Alpha.md'); await dismissed(c, 'Key-phase preview closes on normal parent navigation');
  });

  await step(c, 'hover-binary-image-resource-load-and-clean-release', async () => {
    assert.deepEqual(await fs.readFile(path.join(c.vault, hoverImagePath)), hoverImage);
    await c.ui.openFile('MediaHover.base'); await c.ui.idle();
    const imageLink = `.pane.is-active [role="gridcell"][data-path="${hoverImagePath}"][data-property="file.name"] a.internal-link`;
    await show(c, imageLink);
    const observed = await c.ui.wait(`const p=document.querySelector(${JSON.stringify(popup)}),i=p?.querySelector('img');return i?.complete&&i.naturalWidth===1&&i.naturalHeight===1?{src:i.currentSrc,width:i.naturalWidth,height:i.naturalHeight,editable:p.querySelectorAll('[contenteditable="true"],textarea').length,errors:[...p.querySelectorAll('[role="alert"]')].filter(e=>!e.hidden).map(e=>e.textContent)}:false;`, 'Actual binary image resource decodes in preview');
    assert.match(observed.src, /^blob:/); assert.equal(observed.editable, 0); assert.deepEqual(observed.errors, []);
    c.evidence.checks.push({name: 'binary-image-hover-loaded-resource', observed, limitation: 'Decoded leased resource and no text editor/error observed; this does not instrument every bridge read.'}); await c.screenshot('hover-binary-image-loaded');
    await c.ui.openFile('Items/Alpha.md'); await dismissed(c, 'Binary preview closes with its Base parent'); assert.deepEqual(await fs.readFile(path.join(c.vault, hoverImagePath)), hoverImage);
  });
}
