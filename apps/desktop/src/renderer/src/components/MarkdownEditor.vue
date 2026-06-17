<script setup lang="ts">
import {
  type BlockAction,
  createMountedMarkdownEditor,
  type MarkdownBlockRegistration,
  type MountedMarkdownEditor,
} from '@zorid/editor';
import {
  collectMarkdownEmbedOccurrencesFromText,
  EditorEmbedLifecycle,
  markdownEmbedOccurrenceFromBlockMatch,
} from '@zorid/editor/internal/editor-embed-lifecycle';
import type {
  EditorWindowContext,
  EditorWindowContribution,
  EditorWindowContributionHost,
} from '@zorid/editor/internal/editor-window-contributions';
import { renderEditorWindowContributions } from '@zorid/editor/internal/editor-window-contributions';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createRendererDebugLogger } from '../debug-log.js';
import { routeEditorContainerCapturedKeydown } from '../editor-container-key-routing.js';
import { createFieldsPropertiesEditorContribution } from '../editor-window-fields-properties.js';
import { createTrustedEditorContainerContributions } from '../trusted-editor-containers.js';
import { createTrustedFileRendererEmbedAdapter, trustedFileRendererIdentity } from '../trusted-file-renderers.js';
import type {
  EditorContainerMatchDto,
  FieldDto,
  FileFieldsDto,
  FileRendererMatchDto,
  MarkdownEmbedDto,
  TypeDto,
} from '../types.js';

const props = withDefaults(
  defineProps<{
    text: string;
    documentPath?: string | undefined;
    fileFields?: FileFieldsDto | undefined;
    markdownEmbeds?: readonly MarkdownEmbedDto[] | undefined;
    editorContainers?: readonly EditorContainerMatchDto[] | undefined;
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
  openReference: [target: { readonly path: string; readonly fragment?: string }];
}>();
const log = createRendererDebugLogger(window.zoridDesktop.saveDebugLog.bind(window.zoridDesktop), {
  scope: 'renderer.markdown-editor',
});

const editorHost = ref<HTMLElement>();
const contributionHost = ref<HTMLElement>();
let editor: MountedMarkdownEditor | undefined;
let editorWindowHost: EditorWindowContributionHost | undefined;
let removeEditorKeydownCapture: (() => void) | undefined;
let embedLifecycle: EditorEmbedLifecycle | undefined;

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

const trustedEditorContainerContributions = computed<EditorWindowContribution[]>(() =>
  createTrustedEditorContainerContributions(props.editorContainers ?? [], {
    getText: () => editor?.view.state.doc.toString() ?? props.text,
    close: () => renderEditorWindowHost(),
  }),
);

const editorWindowContributions = computed<EditorWindowContribution[]>(() => [
  ...propertiesContribution.value,
  ...trustedEditorContainerContributions.value,
]);

const fileRendererEmbedMatches = computed<ReadonlyMap<string, FileRendererMatchDto>>(() => {
  const matches = new Map<string, FileRendererMatchDto>();
  for (const embed of props.markdownEmbeds ?? []) if (embed.renderer) matches.set(embed.basePath, embed.renderer);
  return matches;
});

function documentSessionKey(): string {
  return props.documentPath ?? 'untitled-markdown-document';
}

function fileRendererIdentityForTarget(target: string): string | undefined {
  const renderer = fileRendererEmbedMatches.value.get(target);
  return renderer ? trustedFileRendererIdentity(renderer) : undefined;
}

function reconcileMarkdownEmbeds(): void {
  if (!embedLifecycle) return;
  const text = editor?.view.state.doc.toString() ?? props.text;
  const visibleRanges = editor?.view.visibleRanges ?? [{ from: 0, to: Math.min(text.length, 2000) }];
  const visibleFrom = Math.min(...visibleRanges.map((range) => range.from));
  const visibleTo = Math.max(...visibleRanges.map((range) => range.to));
  embedLifecycle.reconcile(
    collectMarkdownEmbedOccurrencesFromText(text, {
      documentSessionKey: documentSessionKey(),
      rendererIdentityForTarget: fileRendererIdentityForTarget,
    }),
    { visibleFrom, visibleTo },
  );
}

const fileRendererEmbedRegistrations = computed<MarkdownBlockRegistration[]>(() => {
  const renderedPaths = fileRendererEmbedMatches.value;
  if (renderedPaths.size === 0) return [];
  return [
    {
      id: 'file-renderer-markdown-embed',
      priority: 1000,
      syntax: [{ kind: 'embed-reference', pathMatches: (path) => renderedPaths.has(path) }],
      render(match) {
        const path = match.definition.kind === 'external' ? match.definition.path : '';
        const renderer = renderedPaths.get(path);
        const occurrence = renderer
          ? markdownEmbedOccurrenceFromBlockMatch(match, {
              documentSessionKey: documentSessionKey(),
              rendererIdentity: trustedFileRendererIdentity(renderer),
            })
          : null;
        if (!occurrence || !embedLifecycle) {
          const element = document.createElement('section');
          element.className = 'z-file-renderer-markdown-embed';
          element.dataset.fileRendererSurface = 'markdown-embed';
          return element;
        }
        const placeholder = embedLifecycle.renderPlaceholder(occurrence, editor?.view);
        placeholder.classList.add('z-file-renderer-markdown-embed');
        placeholder.dataset.fileRendererSurface = 'markdown-embed';
        return placeholder;
      },
      onActivate(_event, match) {
        if (match.definition.kind !== 'external') return { kind: 'none' };
        return openReferenceBlockAction(match.definition.path, match.definition.fragment);
      },
    },
  ];
});

function openReferenceBlockAction(path: string, fragment: string | undefined): BlockAction {
  return fragment === undefined ? { kind: 'open-reference', path } : { kind: 'open-reference', path, fragment };
}

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
    editorWindowHost.update(context, editorWindowContributions.value);
    return;
  }
  editorWindowHost = renderEditorWindowContributions({
    parent: contributionHost.value,
    context,
    contributions: editorWindowContributions.value,
  });
}

