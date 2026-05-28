<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    title?: string;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
  }>(),
  {
    type: 'button',
    disabled: false,
  },
);
</script>

<template>
  <button :type="type" class="z-icon-button" :aria-label="label" :title="title ?? label" :disabled="disabled" data-z-icon-button>
    <slot />
  </button>
</template>
