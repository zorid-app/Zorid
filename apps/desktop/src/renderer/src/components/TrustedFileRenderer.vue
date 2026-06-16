<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { mountTrustedFileRenderer, type TrustedFileRendererHost } from '../trusted-file-renderers.js';
import type { FileRendererMatchDto } from '../types.js';

const props = defineProps<{
  readonly match: FileRendererMatchDto;
  readonly fragment?: string | undefined;
}>();
const emit = defineEmits<{ error: [message: string] }>();

const hostElement = ref<HTMLElement>();
let host: TrustedFileRendererHost | undefined;

function render(): void {
  host?.dispose();
  host = undefined;
  if (!hostElement.value) return;
  host = mountTrustedFileRenderer({
    container: hostElement.value,
    match: props.match,
    ...(props.fragment ? { fragment: props.fragment } : {}),
    readText: window.zoridDesktop.readVaultText.bind(window.zoridDesktop),
    readImageResource: window.zoridDesktop.readFileRendererImageResource.bind(window.zoridDesktop),
    onError: (message) => emit('error', message),
  });
}

watch(() => [hostElement.value, props.match, props.fragment] as const, render, { immediate: true });

onBeforeUnmount(() => {
  host?.dispose();
  host = undefined;
});
</script>

<template>
  <section ref="hostElement" class="trusted-file-renderer" aria-label="File renderer" />
</template>
