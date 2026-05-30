<script setup lang="ts">
import type { VaultEntry } from '@zorid/platform-api';
import FileTreeNode from './FileTreeNode.vue';

const props = defineProps<{
  rootEntries: readonly VaultEntry[];
  entriesByDirectory: Readonly<Record<string, readonly VaultEntry[]>>;
  expandedDirectories: Readonly<Record<string, boolean>>;
  selectedPath?: string | undefined;
  draggingPath?: string | undefined;
  dragOverPath?: string | undefined;
}>();
const emit = defineEmits<{
  openEntry: [entry: VaultEntry];
  dragStart: [entry: VaultEntry, event: DragEvent];
  dragEnd: [entry: VaultEntry, event: DragEvent];
  dragOver: [entry: VaultEntry, event: DragEvent];
  dragEnter: [entry: VaultEntry, event: DragEvent];
  dragLeave: [entry: VaultEntry, event: DragEvent];
  dropOnDirectory: [entry: VaultEntry, event: DragEvent];
}>();
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
      :dragging-path="draggingPath"
      :drag-over-path="dragOverPath"
      @open-entry="emit('openEntry', $event)"
      @drag-start="(entry, event) => emit('dragStart', entry, event)"
      @drag-end="(entry, event) => emit('dragEnd', entry, event)"
      @drag-over="(entry, event) => emit('dragOver', entry, event)"
      @drag-enter="(entry, event) => emit('dragEnter', entry, event)"
      @drag-leave="(entry, event) => emit('dragLeave', entry, event)"
      @drop-on-directory="(entry, event) => emit('dropOnDirectory', entry, event)"
    />
  </ul>
</template>
