import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const requiredDistAssets = [
  'packages/ui-vue/dist/index.js',
  'packages/ui-vue/dist/index.d.ts',
  'packages/ui-vue/dist/components.css',
  'packages/ui-vue/dist/tokens.css',
  'packages/ui-vue/dist/components/ZDialogWindow.vue',
  'packages/ui-vue/dist/components/ZButton.vue',
];

describe('ui-vue build contract', () => {
  beforeAll(() => {
    rmSync('packages/ui-vue/dist', { recursive: true, force: true });
    execFileSync('pnpm', ['--filter', '@zorid/ui-vue', 'run', 'build'], { stdio: 'pipe' });
  });

  it('emits the CSS and SFC assets referenced by the package dist entry', () => {
    for (const file of requiredDistAssets) {
      expect(existsSync(file), file).toBe(true);
    }
  });

  it('exposes explicit style entries instead of hidden component CSS side effects', () => {
    const pkg = JSON.parse(readFileSync('packages/ui-vue/package.json', 'utf8')) as {
      exports: Record<string, unknown>;
    };
    const index = readFileSync('packages/ui-vue/src/index.ts', 'utf8');

    expect(pkg.exports).toHaveProperty('./components.css', './dist/components.css');
    expect(pkg.exports).toHaveProperty('./tokens.css', './dist/tokens.css');
    expect(index).not.toContain("import './components.css'");
  });
});
