import { describe, expect, it } from 'vitest';
import { asPluginId, DisposableStack, normalizeVaultPath, ZoridError } from '../packages/shared/src/index';

describe('shared utilities', () => {
  it('disposes in reverse order', async () => {
    const calls: string[] = [];
    const stack = new DisposableStack();
    stack.use(() => calls.push('first'));
    stack.use({ dispose: () => calls.push('second') });
    await stack.dispose();
    expect(calls).toEqual(['second', 'first']);
  });

  it('normalizes vault paths and rejects traversal', () => {
    expect(normalizeVaultPath('/Notes/Test.md')).toBe('Notes/Test.md');
    expect(() => normalizeVaultPath('../outside.md')).toThrow(ZoridError);
  });

  it('validates plugin IDs', () => {
    expect(asPluginId('zorid.core.search')).toBe('zorid.core.search');
    expect(() => asPluginId('Bad ID')).toThrow(ZoridError);
  });
});
