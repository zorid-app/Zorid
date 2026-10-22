import {BASE_PROPERTY_DEFINITIONS_PATH, MAX_BASE_PROPERTY_SETTINGS_BYTES, parseBasePropertyDefinitions, updateBasePropertyDefinition} from './property-definitions.ts';
import type {BasePropertyDefinition} from './property-definitions.ts';
import type {ConditionalSavedSourceCapture, ConditionalSavedSourceWitness} from '../core/durable-writes.ts';
import type {NoteBuffer} from '../ui/note-buffer.ts';

interface Attempt {
  readonly owner: object;
  readonly key: string;
  readonly savedText: string;
  readonly witness?: ConditionalSavedSourceWitness;
  capture?: ConditionalSavedSourceCapture;
  desired?: string;
  /** An unused proof whose release failed must be retired before another save. */
  abandoned?: {readonly error: unknown};
}
interface RegistryState {tail: Promise<unknown>; attempt?: Attempt}
// All Base sessions and ordinary-note controls share the SAME NoteBuffer. The
// registry lock/attempt must share that identity too, rather than belong to a UI.
const registries = new WeakMap<NoteBuffer, RegistryState>();
const changed = () => new Error('The property settings saved source changed outside this editor. Refresh or reopen settings before applying.');
const pending = () => new Error('Another property settings save is pending. Retry or resolve its original shared draft before applying.');
function sameWitness(a: ConditionalSavedSourceWitness | undefined, b: ConditionalSavedSourceWitness | undefined): boolean {
  return a ? !!b && a.entryId === b.entryId && a.revision === b.revision && a.path === b.path : !b;
}
function snapshot<T>(value: T): T {
  if (value === undefined) return value;
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > MAX_BASE_PROPERTY_SETTINGS_BYTES) throw new Error('Property settings exceed source byte budget.');
  return JSON.parse(encoded) as T;
}

/** Targeted registry edits use the normal shared buffer/recovery path. Physical
 * text is a separate precondition; it never becomes the logical buffer baseline. */
export function createBasePropertyDefinitionSaver() {
  const owner = {};
  return {
    save(buffer: NoteBuffer, property: string, definition: BasePropertyDefinition | null, expected: BasePropertyDefinition | null | undefined,
      validate: () => void, onChange?: (previousText: string) => void): Promise<void> {
      // The form may change during capture/planning. Retain its original request,
      // including the distinction between no expected value and expected absence.
      let desiredDefinition: BasePropertyDefinition | null, expectedDefinition: BasePropertyDefinition | null | undefined, key: string;
      try {
        desiredDefinition = snapshot(definition); expectedDefinition = snapshot(expected);
        key = JSON.stringify([property, desiredDefinition, expected !== undefined, expectedDefinition]);
      } catch (error) { return Promise.reject(error); }
      let state = registries.get(buffer);
      if (!state) {state = {tail: Promise.resolve()}; registries.set(buffer, state);}
      const registry = state;
      const operation = registry.tail.then(async () => {
        validate(); await buffer.load(); validate();
        if (buffer.path !== BASE_PROPERTY_DEFINITIONS_PATH) throw new Error('The property settings file moved.');
        let attempt = registry.attempt;
        if (attempt && !attempt.abandoned && attempt.desired !== undefined && !buffer.dirty && !buffer.error
          && !buffer.hasRecoveryConflict && (!attempt.capture || buffer.conditionalSavedSourceStatus(attempt.capture) === 'settled')) {
          // An independent normal Save can acknowledge the original exact intent.
          // A changed clean source means recovery/reload retired that draft too.
          registry.attempt = undefined;
          if (attempt.owner === owner && attempt.key === key && buffer.savedText === attempt.desired) return;
          attempt = undefined;
        }
        if (attempt && (attempt.owner !== owner || attempt.key !== key)) throw pending();
        if (attempt?.abandoned) {
          // Never consume another capture slot after a lost release reply. The
          // original error stays visible even when cleanup succeeds on retry.
          await buffer.releaseConditionalSavedSource(attempt.capture!);
          registry.attempt = undefined; validate();
          if (attempt.desired !== undefined && buffer.text === attempt.desired && buffer.savedText === attempt.desired && !buffer.dirty && !buffer.error) return;
          throw attempt.abandoned.error;
        }
        if (attempt) {
          // Only retry the original buffer intent, not a newly transformed draft.
          if (attempt.desired === undefined || buffer.text !== attempt.desired || attempt.capture && buffer.conditionalSavedSourceStatus(attempt.capture) !== 'pending') throw pending();
          await buffer.flush(); validate();
          if (buffer.text !== attempt.desired || buffer.savedText !== attempt.desired || buffer.dirty || buffer.error) throw pending();
          registry.attempt = undefined; return;
        }
        const witness = buffer.savedDurableWitness;
        attempt = {owner, key, savedText: buffer.savedText, ...(witness ? {witness: Object.freeze({...witness})} : {})};
        registry.attempt = attempt;
        const original = attempt;
        const admitCapture = () => {
          validate();
          if (buffer.path !== BASE_PROPERTY_DEFINITIONS_PATH || registry.attempt !== original || buffer.savedText !== original.savedText || !sameWitness(original.witness, buffer.savedDurableWitness)) throw changed();
        };
        let cleanupAttempted = false;
        try {
          admitCapture();
          if (original.witness) original.capture = await buffer.captureConditionalSavedSource(original.witness, admitCapture);
          admitCapture();
          if (original.capture && (original.capture.source !== original.savedText || !sameWitness(original.witness, original.capture.logicalWitness))) throw changed();
          const source = buffer.text;
          if (expectedDefinition !== undefined && JSON.stringify(parseBasePropertyDefinitions(source).properties[property] ?? null) !== JSON.stringify(expectedDefinition)) throw new Error('This property definition changed while its settings were open. Reopen settings before applying.');
          const desired = updateBasePropertyDefinition(source, property, desiredDefinition);
          admitCapture();
          if (buffer.text !== source) throw new Error('The property settings draft changed before applying.');
          if (desired === source && !buffer.dirty && !buffer.error) {
            original.desired = desired;
            if (original.capture) {cleanupAttempted = true; await buffer.releaseConditionalSavedSource(original.capture);}
            registry.attempt = undefined; validate(); return;
          }
          buffer.update(desired, {validateWrite: () => {
            validate(); const current = buffer.savedDurableWitness;
            if (buffer.path !== BASE_PROPERTY_DEFINITIONS_PATH || original.witness && (!current || current.entryId !== original.witness.entryId || current.path !== original.witness.path)) throw changed();
          }, ...(original.capture ? {conditionalSavedSource: original.capture} : {})});
          original.desired = desired;
          onChange?.(source);
          await buffer.flush(); validate();
          if (buffer.text !== desired || buffer.savedText !== desired || buffer.dirty || buffer.error) throw pending();
          registry.attempt = undefined;
        } catch (error) {
          if (original.capture && buffer.conditionalSavedSourceStatus(original.capture) === 'unattached') {
            original.abandoned = {error};
            if (cleanupAttempted) throw error;
            try {await buffer.releaseConditionalSavedSource(original.capture); registry.attempt = undefined;}
            catch (releaseError) {throw new AggregateError([error, releaseError], `${error instanceof Error ? error.message : String(error)}. Releasing its unused saved-source capture also failed.`, {cause: error});}
          } else if (original.desired === undefined) registry.attempt = undefined;
          throw error;
        }
      });
      registry.tail = operation.catch(() => undefined);
      return operation;
    },
  };
}
