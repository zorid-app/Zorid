import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiInfoFixture, capabilityInfos, capabilityNames } from '../packages/platform-api/src/index';
import { defineZoridPlugin, type PluginManifest, type ZoridPluginContext } from '../packages/plugin-api/src/index';

describe('platform/plugin API contracts', () => {
  it('does not expose private editor-window host primitives from @zorid/editor root', () => {
    const source = readFileSync('packages/editor/src/index.ts', 'utf8');
    for (const privateName of [
      'EditorWindowContribution',
      'EditorWindowPlacement',
      'ViewportPosition',
      'EditorWindowContributionHost',
      'renderEditorWindowContributions',
      'groupEditorWindowContributions',
    ]) {
      expect(source).not.toMatch(
        new RegExp(`export(?:\\s+type)?[\\s\\S]*\\b${privateName}\\b[\\s\\S]*from './editor-window-contributions`),
      );
    }
  });

  it('keeps AppAPI metadata-only with no public getService escape hatch', () => {
    expect(apiInfoFixture.namespaces.app.functions).toHaveProperty('apiInfo');
    expect(JSON.stringify(apiInfoFixture)).not.toContain('getService');
  });

  it('marks FieldsAPI and DataViewsAPI public-experimental', () => {
    expect(apiInfoFixture.namespaces.fields.stability).toBe('public-experimental');
    expect(apiInfoFixture.namespaces.fields.experimental).toBe(true);
    expect(apiInfoFixture.namespaces.dataViews.stability).toBe('public-experimental');
    expect(apiInfoFixture.namespaces.dataViews.experimental).toBe(true);
    expect(Object.keys(apiInfoFixture.namespaces)).toEqual(
      expect.arrayContaining([
        'vault',
        'workspace',
        'editor',
        'metadata',
        'search',
        'objects',
        'commands',
        'settings',
        'events',
        'storage',
        'plugins',
        'platform',
        'register',
      ]),
    );
  });

  it('documents every public namespace function in apiInfo metadata', () => {
    const expectedFunctions: Record<string, readonly string[]> = {
      app: ['apiInfo'],
      vault: ['readText', 'writeText', 'list', 'stat', 'createFolder', 'rename', 'delete', 'watch', 'read', 'write'],
      workspace: [
        'openFile',
        'openView',
        'splitPane',
        'closePane',
        'getSnapshot',
        'subscribe',
        'registerView',
        'activeFile',
        'split',
      ],
      editor: [
        'openDocument',
        'getActiveEditor',
        'registerExtension',
        'registerCommand',
        'activeEditor',
        'open',
        'save',
      ],
      metadata: ['getFile', 'backlinks', 'tags'],
      search: ['search'],
      objects: ['readType', 'readBase', 'writeObject'],
      fields: ['getFields', 'getType', 'updateField', 'setType'],
      dataViews: ['registerRenderer', 'evaluateFilters', 'openBase', 'renderEmbed'],
      commands: ['register', 'execute', 'list'],
      settings: ['register'],
      events: ['on', 'emit'],
      storage: ['get', 'set'],
      plugins: ['getApi', 'isActive', 'getStatus', 'listStatuses', 'activate'],
      platform: ['hasCapability', 'listCapabilities'],
      register: [
        'disposable',
        'command',
        'setting',
        'view',
        'fileRenderer',
        'editorContainer',
        'viewRenderer',
        'statusItem',
        'editorExtension',
        'markdownProcessor',
        'event',
        'domEvent',
      ],
    };
    for (const [namespace, functions] of Object.entries(expectedFunctions)) {
      expect(Object.keys(apiInfoFixture.namespaces[namespace]?.functions ?? {}).sort(), namespace).toEqual(
        [...functions].sort(),
      );
    }
  });

  it('keeps API metadata capability matrix aligned with the locked package design', () => {
    expect(apiInfoFixture.namespaces.vault.functions.watch?.capabilities).toEqual(['vault.read', 'nativeFs.watch']);
    expect(apiInfoFixture.namespaces.workspace.functions.splitPane?.capabilities).toEqual(['workspace.navigation']);
    expect(apiInfoFixture.namespaces.workspace.functions.closePane?.capabilities).toEqual(['workspace.navigation']);
    expect(apiInfoFixture.namespaces.register.functions.fileRenderer?.capabilities).toEqual([
      'workspace.fileRenderers',
    ]);
    expect(apiInfoFixture.namespaces.register.functions.editorContainer?.capabilities).toEqual(['editor.containers']);
    expect(apiInfoFixture.namespaces.editor.functions.getActiveEditor?.capabilities).toEqual(['editor.read']);
    expect(apiInfoFixture.namespaces.platform.functions).toHaveProperty('listCapabilities');
  });

  it('documents each capability with public metadata', () => {
    expect(capabilityInfos.map((capability) => capability.id).sort()).toEqual([...capabilityNames].sort());
    for (const capability of capabilityInfos) {
      expect(capability.since).toMatch(/^0\.1\.0$/);
      expect(capability.description.length).toBeGreaterThan(10);
      expect(['public', 'public-experimental', 'core-experimental', 'internal']).toContain(capability.stability);
    }
  });

  it('exports normalized capability names', () => {
    expect(capabilityNames).toContain('desktop.folderVault');
    expect(capabilityNames).toContain('workspace.fileRenderers');
    expect(capabilityNames).toContain('editor.containers');
    expect(capabilityNames).toContain('platform.haptics');
    expect(capabilityNames).not.toContain('haptics');
  });

  it('defines optional activation/contributes manifest fields', () => {
    const manifest = {
      schemaVersion: 1,
      id: 'zorid.core.search',
      name: 'Search',
      version: '0.1.0',
      kind: 'core',
      entry: './src/index.ts',
      zoridApi: '^0.1.0',
      platforms: ['desktop'],
      capabilities: { required: ['metadata.read'], optional: [] },
    } satisfies PluginManifest;
    expect(manifest.activation).toBeUndefined();
    expect(manifest.contributes).toBeUndefined();
  });

  it('defines static fileRenderer manifest contributions with public surface identifiers', () => {
    const manifest = {
      schemaVersion: 1,
      id: 'zorid.core.data-views',
      name: 'Data Views',
      version: '0.1.0',
      kind: 'core',
      entry: './src/index.ts',
      rendererEntry: './src/file-renderers.ts',
      zoridApi: '^0.1.0',
      platforms: ['desktop'],
      capabilities: { required: ['workspace.fileRenderers'], optional: [] },
      contributes: {
        fileRenderers: [
          {
            id: 'zorid.core.data-views.zbase',
            title: 'Zbase Data View',
            extensions: ['.zbase'],
            surfaces: ['full-page', 'markdown-embed'],
            priority: 100,
            rendererExport: 'zbaseFileRenderer',
          },
        ],
      },
    } satisfies PluginManifest;
    expect(manifest.contributes.fileRenderers[0].surfaces).toEqual(['full-page', 'markdown-embed']);
  });

  it('defines static editorContainer manifest contributions with public ADR0005 placement identifiers', () => {
    const manifest = {
      schemaVersion: 1,
      id: 'zorid.core.slash-menu',
      name: 'Slash Menu',
      version: '0.1.0',
      kind: 'core',
      entry: './src/index.ts',
      containerEntry: './src/editor-containers.ts',
      zoridApi: '^0.1.0',
      platforms: ['desktop'],
      capabilities: { required: ['editor.containers', 'editor.read'], optional: [] },
      contributes: {
        editorContainers: [
          {
            id: 'zorid.core.slash-menu.cursor',
            title: 'Slash Menu',
            placement: { kind: 'cursor-popover' },
            containerExport: 'slashMenuEditorContainer',
            activationReads: ['cursor', 'cursorText'],
          },
        ],
      },
    } satisfies PluginManifest;
    expect(manifest.contributes.editorContainers[0].placement.kind).toBe('cursor-popover');
  });

  it('makes host-owned fields/dataViews direct context properties at type level', () => {
    type HasDirectStructuredDataApis = ZoridPluginContext extends { fields: unknown; dataViews: unknown }
      ? true
      : false;
    const hasApis: HasDirectStructuredDataApis = true;
    expect(hasApis).toBe(true);
  });

  it('preserves defineZoridPlugin identity helper', () => {
    const plugin = defineZoridPlugin({ activate: () => undefined });
    expect(typeof plugin.activate).toBe('function');
  });
});
