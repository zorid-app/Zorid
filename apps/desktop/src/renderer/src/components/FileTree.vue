<script setup lang="ts">
import { ChevronDown, ChevronRight, FileText, Folder } from '@lucide/vue';
import type { VaultEntry } from '@zorid/platform-api';

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
    <li v-for="entry in rootEntries" :key="entry.path">
      <button type="button" class="tree-item" :class="{ selected: selectedPath === entry.path }" @click="emit('openEntry', entry)">
        <ChevronDown v-if="entry.kind === 'directory' && expandedDirectories[entry.path]" class="tree-icon" aria-hidden="true" />
        <ChevronRight v-else-if="entry.kind === 'directory'" class="tree-icon" aria-hidden="true" />
        <FileText v-else class="tree-icon" aria-hidden="true" />
        {{ entry.path }}
      </button>
      <ul v-if="entry.kind === 'directory' && expandedDirectories[entry.path]" class="nested">
        <li v-for="child in entriesByDirectory[entry.path] ?? []" :key="child.path">
          <button type="button" class="tree-item" :class="{ selected: selectedPath === child.path }" @click="emit('openEntry', child)">
            <Folder v-if="child.kind === 'directory'" class="tree-icon" aria-hidden="true" />
            <FileText v-else class="tree-icon" aria-hidden="true" />
            {{ child.path.split('/').at(-1) }}
          </button>
        </li>
      </ul>
    </li>
  </ul>
</template>
