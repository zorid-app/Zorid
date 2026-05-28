<script setup lang="ts">
import { Command, Settings } from '@lucide/vue';
import { ZIconButton } from '@zorid/ui-vue';
import type { Component } from 'vue';

defineProps<{
  items: readonly string[];
  iconFor: (item: string) => Component;
}>();
const emit = defineEmits<{ openCommandPalette: []; openSettings: [] }>();
</script>

<template>
  <aside class="activity-rail" aria-label="Primary navigation" data-app-activity-rail>
    <ZIconButton v-for="item in items" :key="item" class="rail-button" :label="item">
      <component :is="iconFor(item)" class="icon" aria-hidden="true" />
    </ZIconButton>
    <ZIconButton class="rail-button" label="Command palette" @click="emit('openCommandPalette')">
      <Command class="icon" aria-hidden="true" />
    </ZIconButton>
    <ZIconButton class="rail-button" label="Settings" @click="emit('openSettings')">
      <Settings class="icon" aria-hidden="true" />
    </ZIconButton>
  </aside>
</template>
