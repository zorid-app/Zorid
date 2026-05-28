<script setup lang="ts">
defineProps<{
  count?: number;
}>();
</script>

<template>
  <button type="button" class="z-tag" data-z-tag>
    <slot />
    <span v-if="count !== undefined" class="z-tag__count">{{ count }}</span>
  </button>
</template>
