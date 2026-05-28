<script setup lang="ts">
import { ZDialogWindow } from '@zorid/ui-vue';
import { computed } from 'vue';

interface CommandDto {
  readonly id: string;
  readonly title: string;
}

const props = defineProps<{
  open: boolean;
  query: string;
  commands: readonly CommandDto[];
}>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  'update:query': [value: string];
  run: [command: CommandDto];
}>();
const queryModel = computed({
  get: () => props.query,
  set: (value: string) => emit('update:query', value),
});
</script>

<template>
  <ZDialogWindow
    :open="open"
    aria-label="Command palette"
    size="lg"
    frameless
    @update:open="emit('update:open', $event)"
  >
    <section class="command-palette" data-app-command-palette>
      <input v-model="queryModel" class="command-input" autofocus placeholder="Run a command…" @keydown.escape="emit('update:open', false)" />
      <ul class="command-list">
        <li v-for="command in commands" :key="command.id">
          <button type="button" @click="emit('run', command)">
            <span>{{ command.title }}</span>
            <small>{{ command.id }}</small>
          </button>
        </li>
      </ul>
    </section>
  </ZDialogWindow>
</template>
