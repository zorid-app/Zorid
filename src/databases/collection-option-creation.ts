import type {DatabaseCollection, DatabaseProperty, DatabaseRequest, DatabaseService} from '../core/databases.ts';

export interface PrepareCollectionOptionCreationOptions {
  readonly service: DatabaseService;
  readonly collection: DatabaseCollection;
  readonly propertyId: string;
  /** Exact displayed label. Option values are the stable IDs returned by the core. */
  readonly label: string;
  readonly validate: () => void;
}
export interface CollectionOptionCreation {
  /** Retain this handle through uncertainty; retries never mint another operation. */
  run(): Promise<DatabaseCollection>;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameField(before: DatabaseProperty, after: DatabaseProperty, appended = false): boolean {
  return before.id === after.id && before.name === after.name && before.datatype === after.datatype
    && JSON.stringify(before.default) === JSON.stringify(after.default)
    && after.options.length === before.options.length + (appended ? 1 : 0)
    && before.options.every((option, index) => {
      const current = after.options[index];
      return current?.id === option.id && current.name === option.name && current.color === option.color && current.category === option.category;
    });
}

/** Schema creation only; the caller separately acknowledges the view and selects
 * the returned option ID through its original row/value write guard. */
export function prepareCollectionOptionCreation(options: PrepareCollectionOptionCreationOptions): CollectionOptionCreation {
  options.validate();
  const {service, propertyId, label, validate} = options;
  const collection = freeze(structuredClone(options.collection));
  if (collection.deleted) throw new Error('This collection is in Trash. Restore it before adding an option.');
  const property = collection.properties.find(property => property.id === propertyId);
  if (!property || !['select', 'multi-select', 'status'].includes(property.datatype)) throw new Error('This property does not support configured options.');
  if (typeof label !== 'string' || !label.trim() || new TextEncoder().encode(label).length > 256 || /\p{Cc}/u.test(label)) throw new Error('Enter a nonempty option name without control characters (up to 256 bytes).');
  if (property.options.some(option => option.name === label)) throw new Error('An option with this name already exists. Choose it from the list.');
  const command: DatabaseRequest = freeze({op: 'update', operationId: crypto.randomUUID(), collectionId: collection.id,
    expectedRevision: collection.revision, name: collection.name,
    properties: collection.properties.map(field => field.id === propertyId ? {...field,
      options: [...field.options, {name: label, ...(field.datatype === 'status' ? {category: 'not_started' as const} : {})}]} : field),
  });
  let pending: Promise<DatabaseCollection> | undefined, accepted: DatabaseCollection | undefined;
  return Object.freeze({run(): Promise<DatabaseCollection> {
    try { validate(); } catch (error) { return Promise.reject(error); }
    if (accepted) return Promise.resolve(accepted);
    if (pending) return pending;
    const operation = (async () => {
      const response = await service.request(command);
      validate();
      if (response.projection.pending || response.projection.issues.length) throw new Error(response.projection.issues.map(issue => issue.message).join('\n') || 'The option is committed locally but its files still need publication. Retry this option creation.');
      const matches = response.collections.filter(candidate => candidate.id === collection.id), next = matches[0];
      const target = next?.properties.find(field => field.id === propertyId), created = target?.options.filter(option => option.name === label);
      const oldIds = new Set(property.options.map(option => option.id));
      if (matches.length !== 1 || !next || next.deleted || next.name !== collection.name || !next.revision
        || next.properties.length !== collection.properties.length
        || !collection.properties.every((field, index) => !!next.properties[index] && sameField(field, next.properties[index], field.id === propertyId))
        || !target || target.datatype !== property.datatype || created?.length !== 1
        || !/^[0-9a-z]{12}$/.test(created[0].id) || oldIds.has(created[0].id)
        || target.options.at(-1) !== created[0]
        || property.datatype === 'status' && created[0].category !== 'not_started') {
        throw new Error('The created option could not be verified. Keep this editor open and retry the same creation.');
      }
      accepted = freeze(structuredClone(next));
      return accepted;
    })();
    pending = operation;
    const settled = () => { if (pending === operation) pending = undefined; };
    void operation.then(settled, settled);
    return operation;
  }});
}
