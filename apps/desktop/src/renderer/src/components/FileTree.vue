<script setup lang="ts">
import type { VaultEntry } from '@zorid/platform-api';
import FileTreeNode from './FileTreeNode.vue';

defineProps<{
  rootEntries: readonly VaultEntry[];
  entriesByDirectory: Readonly<Record<string, readonly VaultEntry[]>>;
  expandedDirectories: Readonly<Record<string, boolean>>;
  selectedPath?: string | undefined;
}>();
const emit = defineEmits<{ openEntry: [entry: VaultEntry] }>();
</script>

<template>
  <ul class="file-tree" aria-label="Vault files" data-app-file-tree>
    <FileTreeNode
      v-for="entry in rootEntries"
      :key="entry.path"
      :entry="entry"
      :entries-by-directory="entriesByDirectory"
      :expanded-directories="expandedDirectories"
      :selected-path="selectedPath"
      @open-entry="emit('openEntry', $event)"
    />
  </ul>
</template>
