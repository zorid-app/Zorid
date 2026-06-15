<script setup lang="ts">
import { entryName, entryTypeLabel } from '@zorid/file-explorer';
import { computed } from 'vue';
import type { VaultEntry } from '../types.js';

const props = defineProps<{
  entry: VaultEntry;
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
  contextMenu: [entry: VaultEntry, event: MouseEvent];
}>();
const displayName = computed(() => entryName(props.entry));
const typeLabel = computed(() => entryTypeLabel(props.entry));
const isDragSource = computed(() => props.draggingPath === props.entry.path);
const isDragTarget = computed(() => props.entry.kind === 'directory' && props.dragOverPath === props.entry.path);
const dropTooltip = computed(() => {
  if (!props.draggingPath || props.draggingPath === props.entry.path) return undefined;
  if (props.entry.kind !== 'directory') return undefined;
  const sourceName = props.draggingPath.split('/').at(-1);
  return sourceName ? `Move ${sourceName} into ${props.entry.path || 'root'}` : undefined;
});

function openEntry(entry: VaultEntry): void {
  emit('openEntry', entry);
}

function onDragStart(event: DragEvent): void {
  event.dataTransfer?.setData('text/plain', props.entry.path);
  event.dataTransfer?.setData('application/x-zorid-vault-path', props.entry.path);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  emit('dragStart', props.entry, event);
}

function onDragEnd(event: DragEvent): void {
  emit('dragEnd', props.entry, event);
}

function onDragEnter(event: DragEvent): void {
  if (props.entry.kind !== 'directory') return;
  event.preventDefault();
  emit('dragEnter', props.entry, event);
}

function onDragOver(event: DragEvent): void {
  if (props.entry.kind !== 'directory') return;
  event.preventDefault();
  emit('dragOver', props.entry, event);
}

function onDragLeave(event: DragEvent): void {
  if (props.entry.kind !== 'directory') return;
  emit('dragLeave', props.entry, event);
}

function onDrop(event: DragEvent): void {
  if (props.entry.kind !== 'directory') return;
  event.preventDefault();
  emit('dropOnDirectory', props.entry, event);
}

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  emit('contextMenu', props.entry, event);
}

function isOutsideCurrentTarget(event: DragEvent): boolean {
  const current = event.currentTarget as Node | null;
  const related = event.relatedTarget as Node | null;
  return !current || !related || !current.contains(related);
}
</script>

<template>
  <li
    :class="{ 'tree-node-drop-target': isDragTarget }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="
      (event) => {
        if (isOutsideCurrentTarget(event)) onDragLeave(event);
      }
    "
    @drop="onDrop"
  >
    <button
      type="button"
      class="tree-item"
      :class="{ selected: selectedPath === entry.path, dragging: isDragSource, 'drop-target': isDragTarget }"
      :draggable="true"
      :title="dropTooltip"
      @click="openEntry(entry)"
      @contextmenu="onContextMenu"
      @dragstart="onDragStart"
      @dragend="onDragEnd"
    >
      <span
        v-if="entry.kind === 'directory'"
        class="tree-disclosure"
        :class="{ 'tree-disclosure-expanded': expandedDirectories[entry.path] }"
        aria-hidden="true"
      >
        ›
      </span>
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
        :dragging-path="draggingPath"
        :drag-over-path="dragOverPath"
        @open-entry="openEntry"
        @drag-start="(entry, event) => emit('dragStart', entry, event)"
        @drag-end="(entry, event) => emit('dragEnd', entry, event)"
        @drag-over="(entry, event) => emit('dragOver', entry, event)"
        @drag-enter="(entry, event) => emit('dragEnter', entry, event)"
        @drag-leave="(entry, event) => emit('dragLeave', entry, event)"
        @drop-on-directory="(entry, event) => emit('dropOnDirectory', entry, event)"
        @context-menu="(entry, event) => emit('contextMenu', entry, event)"
      />
    </ul>
  </li>
</template>
