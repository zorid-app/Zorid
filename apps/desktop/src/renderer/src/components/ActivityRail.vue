<script setup lang="ts">
import { Command, Settings } from '@lucide/vue';
import type { Component } from 'vue';

defineProps<{
  items: readonly string[];
  iconFor: (item: string) => Component;
}>();
const emit = defineEmits<{ openCommandPalette: []; openSettings: [] }>();
</script>

<template>
  <aside class="activity-rail" aria-label="Primary navigation" data-app-activity-rail>
    <button v-for="item in items" :key="item" type="button" class="rail-button" :title="item" :aria-label="item">
      <component :is="iconFor(item)" class="icon" aria-hidden="true" />
    </button>
    <button type="button" class="rail-button" title="Command palette" aria-label="Command palette" @click="emit('openCommandPalette')">
      <Command class="icon" aria-hidden="true" />
    </button>
    <button type="button" class="rail-button" title="Settings" aria-label="Settings" @click="emit('openSettings')">
      <Settings class="icon" aria-hidden="true" />
    </button>
  </aside>
</template>
