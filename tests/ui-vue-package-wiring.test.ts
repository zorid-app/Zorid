import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

describe('ui-vue package wiring', () => {
  it('pins the deterministic behavior dependency inside the shared Vue package', () => {
    const pkg = readJson<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      exports?: Record<string, unknown>;
    }>('packages/ui-vue/package.json');

    expect(pkg.dependencies?.['reka-ui']).toBeDefined();
    expect(pkg.dependencies?.vue).toBeDefined();
    expect(pkg.devDependencies?.['@vitejs/plugin-vue']).toBeDefined();
    expect(pkg.devDependencies?.vite).toBeDefined();
    expect(pkg.devDependencies?.['vue-tsc']).toBeDefined();
    expect(pkg.scripts?.typecheck).toContain('vue-tsc --noEmit');
    expect(pkg.scripts?.build).toContain('vue-tsc --noEmit');
    expect(pkg.exports).toHaveProperty('.');
    expect(pkg.exports).toHaveProperty('./tokens.css');
    expect(pkg.exports).toHaveProperty('./components.css');
  });

  it('includes Vue SFC sources in the package typecheck surface', () => {
    const tsconfig = readJson<{ include?: string[] }>('packages/ui-vue/tsconfig.json');

    expect(tsconfig.include).toEqual(expect.arrayContaining(['src/**/*.ts', 'src/**/*.d.ts', 'src/**/*.vue']));
  });

  it('lets the desktop renderer consume shared UI sources and tokens through workspace aliases', () => {
    const desktopPkg = readJson<{ dependencies?: Record<string, string> }>('apps/desktop/package.json');
    const electronConfig = readFileSync('apps/desktop/electron.vite.config.ts', 'utf8');
    const desktopTsconfig = readJson<{ references?: Array<{ path: string }> }>('apps/desktop/tsconfig.json');
    const rootPkg = readJson<{ devDependencies?: Record<string, string>; scripts?: Record<string, string> }>('package.json');
    const baseTsconfig = readJson<{ compilerOptions?: { paths?: Record<string, string[]> } }>('tsconfig.base.json');

    expect(desktopPkg.dependencies?.['@zorid/ui-vue']).toBe('workspace:*');
    expect(electronConfig).toContain("'@zorid/ui-vue': path.resolve(repoRoot, 'packages/ui-vue/src/index.ts')");
    expect(electronConfig).toContain("'@zorid/ui-vue/tokens.css': path.resolve(repoRoot, 'packages/ui-vue/src/tokens.css')");
    expect(electronConfig).toContain("'@zorid/ui-vue/components.css': path.resolve(repoRoot, 'packages/ui-vue/src/components.css')");
    expect(desktopTsconfig.references?.map((reference) => reference.path)).toContain('../../packages/ui-vue');
    expect(baseTsconfig.compilerOptions?.paths?.['@zorid/ui-vue/tokens.css']).toEqual(['packages/ui-vue/src/tokens.css']);
    expect(baseTsconfig.compilerOptions?.paths?.['@zorid/ui-vue/components.css']).toEqual(['packages/ui-vue/src/components.css']);
    expect(rootPkg.scripts?.['prepare:ui-vue']).toBe('pnpm --filter @zorid/ui-vue run build');
    expect(rootPkg.scripts?.typecheck).toContain('pnpm run prepare:ui-vue');
    expect(rootPkg.scripts?.build).toContain('pnpm run prepare:ui-vue');
    expect(rootPkg.scripts?.test).toContain('pnpm run prepare:ui-vue');
    expect(rootPkg.devDependencies?.['@vue/test-utils']).toBeDefined();
    expect(rootPkg.devDependencies?.['happy-dom']).toBeDefined();
  });
});
