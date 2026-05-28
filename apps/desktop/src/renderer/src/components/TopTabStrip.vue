<script setup lang="ts">
defineProps<{
  openTabs: readonly string[];
  selectedPath?: string | undefined;
  editorTitle: string;
  status: string;
}>();
const emit = defineEmits<{ activate: [path: string] }>();
</script>

<template>
  <header class="editor-titlebar" aria-label="Editor title bar" data-app-titlebar>
    <div class="traffic-light-spacer" aria-hidden="true"></div>
    <nav class="top-tab-strip" aria-label="Open Markdown files">
      <button
        v-for="path in openTabs"
        :key="path"
        type="button"
        class="top-tab"
        :class="{ selected: selectedPath === path }"
        @click="emit('activate', path)"
      >
        {{ path.split('/').at(-1) }}
      </button>
      <span v-if="openTabs.length === 0" class="top-tab selected">{{ editorTitle }}</span>
    </nav>
    <span class="titlebar-context">{{ status }}</span>
  </header>
</template>
