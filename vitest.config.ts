import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      'solid-js/web': fileURLToPath(new URL('./node_modules/solid-js/web/dist/web.js', import.meta.url)),
      'solid-js': fileURLToPath(new URL('./node_modules/solid-js/dist/solid.js', import.meta.url)),
      '@zorid/app-kernel': fileURLToPath(new URL('./packages/app-kernel/src/index.ts', import.meta.url)),
      '@zorid/db/node-sqlite': fileURLToPath(new URL('./packages/db/src/node-sqlite.ts', import.meta.url)),
      '@zorid/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      '@zorid/desktop-app': fileURLToPath(new URL('./apps/desktop/src/index.ts', import.meta.url)),
      '@zorid/desktop-shell': fileURLToPath(new URL('./packages/desktop-shell/src/index.ts', import.meta.url)),
      '@zorid/editor/internal/editor-container-adapter': fileURLToPath(
        new URL('./packages/editor/src/editor-container-adapter.ts', import.meta.url),
      ),
      '@zorid/editor/internal/editor-embed-lifecycle': fileURLToPath(
        new URL('./packages/editor/src/editor-embed-lifecycle.ts', import.meta.url),
      ),
      '@zorid/editor/internal/editor-window-contributions': fileURLToPath(
        new URL('./packages/editor/src/editor-window-contributions.ts', import.meta.url),
      ),
      '@zorid/editor': fileURLToPath(new URL('./packages/editor/src/index.ts', import.meta.url)),
      '@zorid/index-api': fileURLToPath(new URL('./packages/index-api/src/index.ts', import.meta.url)),
      '@zorid/index-worker': fileURLToPath(new URL('./packages/index-worker/src/index.ts', import.meta.url)),
      '@zorid/indexer-js': fileURLToPath(new URL('./packages/indexer-js/src/index.ts', import.meta.url)),
      '@zorid/metadata': fileURLToPath(new URL('./packages/metadata/src/index.ts', import.meta.url)),
      '@zorid/mobile-app': fileURLToPath(new URL('./apps/mobile/src/index.ts', import.meta.url)),
      '@zorid/mobile-shell': fileURLToPath(new URL('./packages/mobile-shell/src/index.ts', import.meta.url)),
      '@zorid/object-store': fileURLToPath(new URL('./packages/object-store/src/index.ts', import.meta.url)),
      '@zorid/platform-api': fileURLToPath(new URL('./packages/platform-api/src/index.ts', import.meta.url)),
      '@zorid/plugin-api': fileURLToPath(new URL('./packages/plugin-api/src/index.ts', import.meta.url)),
      '@zorid/plugin-backlinks': fileURLToPath(new URL('./plugins/core/backlinks/src/index.ts', import.meta.url)),
      '@zorid/plugin-data-views/file-renderers': fileURLToPath(
        new URL('./plugins/core/data-views/src/file-renderers.ts', import.meta.url),
      ),
      '@zorid/plugin-data-views': fileURLToPath(new URL('./plugins/core/data-views/src/index.ts', import.meta.url)),
      '@zorid/plugin-fields': fileURLToPath(new URL('./plugins/core/fields/src/index.ts', import.meta.url)),
      '@zorid/plugin-images/file-renderers': fileURLToPath(
        new URL('./plugins/core/images/src/file-renderers.ts', import.meta.url),
      ),
      '@zorid/plugin-images': fileURLToPath(new URL('./plugins/core/images/src/index.ts', import.meta.url)),
      '@zorid/plugin-file-explorer': fileURLToPath(
        new URL('./plugins/core/file-explorer/src/index.ts', import.meta.url),
      ),
      '@zorid/file-explorer': fileURLToPath(new URL('./packages/file-explorer/src/index.ts', import.meta.url)),
      '@zorid/plugin-host': fileURLToPath(new URL('./packages/plugin-host/src/index.ts', import.meta.url)),
      '@zorid/plugin-ui': fileURLToPath(new URL('./packages/plugin-ui/src/index.ts', import.meta.url)),
      '@zorid/plugin-outline': fileURLToPath(new URL('./plugins/core/outline/src/index.ts', import.meta.url)),
      '@zorid/plugin-search': fileURLToPath(new URL('./plugins/core/search/src/index.ts', import.meta.url)),
      '@zorid/plugin-slash-menu/editor-containers': fileURLToPath(
        new URL('./plugins/core/slash-menu/src/editor-containers.ts', import.meta.url),
      ),
      '@zorid/plugin-slash-menu': fileURLToPath(new URL('./plugins/core/slash-menu/src/index.ts', import.meta.url)),
      '@zorid/plugin-status-bar': fileURLToPath(new URL('./plugins/core/status-bar/src/index.ts', import.meta.url)),
      '@zorid/plugin-tags': fileURLToPath(new URL('./plugins/core/tags/src/index.ts', import.meta.url)),
      '@zorid/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@zorid/sync': fileURLToPath(new URL('./packages/sync/src/index.ts', import.meta.url)),
      '@zorid/ui-vue/components.css': fileURLToPath(new URL('./packages/ui-vue/src/components.css', import.meta.url)),
      '@zorid/ui-vue': fileURLToPath(new URL('./packages/ui-vue/src/index.ts', import.meta.url)),
      '@zorid/vault': fileURLToPath(new URL('./packages/vault/src/index.ts', import.meta.url)),
      '@zorid/workspace': fileURLToPath(new URL('./packages/workspace/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,js,mjs}'],
    globals: false,
  },
});
