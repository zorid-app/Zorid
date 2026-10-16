import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  AbstractTextComponent, BaseComponent, ButtonComponent, DropdownComponent,
  Setting, TextAreaComponent, TextComponent, ToggleComponent, ValueComponent,
} from '../src/plugins/ui-components.ts';

test('setting controls use the supplied document without DOM prototype helpers', () => {
  const first = new JSDOM('<body></body>');
  const second = new JSDOM('<body></body>');
  try {
    const doc = second.window.document;
    const setting = new Setting(doc.body);
    setting.addText(() => {}).addTextArea(() => {}).addButton(() => {}).addDropdown(() => {}).addToggle(() => {});
    assert.equal(setting.settingEl.parentElement, doc.body);
    assert.deepEqual(setting.components.map(component => component.constructor), [TextComponent, TextAreaComponent, ButtonComponent, DropdownComponent, ToggleComponent]);
    for (const element of [setting.settingEl, ...setting.settingEl.querySelectorAll('*')]) assert.equal(element.ownerDocument, doc);
    assert.equal(first.window.document.body.childElementCount, 0);
    assert.equal('createEl' in second.window.HTMLElement.prototype, false);
    assert.equal('empty' in second.window.HTMLElement.prototype, false);
    assert.ok(setting.components.every(component => component instanceof BaseComponent));
    assert.ok(setting.components[0] instanceof AbstractTextComponent);
    assert.ok(setting.components[0] instanceof ValueComponent);
  } finally { first.window.close(); second.window.close(); }
});

test('text edits notify the latest callback; value setters and option getters are silent', () => {
  const dom = new JSDOM('<body></body>');
  try {
    for (const Constructor of [TextComponent, TextAreaComponent]) {
      const control = new Constructor(dom.window.document.body);
      const calls: string[] = [];
      const listeners: Record<string, (value?: string) => string> = {};
      assert.equal(control.setPlaceholder('Write here').setValue('initial').onChange(() => assert.fail('replaced callback')), control);
      control.onChange(value => calls.push(value));
      control.registerOptionListener(listeners, 'text');
      assert.equal(listeners.text(), 'initial');
      assert.equal(listeners.text('replacement'), 'replacement');
      assert.deepEqual(calls, []);
      control.inputEl.value = 'typed';
      control.inputEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      control.inputEl.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      assert.deepEqual(calls, ['typed']);
      control.onChanged();
      assert.deepEqual(calls, ['typed', 'typed']);
      assert.equal(control.inputEl.getAttribute('spellcheck'), 'false');
      assert.equal(control.inputEl.placeholder, 'Write here');
      control.setDisabled(true);
      assert.equal(control.disabled, true);
      assert.equal(control.inputEl.disabled, true);
      control.setDisabled(false);
      assert.equal(control.inputEl.disabled, false);
    }
  } finally { dom.window.close(); }
});

test('toggles notify only on transitions including programmatic updates and support keyboard activation', () => {
  const dom = new JSDOM('<body></body>');
  try {
    const calls: boolean[] = [];
    const toggle = new ToggleComponent(dom.window.document.body).onChange(() => assert.fail('replaced callback'));
    toggle.onChange(value => calls.push(value));
    assert.equal(toggle.setValue(true).setValue(true).setValue(false), toggle);
    assert.deepEqual(calls, [true, false]);
    const space = new dom.window.KeyboardEvent('keydown', { key: ' ', cancelable: true });
    toggle.toggleEl.dispatchEvent(space);
    assert.equal(space.defaultPrevented, true);
    assert.equal(toggle.getValue(), true);
    assert.equal(toggle.toggleEl.getAttribute('aria-checked'), 'true');
    const checkbox = toggle.toggleEl.querySelector('input')!;
    assert.equal(checkbox.checked, true);
    toggle.toggleEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.deepEqual(calls, [true, false, true]);
    checkbox.click();
    assert.equal(toggle.getValue(), false);
    assert.equal(checkbox.checked, false);
    toggle.setDisabled(true);
    toggle.toggleEl.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter' }));
    toggle.onClick();
    checkbox.click();
    assert.equal(toggle.getValue(), false);
    assert.equal(toggle.toggleEl.classList.contains('is-disabled'), true);
    // Disabled prevents interaction, but plugin-authored value changes still work.
    toggle.setValue(true);
    assert.deepEqual(calls, [true, false, true, false, true]);
    toggle.setDisabled(false).setSmall();
    assert.equal(checkbox.disabled, false);
    assert.equal(toggle.toggleEl.classList.contains('mod-small'), true);
  } finally { dom.window.close(); }
});

test('dropdowns preserve native selection, ignore inherited options and replace listeners', () => {
  const dom = new JSDOM('<body></body>');
  try {
    const dropdown = new DropdownComponent(dom.window.document.body);
    const options = Object.assign(Object.create({ inherited: 'Hidden' }), { alpha: 'Alpha', beta: '<Beta>' });
    const values: string[] = [];
    dropdown.addOptions(options).addOption('gamma', 'Gamma').onChange(() => assert.fail('replaced callback'));
    dropdown.onChange(value => values.push(value)).setValue('beta');
    assert.deepEqual([...dropdown.selectEl.options].map(option => option.value), ['alpha', 'beta', 'gamma']);
    assert.equal(dropdown.selectEl.options[1].textContent, '<Beta>');
    assert.deepEqual(values, []);
    dropdown.selectEl.value = 'gamma';
    dropdown.selectEl.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(values, ['gamma']);
    dropdown.setValue('absent');
    assert.equal(dropdown.getValue(), '');
    dropdown.setDisabled(true);
    assert.equal(dropdown.selectEl.disabled, true);
    dropdown.selectEl.dispatchEvent(new dom.window.MouseEvent('mousedown'));
    assert.equal(dropdown.selectEl.classList.contains('mouse-focus'), true);
    dropdown.selectEl.dispatchEvent(new dom.window.FocusEvent('blur'));
    assert.equal(dropdown.selectEl.classList.contains('mouse-focus'), false);
  } finally { dom.window.close(); }
});

