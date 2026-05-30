<script setup lang="ts">
import { createMountedMarkdownEditor, type MountedMarkdownEditor } from '@zorid/editor';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createRendererDebugLogger } from '../debug-log.js';

const props = defineProps<{ text: string }>();
const emit = defineEmits<{ change: [text: string]; save: []; error: [message: string] }>();
const log = createRendererDebugLogger(window.zoridDesktop.saveDebugLog.bind(window.zoridDesktop), {
  scope: 'renderer.markdown-editor',
});

const host = ref<HTMLElement>();
let editor: MountedMarkdownEditor | undefined;

onMounted(() => {
  if (!host.value) return;
  try {
    editor = createMountedMarkdownEditor({
      parent: host.value,
      text: props.text,
      onChange: (text) => emit('change', text),
      onSave: () => emit('save'),
      onError: (error, context) => {
        log({ level: 'error', message: `Markdown editor runtime error: ${context}`, data: error });
      },
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    log({ level: 'error', message: 'Markdown editor failed to mount.', data: caught });
    emit('error', `Markdown editor failed to mount. Debug details were saved. ${message}`);
  }
});

watch(
  () => props.text,
  (text) => {
    // The shell's full-text prop is a compatibility autosave/display cache.
    // CodeMirror remains the live source of truth; external replacements are
    // silent by default so cache synchronization does not echo back as edits.
    try {
      editor?.setText(text);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      log({ level: 'error', message: 'Markdown editor failed to apply external text.', data: caught });
      emit('error', `Markdown editor failed to update. Debug details were saved. ${message}`);
    }
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
