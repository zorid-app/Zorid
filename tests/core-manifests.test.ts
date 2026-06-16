import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginManifest } from '../packages/plugin-api/src/index';
import { createLazyTriggerIndex, validatePluginManifest } from '../packages/plugin-host/src/index';

async function readCoreManifests(): Promise<readonly { dir: string; manifest: PluginManifest; source: string }[]> {
  const root = path.join(process.cwd(), 'plugins/core');
  const dirs = await readdir(root);
  return Promise.all(
    dirs.map(async (dir) => {
      const manifest = JSON.parse(await readFile(path.join(root, dir, 'plugin.json'), 'utf8')) as PluginManifest;
      const source = await readFile(path.join(root, dir, 'src/index.ts'), 'utf8');
      return { dir, manifest, source };
    }),
  );
}

describe('core plugin manifests', () => {
  it('are valid desktop placeholders with activation and static contributions', async () => {
    for (const { manifest } of await readCoreManifests()) {
      expect(validatePluginManifest(manifest), manifest.id).toEqual({ ok: true, errors: [] });
      expect(manifest.platforms).toEqual(['desktop']);
      expect(manifest.activation?.length, manifest.id).toBeGreaterThan(0);
      expect(Object.keys(manifest.contributes ?? {}).length, manifest.id).toBeGreaterThan(0);
    }
  });

  it('builds lazy trigger indexes from the real core manifests', async () => {
    const manifests = (await readCoreManifests()).map(({ manifest }) => manifest);
    const index = createLazyTriggerIndex(manifests);
    expect(index.onCommand.get('data-views.open')).toEqual(['zorid.core.data-views']);
    expect(index.onCommand.get('file-explorer.open-readme')).toEqual(['zorid.core.file-explorer']);
    expect(index.onMarkdownEmbed.get('.zbase')).toEqual(['zorid.core.data-views']);
    expect(index.onMarkdownEmbed.get('.png')).toEqual(['zorid.core.images']);
    expect(index.onFileExtension.get('.zbase')).toEqual(['zorid.core.data-views']);
    expect(index.onFileRenderer.get('.zbase')).toEqual(['zorid.core.data-views']);
    expect(index.onFileRenderer.get('.webp')).toEqual(['zorid.core.images']);
  });

  it('can expose static settings schemas from manifests without runtime activation', async () => {
    const manifests = (await readCoreManifests()).map(({ manifest }) => manifest);
    const statusBar = manifests.find((manifest) => manifest.id === 'zorid.core.status-bar');
    expect(statusBar?.contributes?.settings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'status-bar', title: 'Status Bar' })]),
    );
  });

  it('keeps runtime source usage aligned with required capabilities and contributions', async () => {
    for (const { manifest, source } of await readCoreManifests()) {
      const required = manifest.capabilities.required;
      const commandIds = [...source.matchAll(/register\.command\(\{\s*id:\s*['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      );
      if (commandIds.length > 0) expect(required, manifest.id).toContain('commands.register');
      for (const commandId of commandIds) {
        expect(
          manifest.contributes?.commands?.map((command) => command.id),
          manifest.id,
        ).toContain(commandId);
        expect(manifest.activation, manifest.id).toContain(`onCommand:${commandId}`);
      }
      if (source.includes('workspace.openFile')) expect(required, manifest.id).toContain('workspace.navigation');
      if (source.includes('register.viewRenderer') || source.includes('dataViews.openBase'))
        expect(required, manifest.id).toContain('workspace.views');
      if ((manifest.contributes?.fileRenderers?.length ?? 0) > 0)
        expect(required, manifest.id).toContain('workspace.fileRenderers');
      if (source.includes('dataViews.openBase')) expect(required, manifest.id).toContain('vault.read');
      if (source.includes('register.setting') || (manifest.contributes?.settings?.length ?? 0) > 0)
        expect(required, manifest.id).toContain('settings.register');
    }
  });
});
