import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'electron-vite';

const desktopRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(desktopRoot, '../..');

const workspaceAliases = {
  '@zorid/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
  '@zorid/vault': path.resolve(repoRoot, 'packages/vault/src/index.ts'),
  '@zorid/desktop-shell': path.resolve(repoRoot, 'packages/desktop-shell/src/index.ts'),
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
