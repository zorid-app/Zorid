<script setup lang="ts">
import { computed, ref } from 'vue';
import { createDesktopShellState } from '@zorid/desktop-shell';

const shell = createDesktopShellState();
const vaultPath = ref<string>();
const status = computed(() => vaultPath.value ?? 'No vault open');

async function openVault(): Promise<void> {
  vaultPath.value = await window.zoridDesktop.openVault();
}
</script>

<template>
  <main class="zorid-shell" data-zorid-shell>
    <aside class="activity-rail" aria-label="Primary navigation">
      <button v-for="item in shell.activityRail" :key="item" type="button" class="rail-button">
        {{ item.slice(0, 1).toUpperCase() }}
      </button>
    </aside>

    <aside class="sidebar" data-region="left-sidebar">
      <header>
        <p class="eyebrow">Zorid</p>
        <h1>Files</h1>
      </header>
      <button type="button" class="primary" @click="openVault">Open vault</button>
      <p class="muted">{{ status }}</p>
    </aside>

    <section class="editor" data-region="editor">
      <p class="eyebrow">Markdown editor</p>
      <h2>Open a Markdown file</h2>
      <p>This Vue/Vite renderer is ready for hot reload and the next desktop shell slice.</p>
    </section>

    <aside class="sidebar right" data-region="right-sidebar">
      <p class="eyebrow">Outline</p>
      <p class="muted">Document structure will appear here.</p>
    </aside>
  </main>
</template>
