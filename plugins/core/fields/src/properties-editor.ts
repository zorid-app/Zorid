import type { FieldValue } from '@zorid/platform-api';
import type { Disposable, VaultPath } from '@zorid/shared';

export interface PropertiesEditorContext {
  readonly documentPath: VaultPath;
  readonly fields: readonly FieldValue[];
  readonly rawFrontmatter?: string;
}

export interface PropertiesEditorRegistration {
  readonly id: string;
  readonly placement: 'document-header';
  readonly priority?: number;
  readonly enabledByDefault: boolean;
  render(context: PropertiesEditorContext): HTMLElement | { readonly element: HTMLElement; dispose?(): void };
}

export function createFieldsPropertiesEditorRegistration(): PropertiesEditorRegistration {
  return {
    id: 'zorid.core.fields.properties-editor',
    placement: 'document-header',
    priority: 100,
    enabledByDefault: true,
    render(context) {
      const element = document.createElement('section');
      element.className = 'z-fields-properties-editor';
      element.dataset.propertiesEditorRegistration = 'zorid.core.fields.properties-editor';
      element.dataset.documentPath = context.documentPath;
      element.setAttribute('aria-label', 'Properties');
      element.textContent = context.fields.map((field) => `${field.key}: ${String(field.value)}`).join('\n');
      return element;
    },
  };
}

export interface FieldsPluginApi {
  readonly propertiesEditor: PropertiesEditorRegistration;
}

export function disposePropertiesEditorRegistration(disposable?: Disposable): void | Promise<void> {
  return disposable?.dispose();
}
