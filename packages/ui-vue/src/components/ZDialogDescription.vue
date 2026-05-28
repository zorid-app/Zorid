<script setup lang="ts">
import { injectDialogRootContext, useId } from 'reka-ui';

withDefaults(defineProps<{ hidden?: boolean }>(), { hidden: false });
const rootContext = injectDialogRootContext();
rootContext.descriptionId ||= useId(undefined, 'reka-dialog-description');
</script>

<template>
  <p :id="rootContext.descriptionId" :class="hidden ? 'z-visually-hidden' : 'z-window-frame__description'">
    <slot />
  </p>
</template>
