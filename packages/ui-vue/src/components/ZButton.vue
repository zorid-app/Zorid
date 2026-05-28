<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'default' | 'primary' | 'danger' | 'ghost';
    type?: 'button' | 'submit' | 'reset';
  }>(),
  {
    variant: 'default',
    type: 'button',
  },
);
</script>

<template>
  <button :type="type" class="z-button" :class="`z-button--${variant}`">
    <slot />
  </button>
</template>
