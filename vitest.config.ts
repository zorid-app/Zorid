import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@zorid/app-kernel': fileURLToPath(new URL('./packages/app-kernel/src/index.ts', import.meta.url)),
      '@zorid/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
      '@zorid/desktop-app': fileURLToPath(new URL('./apps/desktop/src/index.ts', import.meta.url)),
      '@zorid/desktop-shell': fileURLToPath(new URL('./packages/desktop-shell/src/index.ts', import.meta.url)),
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
      '@zorid/plugin-data-views': fileURLToPath(new URL('./plugins/core/data-views/src/index.ts', import.meta.url)),
      '@zorid/plugin-fields': fileURLToPath(new URL('./plugins/core/fields/src/index.ts', import.meta.url)),
      '@zorid/plugin-file-explorer': fileURLToPath(new URL('./plugins/core/file-explorer/src/index.ts', import.meta.url)),
      '@zorid/plugin-host': fileURLToPath(new URL('./packages/plugin-host/src/index.ts', import.meta.url)),
      '@zorid/plugin-outline': fileURLToPath(new URL('./plugins/core/outline/src/index.ts', import.meta.url)),
      '@zorid/plugin-search': fileURLToPath(new URL('./plugins/core/search/src/index.ts', import.meta.url)),
      '@zorid/plugin-status-bar': fileURLToPath(new URL('./plugins/core/status-bar/src/index.ts', import.meta.url)),
      '@zorid/plugin-tags': fileURLToPath(new URL('./plugins/core/tags/src/index.ts', import.meta.url)),
      '@zorid/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
      '@zorid/sync': fileURLToPath(new URL('./packages/sync/src/index.ts', import.meta.url)),
      '@zorid/ui-vue': fileURLToPath(new URL('./packages/ui-vue/src/index.ts', import.meta.url)),
      '@zorid/vault': fileURLToPath(new URL('./packages/vault/src/index.ts', import.meta.url)),
      '@zorid/workspace': fileURLToPath(new URL('./packages/workspace/src/index.ts', import.meta.url))
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,js,mjs}'],
    globals: false,
  },
});
