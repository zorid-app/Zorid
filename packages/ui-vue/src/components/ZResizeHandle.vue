<script setup lang="ts">
withDefaults(defineProps<{
  active?: boolean;
  label?: string | undefined;
}>(), {
  active: false,
  label: 'Resize panel',
});
</script>

<template>
  <div
    class="z-resize-handle"
    :class="{ 'z-resize-handle--active': active, active }"
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="label"
    data-z-resize-handle
  />
</template>
