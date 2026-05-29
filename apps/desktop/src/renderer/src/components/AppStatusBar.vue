<script setup lang="ts">
import { ZStatusBar } from '@zorid/ui-vue';

defineProps<{
  status: string;
  selectedPath?: string | undefined;
  indexState: string;
  fileCount: number;
  pluginCount: number;
}>();
</script>

<template>
  <ZStatusBar class="status-bar" aria-label="Application status" data-app-status-bar>
    <span class="status-bar__item" :title="status">{{ status }}</span>
    <span class="status-bar__item" :title="selectedPath ?? 'No file selected'">
      {{ selectedPath ?? 'No file selected' }}
    </span>
    <span class="status-bar__item" :title="`Index ${indexState} · ${fileCount} files`">
      Index {{ indexState }} · {{ fileCount }} files
    </span>
    <span class="status-bar__item" :title="`${pluginCount} plugins`">{{ pluginCount }} plugins</span>
  </ZStatusBar>
</template>
