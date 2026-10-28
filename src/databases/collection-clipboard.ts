import type { DatabaseCollection, DatabaseProperty } from '../core/databases.ts';
import type { BaseExpressionValue } from '../bases/expression.ts';
import { basePropertyName, parseBasePropertyInput, validateBasePropertyDefinition, validDateText } from '../bases/property-definitions.ts';
import { collectionPropertyDefinitions } from './collection-ui.ts';

const maximumOptions = 128; // The persisted collection schema's option bound.

function optionIdentity(field: DatabaseProperty, input: string): string {
  const matches = new Set(field.options.filter(option => option.id === input || option.name === input).map(option => option.id));
  if (!matches.size) throw new Error('The pasted option is not configured for this property.');
  if (matches.size !== 1) throw new Error('The pasted option is ambiguous; use an unambiguous option identity or label.');
  return matches.values().next().value!;
}

/** Collection-only clipboard conversion. The caller retains snapshot, entry and
 * schema-revision checks; ordinary/untyped properties never pass this boundary. */
export function collectionClipboardValue(collection: DatabaseCollection, property: string, input: BaseExpressionValue): BaseExpressionValue {
  if (collection.deleted) throw new Error('This collection is unavailable.');
  const fields = collection.properties.filter(field => field.id === basePropertyName(property));
  if (fields.length !== 1) throw new Error('The pasted property is missing or ambiguous in this collection.');
  const field = fields[0], definition = collectionPropertyDefinitions(collection)[field.id];
  try {
    validateBasePropertyDefinition(definition);
    if (field.options.length > maximumOptions) throw new Error('Too many configured property options.');
    if (input.type === 'null') return input;
    // Text is already in its persisted representation, including empty text.
    let value = input.type === 'string' && field.datatype !== 'text' ? parseBasePropertyInput(input.value, definition) : input;
    if (value.type === 'null') return value;
    switch (field.datatype) {
      case 'text':
        if (value.type !== 'string') throw new Error('Expected text.');
        break;
      case 'number':
        if (value.type !== 'number' || !Number.isFinite(value.value) || Number.isInteger(value.value) && !Number.isSafeInteger(value.value)) throw new Error('Expected a finite number; integers must be exactly representable.');
        break;
      case 'checkbox':
        if (value.type !== 'boolean') throw new Error('Expected true or false.');
        break;
      case 'date':
      case 'datetime':
        if (value.type !== 'string' || !validDateText(value.value, field.datatype === 'datetime')) throw new Error('Expected a valid date.');
        break;
      case 'select':
      case 'status': {
        if (value.type !== 'string') throw new Error('Expected one configured option.');
        const id = optionIdentity(field, value.value);
        if (id !== value.value) value = { type: 'string', value: id };
        break;
      }
      case 'multi-select': {
        if (value.type !== 'list' || value.value.length > maximumOptions) throw new Error('Expected a list of configured options.');
        const labels = value.value.map(item => { if (item.type !== 'string') throw new Error('Expected a list of configured options.'); return item.value; });
        const options = labels.map(label => optionIdentity(field, label));
        if (new Set(options).size !== options.length) throw new Error('The pasted list contains duplicate options.');
        if (options.some((id, index) => id !== labels[index])) value = { type: 'list', value: options.map(value => ({ type: 'string', value })) };
        break;
      }
      default: throw new Error('Unsupported collection property datatype.');
    }
    // Preserve already typed values and exact date/offset/fraction spelling.
    if (value.type === 'string' && input.type === 'string' && value.value === input.value) return input;
    return value;
  } catch (error) {
    throw new Error(`${field.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Validate every target before returning any commands to a mutation loop. */
export function prepareCollectionClipboardEdits<T extends { readonly property: string; readonly value: BaseExpressionValue }>(collection: DatabaseCollection, edits: readonly T[]): readonly T[] {
  return edits.map(edit => ({ ...edit, value: collectionClipboardValue(collection, edit.property, edit.value) }));
}
