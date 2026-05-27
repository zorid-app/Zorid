<script setup lang="ts">
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{ text: string }>();
const emit = defineEmits<{ change: [text: string]; save: [] }>();

const host = ref<HTMLElement>();
let view: EditorView | undefined;
let applyingExternalText = false;

function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      markdown(),
      keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { emit('save'); return true; } }]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternalText) emit('change', update.state.doc.toString());
      }),
    ],
  });
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({ state: createState(props.text), parent: host.value });
});

watch(() => props.text, (text) => {
  if (!view || view.state.doc.toString() === text) return;
  applyingExternalText = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  applyingExternalText = false;
});

onBeforeUnmount(() => {
  view?.destroy();
  view = undefined;
});
</script>

<template>
  <div ref="host" class="markdown-editor" aria-label="Markdown editor" />
</template>
