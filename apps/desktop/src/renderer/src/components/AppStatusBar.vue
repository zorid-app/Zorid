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
    <span>{{ status }}</span>
    <span>{{ selectedPath ?? 'No file selected' }}</span>
    <span>Index {{ indexState }} · {{ fileCount }} files</span>
    <span>{{ pluginCount }} plugins</span>
  </ZStatusBar>
</template>
