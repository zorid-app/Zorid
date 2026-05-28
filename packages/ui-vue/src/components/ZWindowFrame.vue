<script setup lang="ts">
defineProps<{
  title?: string | undefined;
  description?: string | undefined;
  titleId?: string | undefined;
  descriptionId?: string | undefined;
}>();
</script>

<template>
  <section class="z-window-frame" data-z-window-frame>
    <header v-if="title || description || $slots.actions || $slots.header" class="z-window-frame__header">
      <slot name="header">
        <div class="z-window-frame__title-group">
          <h2 v-if="title" :id="titleId" class="z-window-frame__title">{{ title }}</h2>
          <p v-if="description" :id="descriptionId" class="z-window-frame__description">{{ description }}</p>
        </div>
        <div v-if="$slots.actions" class="z-window-frame__actions">
          <slot name="actions" />
        </div>
      </slot>
    </header>
    <div class="z-window-frame__body">
      <slot />
    </div>
  </section>
</template>
