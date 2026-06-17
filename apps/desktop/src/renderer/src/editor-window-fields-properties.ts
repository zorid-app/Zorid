import type { EditorWindowContribution } from '@zorid/editor/internal/editor-window-contributions';
import type { JsonValue } from '@zorid/shared';
import type { FieldDto, FileFieldsDto, TypeDto } from './types.js';

function valueToInputValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function coerceFieldInputValue(raw: string | boolean, field: FieldDto): JsonValue {
  if (field.type === 'boolean') return Boolean(raw);
  if (field.type === 'int') return Number.parseInt(String(raw), 10) || 0;
  if (field.type === 'float') return Number.parseFloat(String(raw)) || 0;
  if (field.type === 'list') {
    return String(raw)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return String(raw);
}

function appendTypeSelector(
  section: HTMLElement,
  fileFields: FileFieldsDto,
  types: readonly TypeDto[],
  onSetType: (typeName: string | undefined) => void,
): void {
  const label = document.createElement('label');
  label.className = 'z-fields-properties-editor__field';

  const caption = document.createElement('span');
  caption.textContent = 'Type';
  label.append(caption);

  const select = document.createElement('select');
  select.name = 'zorid.type';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = 'None';
  select.append(none);

  for (const type of types) {
    const option = document.createElement('option');
    option.value = type.name;
    option.textContent = type.name;
    select.append(option);
  }
  select.value = fileFields.typeName ?? '';

  select.addEventListener('change', () => onSetType(select.value || undefined));
  label.append(select);
  section.append(label);
}

function appendDiagnosticList(section: HTMLElement, fileFields: FileFieldsDto): void {
  if (fileFields.diagnostics.length === 0) return;
  const list = document.createElement('div');
  list.className = 'z-fields-properties-editor__diagnostics';
  for (const diagnostic of fileFields.diagnostics) {
    const item = document.createElement('p');
    item.textContent = `${diagnostic.key}: ${diagnostic.message}`;
    list.append(item);
  }
  section.append(list);
}

function appendFieldInput(
  section: HTMLElement,
  field: FieldDto,
  onUpdateField: (field: FieldDto, value: JsonValue) => void,
): void {
  const label = document.createElement('label');
  label.className = 'z-fields-properties-editor__field';
  label.dataset.fieldKey = field.key;

  const caption = document.createElement('span');
  caption.textContent = field.required ? `${field.key} required` : field.key;
  label.append(caption);

  const input = document.createElement('input');
  input.name = field.key;
  input.type =
    field.type === 'boolean' ? 'checkbox' : field.type === 'int' || field.type === 'float' ? 'number' : 'text';
  if (input.type === 'checkbox') input.checked = Boolean(field.value);
  else input.value = valueToInputValue(field.value);
  input.dataset.fieldSource = field.source;
  input.addEventListener('change', () => {
    const raw = input.type === 'checkbox' ? input.checked : input.value;
    onUpdateField(field, coerceFieldInputValue(raw, field));
  });

  label.append(input);
  section.append(label);
}

export interface FieldsPropertiesEditorContributionOptions {
  readonly fileFields: FileFieldsDto;
  readonly types: readonly TypeDto[];
  readonly onUpdateField: (field: FieldDto, value: JsonValue) => void;
  readonly onSetType: (typeName: string | undefined) => void;
}

export function createFieldsPropertiesEditorContribution(
  options: FieldsPropertiesEditorContributionOptions,
): EditorWindowContribution {
  return {
    id: 'zorid.core.fields.properties-editor',
    placement: { kind: 'document-header' },
    priority: 100,
    render() {
      const element = document.createElement('section');
      element.className = 'z-fields-properties-editor';
      element.dataset.propertiesEditorRegistration = 'zorid.core.fields.properties-editor';
      element.dataset.documentPath = options.fileFields.path;
      element.setAttribute('aria-label', 'Properties');

      const title = document.createElement('p');
      title.className = 'z-fields-properties-editor__title';
      title.textContent = 'Properties';
      element.append(title);

      appendTypeSelector(element, options.fileFields, options.types, options.onSetType);
      appendDiagnosticList(element, options.fileFields);

      const fields = document.createElement('div');
      fields.className = 'z-fields-properties-editor__fields';
      for (const field of options.fileFields.fields) appendFieldInput(fields, field, options.onUpdateField);
      element.append(fields);

      if (options.fileFields.fields.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'z-fields-properties-editor__empty';
        empty.textContent = 'No indexed fields for this file.';
        element.append(empty);
      }

      return element;
    },
  };
}
