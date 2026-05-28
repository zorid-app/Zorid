<script setup lang="ts">
import ZDialogWindow from './ZDialogWindow.vue';

defineProps<{
  open: boolean;
  title?: string | undefined;
  description?: string | undefined;
  ariaLabel?: string | undefined;
  size?: 'sm' | 'md' | 'lg' | 'xl' | undefined;
  centered?: boolean;
}>();

defineEmits<{ 'update:open': [value: boolean] }>();
</script>

<template>
  <ZDialogWindow
    :open="open"
    :title="title"
    :description="description"
    :aria-label="ariaLabel"
    :size="size"
    :centered="centered"
    modal
    @update:open="$emit('update:open', $event)"
  >
    <template v-if="$slots.actions" #actions>
      <slot name="actions" />
    </template>
    <slot />
  </ZDialogWindow>
</template>
