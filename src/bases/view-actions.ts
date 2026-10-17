import type { BaseValue, BaseViewPatch } from './document.ts';
import { BaseController } from './controller.ts';
import { baseValuesEqual } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';
import type { BaseKanbanMoveRequest } from './kanban-view.ts';
import type { BaseKanbanGroupOrderRequest } from './kanban-columns.ts';
import { normalizeBaseProperty } from './query.ts';
import type { BaseQueryResult } from './query.ts';
import type { BaseTableEdit } from './table-view.ts';

/** Convert existing presentation values explicitly; never save a display string. */
export function baseEditValue(value: BaseExpressionValue): BaseValue {
  let budget = 10000;
  const ancestors = new Set<object>();
  const convert = (value: BaseExpressionValue, depth: number): BaseValue => {
    if (--budget < 0 || depth > 64) throw new Error('The property value is too large or deeply nested');
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new Error('Invalid or cyclic property value');
    ancestors.add(value);
    try {
      switch (value.type) {
        case 'null': return null;
        case 'string': if (typeof value.value === 'string') return value.value; break;
        case 'boolean': if (typeof value.value === 'boolean') return value.value; break;
        case 'number': if (typeof value.value === 'number' && Number.isFinite(value.value)) return value.value; break;
        case 'list': if (Array.isArray(value.value)) return value.value.map(item => convert(item, depth + 1)); break;
        case 'object': {
          const mapping = value.value;
          if (!mapping || typeof mapping !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(mapping))) break;
          return Object.fromEntries(Object.keys(mapping).map(key => {
            const descriptor = Object.getOwnPropertyDescriptor(mapping, key)!;
            if (!('value' in descriptor)) throw new Error('Property values cannot contain accessors');
            return [key, convert(descriptor.value, depth + 1)];
          }));
        }
      }
      throw new Error(`Cannot persist a ${value.type} expression value as a property`);
    } finally { ancestors.delete(value); }
  };
  return convert(value, 0);
}

/** Internal bridge between the already-existing presentation and controller contracts. */
export function createBaseViewActions(controller: BaseController, options: {
  validate(): void;
  canRename?: boolean;
  validateFolder?(path: string): void;
}) {
  const current = (version: BaseQueryResult['version']) => {
    options.validate();
    const state = controller.state;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version !== state.version || state.error || !state.result) {
      throw new Error('This base result is stale; refresh before editing');
    }
    return state.result;
  };
  return {
    async editProperty(edit: BaseTableEdit): Promise<void> {
      current(edit.version);
      await controller.editProperty({ ...edit, version: edit.version as number, value: baseEditValue(edit.value) });
    },
    async requestGroupOrder(request: BaseKanbanGroupOrderRequest): Promise<void> {
      const result = current(request.version), group = result.view.groupBy;
      if (result.view.type !== 'kanban') throw new Error('This view is not a Kanban board');
      if (!group || typeof group !== 'object' || Array.isArray(group) || !('property' in group) || typeof group.property !== 'string') throw new Error('This view has no grouping property');
      if (normalizeBaseProperty(request.property) !== normalizeBaseProperty(group.property)) throw new Error('The grouping property changed');
      if (request.order !== undefined && !Array.isArray(request.order)) throw new Error('Manual group order must be a list');
      if (request.direction !== undefined && request.direction !== 'ASC' && request.direction !== 'DESC') throw new Error('Invalid group direction');
      const patch: BaseViewPatch = { groupOrder: request.order };
      if (request.direction !== undefined) patch.groupBy = { ...group, direction: request.direction };
      await controller.updateView(request.version as number, patch);
    },
    canMove(result: BaseQueryResult): boolean {
      const group = result.view.groupBy;
      if (!group || typeof group !== 'object' || Array.isArray(group) || !('property' in group) || typeof group.property !== 'string') return false;
      const property = normalizeBaseProperty(group.property);
      return property.startsWith('note.') || (property === 'file.folder' && !!options.canRename);
    },
    async requestMove(request: BaseKanbanMoveRequest): Promise<void> {
      const result = current(request.version), group = result.view.groupBy;
      if (!group || typeof group !== 'object' || Array.isArray(group) || !('property' in group) || typeof group.property !== 'string') throw new Error('This view has no grouping property');
      const property = normalizeBaseProperty(group.property);
      if (normalizeBaseProperty(request.property) !== property) throw new Error('The grouping property changed');
      const source = result.groups.find(group => group.rows.some(row => row.path === request.path));
      if (!source?.key || !baseValuesEqual(source.key, request.source, true)) throw new Error('The card group changed');
      const destination = result.groups.find(group => group.key && baseValuesEqual(group.key, request.destination, true))?.key
        ?? result.groupOptions.find(group => group.listed && baseValuesEqual(group.key, request.destination, true))?.key;
      if (!destination) throw new Error('The destination group is not present in this view');
      if (property === 'file.folder') {
        if (!options.canRename || destination.type !== 'string') throw new Error('The host cannot move this file to that folder');
        const folder = destination.value === '/' ? '' : destination.value;
        options.validateFolder?.(folder);
        // The host rename transaction validates the actual folder, collision and vault boundary.
        const name = request.path.slice(request.path.lastIndexOf('/') + 1);
        await controller.renameFile(request.version as number, request.path, folder ? `${folder}/${name}` : name);
      } else {
        if (!property.startsWith('note.')) throw new Error('This grouping property is read-only');
        await controller.moveToGroup({ version: request.version as number, path: request.path, value: baseEditValue(destination) });
      }
    },
  };
}
