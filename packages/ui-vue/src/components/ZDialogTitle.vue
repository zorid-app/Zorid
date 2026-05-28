<script setup lang="ts">
import { injectDialogRootContext, useId } from 'reka-ui';

withDefaults(defineProps<{ hidden?: boolean }>(), { hidden: false });
const rootContext = injectDialogRootContext();
rootContext.titleId ||= useId(undefined, 'reka-dialog-title');
</script>

<template>
  <h2 :id="rootContext.titleId" :class="hidden ? 'z-visually-hidden' : 'z-window-frame__title'">
    <slot />
  </h2>
</template>
