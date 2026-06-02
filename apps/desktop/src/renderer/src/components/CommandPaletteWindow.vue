<script setup lang="ts">
import { ZDialogWindow } from '@zorid/ui-vue';
import { computed, nextTick, ref, watch } from 'vue';

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
const inputEl = ref<HTMLInputElement>();
const activeCommandIndex = ref(0);
const activeCommandId = computed(() => {
  const command = props.commands[activeCommandIndex.value];
  return command ? `command-palette-option-${command.id}` : undefined;
});

function focusInput(): void {
  nextTick(() => {
    inputEl.value?.focus();
  });
}

function clampActiveCommandIndex(): void {
  if (props.commands.length === 0) {
    activeCommandIndex.value = 0;
    return;
  }
  if (activeCommandIndex.value >= props.commands.length) activeCommandIndex.value = props.commands.length - 1;
}

function selectCommand(offset: number): void {
  if (props.commands.length === 0) return;
  activeCommandIndex.value = (activeCommandIndex.value + offset + props.commands.length) % props.commands.length;
}

function runActiveCommand(): void {
  const command = props.commands[activeCommandIndex.value];
  if (!command) return;
  emit('run', command);
}

function handleInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('update:open', false);
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectCommand(1);
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectCommand(-1);
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    runActiveCommand();
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    activeCommandIndex.value = 0;
    focusInput();
  },
  { immediate: true },
);

watch(
  () => props.query,
  () => {
    activeCommandIndex.value = 0;
  },
);

watch(
  () => props.commands,
  () => {
    clampActiveCommandIndex();
  },
);
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
      <input
        ref="inputEl"
        v-model="queryModel"
        class="command-input"
        placeholder="Run a command…"
        role="combobox"
        aria-controls="command-palette-list"
        :aria-expanded="open"
        :aria-activedescendant="activeCommandId"
        @keydown="handleInputKeydown"
      />
      <ul id="command-palette-list" class="command-list" role="listbox">
        <li
          v-for="(command, index) in commands"
          :id="`command-palette-option-${command.id}`"
          :key="command.id"
          role="option"
          :aria-selected="activeCommandIndex === index"
        >
          <button
            type="button"
            :class="{ active: activeCommandIndex === index }"
            @mouseenter="activeCommandIndex = index"
            @focus="activeCommandIndex = index"
            @click="emit('run', command)"
          >
            <span>{{ command.title }}</span>
            <small>{{ command.id }}</small>
          </button>
        </li>
      </ul>
    </section>
  </ZDialogWindow>
</template>
