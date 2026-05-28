<script setup lang="ts">
import { computed } from 'vue';
import type { VaultEntry } from '../types.js';
import { entryName, entryTypeLabel } from './file-tree-model.js';

const props = defineProps<{
  entry: VaultEntry;
  entriesByDirectory: Readonly<Record<string, readonly VaultEntry[]>>;
  expandedDirectories: Readonly<Record<string, boolean>>;
  selectedPath?: string | undefined;
}>();
const emit = defineEmits<{ openEntry: [entry: VaultEntry] }>();
const displayName = computed(() => entryName(props.entry));
const typeLabel = computed(() => entryTypeLabel(props.entry));

function openEntry(entry: VaultEntry): void {
  emit('openEntry', entry);
}
</script>

<template>
  <li>
    <button type="button" class="tree-item" :class="{ selected: selectedPath === entry.path }" @click="openEntry(entry)">
      <span v-if="entry.kind === 'directory'" class="tree-disclosure" aria-hidden="true">{{ expandedDirectories[entry.path] ? '⌄' : '›' }}</span>
      <span v-else class="tree-disclosure tree-disclosure-placeholder" aria-hidden="true"></span>
      <span class="tree-label">{{ displayName }}</span>
      <span v-if="typeLabel" class="tree-type-label">{{ typeLabel }}</span>
    </button>
    <ul v-if="entry.kind === 'directory' && expandedDirectories[entry.path]" class="nested">
      <FileTreeNode
        v-for="child in entriesByDirectory[entry.path] ?? []"
        :key="child.path"
        :entry="child"
        :entries-by-directory="entriesByDirectory"
        :expanded-directories="expandedDirectories"
        :selected-path="selectedPath"
        @open-entry="openEntry"
      />
    </ul>
  </li>
</template>
