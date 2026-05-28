<script setup lang="ts">
defineProps<{
  title?: string | undefined;
  description?: string | undefined;
}>();
</script>

<template>
  <section class="z-panel" data-z-panel>
    <header v-if="title || description || $slots.actions || $slots.header" class="z-panel__header">
      <slot name="header">
        <div>
          <h3 v-if="title" class="z-panel__title">{{ title }}</h3>
          <p v-if="description" class="z-panel__description">{{ description }}</p>
        </div>
        <div v-if="$slots.actions">
          <slot name="actions" />
        </div>
      </slot>
    </header>
    <slot />
  </section>
</template>
