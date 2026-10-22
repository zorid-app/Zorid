/** Typed presentation only. Selection, inference and resolution stay in core. */
import type { DocumentBaseValue } from '../core/document-semantics.ts';
import { BASE_NULL, BaseExpressionError } from './expression.ts';
import type { BaseExpressionValue } from './expression.ts';

export interface SharedBaseValueBudget { remaining: number }
/** One projector per response preserves namespace identity and a shared node
 * budget across every value map. Input data must be a sealed response clone. */
export function createSharedBaseValueProjector(timezone = 'UTC', budget: SharedBaseValueBudget = { remaining: 200000 }): (input: DocumentBaseValue, depth?: number) => BaseExpressionValue {
  const invalid = (message: string): never => { throw new Error(message); };
  const namespaces = new Map<string, BaseExpressionValue>();
  const value = (input: DocumentBaseValue, depth = 0): BaseExpressionValue => {
    if (--budget.remaining < 0 || depth > 128) return invalid('The Base result is too large to display.');
    switch (input.type) {
      case 'null': return BASE_NULL;
      case 'boolean': case 'number': case 'string': return Object.freeze({ ...input });
      case 'date': return Object.freeze({ ...input, ...(!input.hasTime ? { presentationTimezone: timezone } : {}) });
      // Existing presentation values express weeks as calendar days. No query
      // arithmetic or grouping is repeated here.
      case 'duration': return Object.freeze({ ...input, days: input.days + input.weeks * 7 });
      case 'list': return Object.freeze({ type: 'list', value: Object.freeze(input.value.map(item => value(item, depth + 1))) });
      case 'object': return Object.freeze({ type: 'object', value: Object.freeze(Object.fromEntries(input.value.map(([key, item]) => [key, value(item, depth + 1)]))) });
      case 'error': {
        const error = new BaseExpressionError('unsupported', input.message);
        // Preserve Rust codes (including unavailable/numeric-domain) while
        // adapting to the preexisting renderer's Error-shaped value.
        Object.defineProperty(error, 'code', { value: input.code, enumerable: true });
        return Object.freeze({ type: 'error', error: Object.freeze(error) });
      }
      case 'html': case 'image': case 'icon': return Object.freeze({type:'namespace',name:input.value,presentation:Object.freeze({kind:input.type,value:input.value}),get(){return BASE_NULL;}});
      case 'file': case 'link': {
        if(input.type==='link'&&input.subpath!==undefined&&(typeof input.subpath!=='string'||!input.subpath.startsWith('#')))return invalid('The shared link subpath is invalid.');
        const key = JSON.stringify(input), existing = namespaces.get(key);
        if (existing) return existing;
        // The existing view renders a namespace by name. Its inert data getter
        // is not an evaluator/host callback and cannot access a live vault.
        const projected: BaseExpressionValue = Object.freeze({ type: 'namespace', name: input.type === 'link' ? input.display ?? input.path : input.path,
          sharedValue: Object.freeze({ ...input }), ...(input.type==='link'?{presentation:Object.freeze({kind:'link' as const,value:input.path,...(input.subpath!==undefined?{subpath:input.subpath}:{}),...(input.displayValue?{label:value(input.displayValue,depth+1)}:{}),...(input.target?{target:input.target}:{}),external:input.external})}:{}), get(name: string) { return name === 'path' ? Object.freeze({ type: 'string', value: input.path }) : BASE_NULL; } });
        namespaces.set(key, projected); return projected;
      }
    }
  };
  return value;
}