function captureEditorKeydown(event: KeyboardEvent): void {
  if (!contributionHost.value) return;
  routeEditorContainerCapturedKeydown(contributionHost.value, event);
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
    emit('openReference', target);
  }
}

onMounted(() => {
  if (!editorHost.value) return;
  try {
    embedLifecycle = new EditorEmbedLifecycle({
      mount: createTrustedFileRendererEmbedAdapter({
        rendererForTarget: (target) => fileRendererEmbedMatches.value.get(target),
        readText: window.zoridDesktop.readVaultText.bind(window.zoridDesktop),
        readImageResource: window.zoridDesktop.readFileRendererImageResource.bind(window.zoridDesktop),
        onError: (message) => emit('error', message),
      }),
    });
    editor = createMountedMarkdownEditor({
      parent: editorHost.value,
      text: props.text,
      onChange: (text) => {
        emit('change', text);
        renderEditorWindowHost();
      },
      onUpdate: (update) => {
        if (update.docChanged) embedLifecycle?.mapSourceRanges(update.changes);
        reconcileMarkdownEmbeds();
        if (update.docChanged || update.selectionSet) emitCursorChange();
        if (update.selectionSet) renderEditorWindowHost();
      },
      onSave: () => emit('save'),
      onOpenReference: openReference,
      markdownBlockRegistrations: fileRendererEmbedRegistrations.value,
      onError: (error, context) => {
        log({ level: 'error', message: `Markdown editor runtime error: ${context}`, data: error });
      },
    });
    embedLifecycle.setMeasureView(editor.view);
    reconcileMarkdownEmbeds();
    editorHost.value.addEventListener('keydown', captureEditorKeydown, { capture: true });
    removeEditorKeydownCapture = () =>
      editorHost.value?.removeEventListener('keydown', captureEditorKeydown, { capture: true });
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
      reconcileMarkdownEmbeds();
      renderEditorWindowHost();
      emitCursorChange();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      log({ level: 'error', message: 'Markdown editor failed to apply external text.', data: caught });
      emit('error', `Markdown editor failed to update. Debug details were saved. ${message}`);
    }
  },
);

watch(
  [
    () => props.documentPath,
    () => props.fileFields,
    () => props.types,
    () => props.markdownEmbeds,
    () => props.editorContainers,
  ],
  () => {
    reconcileMarkdownEmbeds();
    renderEditorWindowHost();
  },
  {
    deep: true,
  },
);

onBeforeUnmount(() => {
  removeEditorKeydownCapture?.();
  removeEditorKeydownCapture = undefined;
  editorWindowHost?.dispose();
  editorWindowHost = undefined;
  embedLifecycle?.reconcile([], { documentClosed: true });
  embedLifecycle = undefined;
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
