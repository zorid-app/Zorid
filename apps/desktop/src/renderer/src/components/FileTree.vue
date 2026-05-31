<script setup lang="ts">
import type { VaultEntry } from '@zorid/platform-api';
import { computed, nextTick, ref, watch } from 'vue';
import FileTreeNode from './FileTreeNode.vue';

const props = defineProps<{
  rootEntries: readonly VaultEntry[];
  entriesByDirectory: Readonly<Record<string, readonly VaultEntry[]>>;
  expandedDirectories: Readonly<Record<string, boolean>>;
  selectedPath?: string | undefined;
  draggingPath?: string | undefined;
  dragOverPath?: string | undefined;
  pendingCreation?: {
    kind: 'file' | 'folder';
    parentPath: string;
  };
}>();
const emit = defineEmits<{
  openEntry: [entry: VaultEntry];
  dragStart: [entry: VaultEntry, event: DragEvent];
  dragEnd: [entry: VaultEntry, event: DragEvent];
  dragOver: [entry: VaultEntry, event: DragEvent];
  dragEnter: [entry: VaultEntry, event: DragEvent];
  dragLeave: [entry: VaultEntry, event: DragEvent];
  dropOnDirectory: [entry: VaultEntry, event: DragEvent];
  dragOverRoot: [event: DragEvent];
  dragEnterRoot: [event: DragEvent];
  dragLeaveRoot: [event: DragEvent];
  dropOnRoot: [event: DragEvent];
  draftCommit: [kind: 'file' | 'folder', parentPath: string, name: string];
  draftCancel: [];
}>();

const hasRootDraft = computed(
  () => (props.pendingCreation?.kind === 'file' || props.pendingCreation?.kind === 'folder') && props.pendingCreation?.parentPath === '',
);
const draftName = ref('Untitled');
const draftInput = ref<HTMLInputElement>();

watch(
  () => props.pendingCreation,
  async (next) => {
    if (!next) return;
    draftName.value = 'Untitled';
    await nextTick();
    draftInput.value?.focus();
    draftInput.value?.select();
  },
  { deep: true },
);

function commitRootDraft(name: string): void {
  if (!props.pendingCreation) return;
  emit('draftCommit', props.pendingCreation.kind, props.pendingCreation.parentPath, name);
}

function cancelRootDraft(): void {
  emit('draftCancel');
}

function onDraftInput(event: Event): void {
  draftName.value = (event.target as HTMLInputElement).value;
}

function onDraftInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    const nextName = draftInput.value?.value ?? draftName.value;
    if (nextName.trim()) {
      commitRootDraft(nextName);
      return;
    }
    draftInput.value?.focus();
    draftInput.value?.select();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelRootDraft();
  }
}

function onDraftInputBlur(): void {
  commitRootDraft(draftName.value);
}

function onRootDragEnter(event: DragEvent): void {
  if (event.defaultPrevented) return;
  event.preventDefault();
  emit('dragEnterRoot', event);
}

function onRootDragOver(event: DragEvent): void {
  if (event.defaultPrevented) return;
  event.preventDefault();
  emit('dragOverRoot', event);
}

function onRootDrop(event: DragEvent): void {
  if (event.defaultPrevented) return;
  event.preventDefault();
  emit('dropOnRoot', event);
}

</script>

<template>
  <ul
    class="file-tree"
    :class="{ 'file-tree-root-drop-target': dragOverPath === '' && !!draggingPath }"
    aria-label="Vault files"
    data-app-file-tree
    @dragenter="onRootDragEnter"
    @dragover="onRootDragOver"
    @dragleave="(event) => emit('dragLeaveRoot', event)"
    @drop="onRootDrop"
>
    <li v-if="hasRootDraft" class="tree-node-draft" role="none">
      <label class="tree-item tree-node-draft-item" @mousedown="(event) => event.stopPropagation()">
        <span class="tree-disclosure tree-disclosure-placeholder" aria-hidden="true"></span>
        <input
          ref="draftInput"
          class="tree-draft-input"
          type="text"
          :value="draftName"
          aria-label="New file or folder name"
          @input="onDraftInput"
          @blur="onDraftInputBlur"
          @keydown="onDraftInputKeydown"
        />
      </label>
    </li>
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
