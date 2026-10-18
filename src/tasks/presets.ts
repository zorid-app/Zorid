import { stringify } from 'yaml';
import { TypesDocument } from './types-document.ts';

export interface TaskPresetIds {
  readonly type: string; readonly status: string; readonly planned: string; readonly deadline: string;
  readonly todo: string; readonly working: string; readonly done: string;
}
export interface PresetFile { readonly path: string; readonly source: string }
export interface TaskPreset {
  readonly typeId: string; readonly type: PresetFile; readonly base: PresetFile;
  readonly destination: string;
  /** Capture caller persists these values through the ordinary note create route. */
  readonly captureProperties: Readonly<Record<string, string>>;
}
function path(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/.test(value) || /^[A-Za-z]:/.test(value) || value.split('/').some(s => !s || s === '.' || s === '..') || value.split('/')[0].toLowerCase() === '.zorid') throw new Error('Invalid preset vault path');
  return value;
}
/** Data only. The host supplies CSPRNG IDs and performs durable non-clobber create;
 * this module never writes files, registers types, or activates a preset. */
export function createTaskPreset(ids: TaskPresetIds, locations: { type?: string; base?: string; destination?: string } = {}): TaskPreset {
  const tokens = Object.values(ids);
  if (tokens.length !== 7 || tokens.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(tokens).size !== 7) throw new Error('Preset requires seven distinct opaque identities');
  const typePath = path(locations.type ?? 'Types/Task.yaml');
  const basePath = path(locations.base ?? 'Bases/Tasks.base');
  const destination = path(locations.destination ?? 'Tasks');
  if (!/\.ya?ml$/.test(typePath) || !basePath.endsWith('.base') || typePath === basePath) throw new Error('Invalid preset file extensions');
  const typeSource = stringify({
    version: 1, id: ids.type, label: 'Task', properties: [
      { id: ids.status, key: 'status', label: 'Status', datatype: 'status', default: ids.todo, options: [
        { id: ids.todo, label: 'To do', category: 'not_started' },
        { id: ids.working, label: 'In progress', category: 'working' },
        { id: ids.done, label: 'Done', category: 'done' },
      ] },
      { id: ids.planned, key: 'planned', label: 'Planned day', datatype: 'date' },
      { id: ids.deadline, key: 'deadline', label: 'Deadline', datatype: 'date' },
    ], capabilities: { task: { status: ids.status, plannedDay: ids.planned, deadline: ids.deadline } },
  });
  TypesDocument.parse(typeSource);
  const baseSource = stringify({
    filters: { and: ['file.ext == "md"', `note.type == ${JSON.stringify(ids.type)}`] },
    newItemFolder: destination,
    creation: { type: ids.type, properties: { status: ids.todo } },
    views: [
      { type: 'table', name: 'Tasks', order: ['file.name','status','planned','deadline'], groupBy: { property: 'status', direction: 'ASC' } },
      { type: 'list', name: 'List', order: ['file.name','status','planned','deadline'] },
    ],
  });
  return Object.freeze({ typeId: ids.type, type: Object.freeze({path:typePath,source:typeSource}), base:Object.freeze({path:basePath,source:baseSource}),destination,
    captureProperties:Object.freeze({type:ids.type,status:ids.todo}) });
}
export interface TaskPresetPlan { readonly files: readonly PresetFile[]; readonly conflicts: readonly string[]; readonly ready: boolean }
/** Advisory inventory plan, never an overwrite authorization. Host must recheck
 * both destinations atomically/non-clobber on actual create to close races. */
export function planTaskPreset(preset: TaskPreset, existingPaths: Iterable<{ readonly path: string; readonly kind: 'file' | 'folder' }>): TaskPresetPlan {
  const key = (value: string) => value.normalize('NFC').toLowerCase();
  const existing = [...existingPaths].map(entry => ({ path: key(path(entry.path)), kind: entry.kind }));
  const files = [preset.type,preset.base];
  const blocked = (target: string, folder = false) => existing.some(entry =>
    (entry.path === key(target) && (!folder || entry.kind !== 'folder')) ||
    entry.path.startsWith(key(target) + '/') && !folder ||
    entry.kind === 'file' && key(target).startsWith(entry.path + '/'));
  const conflicts = files.filter(file => blocked(file.path)).map(f => f.path);
  if (blocked(preset.destination, true)) conflicts.push(preset.destination);
  return Object.freeze({files: Object.freeze(files),conflicts:Object.freeze(conflicts),ready:conflicts.length === 0});
}
