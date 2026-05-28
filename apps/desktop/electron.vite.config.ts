import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';

const desktopRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(desktopRoot, '../..');

const workspaceAliases = {
  '@zorid/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
  '@zorid/platform-api': path.resolve(repoRoot, 'packages/platform-api/src/index.ts'),
  '@zorid/plugin-api': path.resolve(repoRoot, 'packages/plugin-api/src/index.ts'),
  '@zorid/app-kernel': path.resolve(repoRoot, 'packages/app-kernel/src/index.ts'),
  '@zorid/plugin-host': path.resolve(repoRoot, 'packages/plugin-host/src/index.ts'),
  '@zorid/vault': path.resolve(repoRoot, 'packages/vault/src/index.ts'),
  '@zorid/workspace': path.resolve(repoRoot, 'packages/workspace/src/index.ts'),
  '@zorid/editor': path.resolve(repoRoot, 'packages/editor/src/index.ts'),
  '@zorid/db/node-sqlite': path.resolve(repoRoot, 'packages/db/src/node-sqlite.ts'),
  '@zorid/db': path.resolve(repoRoot, 'packages/db/src/index.ts'),
  '@zorid/index-api': path.resolve(repoRoot, 'packages/index-api/src/index.ts'),
  '@zorid/indexer-js': path.resolve(repoRoot, 'packages/indexer-js/src/index.ts'),
  '@zorid/index-worker': path.resolve(repoRoot, 'packages/index-worker/src/index.ts'),
  '@zorid/object-store': path.resolve(repoRoot, 'packages/object-store/src/index.ts'),
  '@zorid/desktop-shell': path.resolve(repoRoot, 'packages/desktop-shell/src/index.ts'),
  '@zorid/ui-vue/tokens.css': path.resolve(repoRoot, 'packages/ui-vue/src/tokens.css'),
  '@zorid/ui-vue/components.css': path.resolve(repoRoot, 'packages/ui-vue/src/components.css'),
  '@zorid/ui-vue': path.resolve(repoRoot, 'packages/ui-vue/src/index.ts'),
};

export default defineConfig({
  main: {
    resolve: { alias: workspaceAliases },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: path.resolve(desktopRoot, 'src/main/index.ts'),
      },
    },
  },
  preload: {
    resolve: { alias: workspaceAliases },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: path.resolve(desktopRoot, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: path.resolve(desktopRoot, 'src/renderer'),
    resolve: { alias: workspaceAliases },
    plugins: [vue()],
    build: {
      outDir: path.resolve(desktopRoot, 'out/renderer'),
      emptyOutDir: true,
    },
  },
});