test('buttons use the latest click callback and retain loading state until it settles', async () => {
  const dom = new JSDOM('<body><form></form></body>');
  try {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let received: MouseEvent | undefined;
    const button = new ButtonComponent(dom.window.document.querySelector('form')!);
    button.onClick(() => assert.fail('replaced callback'));
    assert.equal(button.onClick(event => { received = event; return pending; }).setButtonText('<Save>').setWarning(), button);
    assert.equal(button.buttonEl.textContent, '<Save>');
    assert.equal(button.buttonEl.type, 'button');
    button.buttonEl.click();
    assert.ok(received instanceof dom.window.MouseEvent);
    assert.equal(button.buttonEl.classList.contains('mod-loading'), true);
    finish();
    await pending;
    assert.equal(button.buttonEl.classList.contains('mod-loading'), false);
    assert.equal(button.buttonEl.classList.contains('mod-cta'), true);
    assert.equal(button.buttonEl.classList.contains('mod-destructive'), true);
    button.removeCta().removeDestructive().setClass('custom secondary');
    assert.equal(button.buttonEl.classList.contains('mod-cta'), false);
    assert.equal(button.buttonEl.classList.contains('custom'), true);
    button.onClick(() => assert.fail('disabled click')).setDisabled(true);
    button.buttonEl.click();
    button.buttonEl.dispatchEvent(new dom.window.MouseEvent('click'));
    assert.equal(button.buttonEl.disabled, true);
  } finally { dom.window.close(); }
});

test('setting metadata accepts fragments and text, preserves ownership, and exposes fluent callbacks', () => {
  const dom = new JSDOM('<body></body>');
  try {
    const doc = dom.window.document;
    const setting = new Setting(doc.body);
    const fragment = doc.createDocumentFragment();
    const strong = doc.createElement('strong');
    strong.textContent = 'Folder';
    fragment.append(strong);
    assert.equal(setting.setName(fragment).setDesc('<Choose one>').setHeading().setClass('one  two').setTooltip('Folder help', { placement: 'right', classes: ['tip'], delay: 250, gap: 4 }), setting);
    assert.equal(setting.nameEl.firstChild, strong);
    assert.equal(setting.descEl.textContent, '<Choose one>');
    assert.equal(setting.descEl.childElementCount, 0);
    assert.equal(setting.nameEl.getAttribute('aria-label'), 'Folder help');
    assert.equal(setting.nameEl.title, 'Folder help');
    assert.equal(setting.nameEl.dataset.tooltipPosition, 'right');
    assert.equal(setting.nameEl.dataset.tooltipDelay, '250');
    assert.equal(setting.nameEl.dataset.tooltipGap, '4');
    assert.equal(setting.nameEl.dataset.tooltipClasses, 'tip');
    assert.equal(setting.then(value => assert.equal(value, setting)), setting);
    setting.setVisibility(false).setNoInfo();
    assert.equal(setting.settingEl.hidden, true);
    assert.equal(setting.infoEl.hidden, true);
    setting.setVisibility(true).setName('Plain');
    assert.equal(setting.nameEl.textContent, 'Plain');
    assert.equal(strong.isConnected, false);
  } finally { dom.window.close(); }
});

test('setting disable applies to current controls and clear resets controls/errors while retaining metadata', () => {
  const dom = new JSDOM('<body></body>');
  try {
    const setting = new Setting(dom.window.document.body).setName('Preferences');
    let text!: TextComponent;
    const custom = new BaseComponent();
    setting.addText(component => {
      text = component;
      assert.equal(setting.components[0], component);
      assert.equal(component.then(value => assert.equal(value, component)), component);
    }).addComponent(container => { assert.equal(container, setting.controlEl); return custom; });
    setting.setDisabled(true);
    assert.equal(text.inputEl.disabled, true);
    assert.equal(custom.disabled, true);
    setting.addButton(button => assert.equal(button.disabled, false));
    setting.setDisabled(false);
    assert.equal(text.inputEl.disabled, false);
    setting.setErrorMessage('Required');
    const error = setting.errorEl!;
    assert.equal(error.textContent, 'Required');
    assert.equal(setting.settingEl.classList.contains('is-invalid'), true);
    setting.setErrorMessage(null);
    assert.equal(error.hidden, true);
    setting.setErrorMessage('Try again');
    assert.equal(setting.errorEl, error);
    assert.equal(error.hidden, false);
    const removedInput = text.inputEl;
    assert.equal(setting.clear(), setting);
    assert.equal(removedInput.isConnected, false);
    assert.equal(setting.controlEl.childElementCount, 0);
    assert.deepEqual(setting.components, []);
    assert.equal(setting.errorEl, null);
    assert.equal(setting.settingEl.classList.contains('is-invalid'), false);
    assert.equal(setting.nameEl.textContent, 'Preferences');
    setting.addText(control => control.setValue('Again')).setErrorMessage('New');
    assert.notEqual(setting.errorEl, error);
    assert.equal(setting.components.length, 1);
  } finally { dom.window.close(); }
});
