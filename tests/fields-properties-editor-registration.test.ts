// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import {
  createFieldsPropertiesEditorRegistration,
  fieldsPropertiesEditorRegistration,
} from '../plugins/core/fields/src/index';
import { normalizeVaultPath } from '../packages/shared/src/index';

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
    expect(element.textContent).toContain('status: open');
  });
});
