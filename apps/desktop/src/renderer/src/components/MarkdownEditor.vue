<script setup lang="ts">
import { createMountedMarkdownEditor, type MountedMarkdownEditor } from '@zorid/editor';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ text: string }>();
const emit = defineEmits<{ change: [text: string]; save: [] }>();

const host = ref<HTMLElement>();
let editor: MountedMarkdownEditor | undefined;

onMounted(() => {
  if (!host.value) return;
  editor = createMountedMarkdownEditor({
    parent: host.value,
    text: props.text,
    onChange: (text) => emit('change', text),
    onSave: () => emit('save'),
  });
});

watch(
  () => props.text,
  (text) => {
    // The shell's full-text prop is a compatibility autosave/display cache.
    // CodeMirror remains the live source of truth; external replacements are
    // silent by default so cache synchronization does not echo back as edits.
    editor?.setText(text);
  },
);

onBeforeUnmount(() => {
  editor?.destroy();
  editor = undefined;
});
</script>

<template>
  <div ref="host" class="markdown-editor" aria-label="Markdown editor" />
</template>
