// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest';
import { normalizeVaultPath } from '../packages/shared/src/index';
import {
  createFieldsPropertiesEditorRegistration,
  fieldsPropertiesEditorRegistration,
} from '../plugins/core/fields/src/index';

describe('Fields PropertiesEditorRegistration', () => {
  it('defines a document-header properties editor outside Markdown block registration', () => {
    const registration = createFieldsPropertiesEditorRegistration();

    expect(registration.id).toBe('zorid.core.fields.properties-editor');
    expect(registration.placement).toBe('document-header');
    expect(registration.enabledByDefault).toBe(true);
    expect(fieldsPropertiesEditorRegistration).toMatchObject({ id: registration.id, placement: 'document-header' });
  });

  it('renders structured field UI without pretending to be Markdown source text', () => {
    const registration = createFieldsPropertiesEditorRegistration();
    const rendered = registration.render({
      documentPath: normalizeVaultPath('Task.md'),
      fields: [{ key: 'status', value: 'open', source: 'frontmatter' }],
      rawFrontmatter: 'status: open',
    });
    const element = rendered instanceof HTMLElement ? rendered : rendered.element;

    expect(element.className).toBe('z-fields-properties-editor');
    expect(element.dataset.propertiesEditorRegistration).toBe('zorid.core.fields.properties-editor');
    expect(element.dataset.documentPath).toBe('Task.md');
    expect(element.textContent).toContain('Properties');
    expect(element.textContent).toContain('status');
    expect(element.querySelector<HTMLInputElement>('input[name="status"]')?.value).toBe('open');
  });

  it('emits coerced field and type updates from the rendered controls', () => {
    const registration = createFieldsPropertiesEditorRegistration();
    const onUpdateField = vi.fn();
    const onSetType = vi.fn();
    const rendered = registration.render({
      documentPath: normalizeVaultPath('Task.md'),
      typeName: 'Task',
      typeOptions: [{ name: 'Task', path: normalizeVaultPath('Types/Task.md') }],
      fields: [
        { key: 'done', value: false, source: 'frontmatter', type: 'boolean' },
        { key: 'points', value: 1, source: 'frontmatter', type: 'int' },
        { key: 'tags', value: ['a'], source: 'type-default', type: 'list' },
        { key: 'owners', value: 'me', source: 'frontmatter', type: 'multiselect' },
      ],
      diagnostics: [{ key: 'points', message: 'Expected integer.' }],
      onUpdateField,
      onSetType,
    });
    const element = rendered instanceof HTMLElement ? rendered : rendered.element;

    const done = element.querySelector<HTMLInputElement>('input[name="done"]');
    const points = element.querySelector<HTMLInputElement>('input[name="points"]');
    const tags = element.querySelector<HTMLInputElement>('input[name="tags"]');
    const owners = element.querySelector<HTMLInputElement>('input[name="owners"]');
    const type = element.querySelector<HTMLSelectElement>('select[name="zorid.type"]');

    expect(done?.checked).toBe(false);
    expect(points?.value).toBe('1');
    expect(tags?.value).toBe('a');
    expect(owners?.value).toBe('me');
    expect(type?.value).toBe('Task');
    expect(element.textContent).toContain('points: Expected integer.');

    done!.checked = true;
    done!.dispatchEvent(new Event('change'));
    points!.value = '3';
    points!.dispatchEvent(new Event('change'));
    tags!.value = 'alpha, beta';
    tags!.dispatchEvent(new Event('change'));
    owners!.value = 'me, you';
    owners!.dispatchEvent(new Event('change'));
    type!.value = '';
    type!.dispatchEvent(new Event('change'));

    expect(onUpdateField).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: 'done' }), true);
    expect(onUpdateField).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: 'points' }), 3);
    expect(onUpdateField).toHaveBeenNthCalledWith(3, expect.objectContaining({ key: 'tags' }), ['alpha', 'beta']);
    expect(onUpdateField).toHaveBeenNthCalledWith(4, expect.objectContaining({ key: 'owners' }), 'me, you');
    expect(onSetType).toHaveBeenCalledWith(undefined);
  });
});
