<script setup lang="ts">
import {
  createMountedMarkdownEditor,
  type EditorWindowContext,
  type EditorWindowContribution,
  type EditorWindowContributionHost,
  type MountedMarkdownEditor,
  renderEditorWindowContributions,
} from '@zorid/editor';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createRendererDebugLogger } from '../debug-log.js';
import { createFieldsPropertiesEditorContribution } from '../editor-window-fields-properties.js';
import type { FieldDto, FileFieldsDto, TypeDto } from '../types.js';

const props = withDefaults(
  defineProps<{
    text: string;
    documentPath?: string | undefined;
    fileFields?: FileFieldsDto | undefined;
    types?: readonly TypeDto[] | undefined;
    fieldsPropertiesEnabled?: boolean | undefined;
  }>(),
  {
    fieldsPropertiesEnabled: true,
  },
);
const emit = defineEmits<{
  change: [text: string];
  cursorChange: [position: number];
  save: [];
  error: [message: string];
  updateField: [field: FieldDto, value: unknown];
  updateType: [typeName: string | undefined];
}>();
const log = createRendererDebugLogger(window.zoridDesktop.saveDebugLog.bind(window.zoridDesktop), {
  scope: 'renderer.markdown-editor',
});

const editorHost = ref<HTMLElement>();
const contributionHost = ref<HTMLElement>();
let editor: MountedMarkdownEditor | undefined;
let editorWindowHost: EditorWindowContributionHost | undefined;

function toDomRect(
  rect: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | null,
): DOMRect | null {
  if (!rect) return null;
  return new DOMRect(rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top);
}

const propertiesContribution = computed<EditorWindowContribution[]>(() => {
  if (!props.documentPath || !props.fileFields || props.fieldsPropertiesEnabled === false) return [];
  return [
    createFieldsPropertiesEditorContribution({
      fileFields: props.fileFields,
      types: props.types ?? [],
      onUpdateField(field, value) {
        emit('updateField', field, value);
      },
      onSetType(typeName) {
        emit('updateType', typeName);
      },
    }),
  ];
});

function editorWindowContext(): EditorWindowContext {
  const view = editor?.view;
  const selection = view?.state.selection.ranges.map((range) => ({ from: range.from, to: range.to })) ?? [];
  const mainCursor = view?.state.selection.main.head ?? 0;
  const context: EditorWindowContext = { documentPath: props.documentPath ?? '' };
  if (!view) return context;
  return {
    ...context,
    editor: {
      hasFocus: view.hasFocus,
      selection,
      mainCursor,
      visibleRanges: view.visibleRanges.map((range) => ({ from: range.from, to: range.to })),
      coordsAtPos: (position) => toDomRect(view.coordsAtPos(position)),
      stateReadonly: view.state,
    },
  };
}

function renderEditorWindowHost(): void {
  if (!contributionHost.value) return;
  const context = editorWindowContext();
  if (editorWindowHost) {
    editorWindowHost.update(context, propertiesContribution.value);
    return;
  }
  editorWindowHost = renderEditorWindowContributions({
    parent: contributionHost.value,
    context,
    contributions: propertiesContribution.value,
  });
}

function emitCursorChange(): void {
  emit('cursorChange', editor?.view.state.selection.main.head ?? 0);
}

function openReference(target: { readonly path: string; readonly fragment?: string }): void {
  try {
    const url = new URL(target.path);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    void window.zoridDesktop.openExternalUrl(url.toString());
  } catch {
    return;
  }
}

onMounted(() => {
  if (!editorHost.value) return;
  try {
    editor = createMountedMarkdownEditor({
      parent: editorHost.value,
      text: props.text,
      onChange: (text) => {
        emit('change', text);
        renderEditorWindowHost();
      },
      onUpdate: (update) => {
        if (update.docChanged || update.selectionSet) emitCursorChange();
      },
      onSave: () => emit('save'),
      onOpenReference: openReference,
      onError: (error, context) => {
        log({ level: 'error', message: `Markdown editor runtime error: ${context}`, data: error });
      },
    });
    renderEditorWindowHost();
    emitCursorChange();
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
      renderEditorWindowHost();
      emitCursorChange();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      log({ level: 'error', message: 'Markdown editor failed to apply external text.', data: caught });
      emit('error', `Markdown editor failed to update. Debug details were saved. ${message}`);
    }
  },
);

watch([() => props.documentPath, () => props.fileFields, () => props.types], () => renderEditorWindowHost(), {
  deep: true,
});

onBeforeUnmount(() => {
  editorWindowHost?.dispose();
  editorWindowHost = undefined;
  editor?.destroy();
  editor = undefined;
});
</script>

<template>
  <div class="markdown-editor-shell" aria-label="Markdown editor shell">
    <div ref="contributionHost" class="markdown-editor-window-contributions" aria-label="Editor window contributions" />
    <div ref="editorHost" class="markdown-editor" aria-label="Markdown editor" />
  </div>
</template>
