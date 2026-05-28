<script setup lang="ts">
import { computed, useId } from 'vue';
import { DialogContent, DialogPortal, DialogRoot } from 'reka-ui';
import ZDialogBackdrop from './ZDialogBackdrop.vue';
import ZDialogDescription from './ZDialogDescription.vue';
import ZDialogTitle from './ZDialogTitle.vue';
import ZWindowFrame from './ZWindowFrame.vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title?: string | undefined;
  description?: string | undefined;
  ariaLabel?: string | undefined;
  modal?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'xl' | undefined;
  centered?: boolean;
  frameless?: boolean;
}>(), {
  modal: true,
  size: 'md',
  centered: false,
  frameless: false,
});

const emit = defineEmits<{ 'update:open': [value: boolean] }>();
const titleId = useId();
const descriptionId = useId();
const fallbackTitle = 'Dialog';
const model = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});
</script>

<template>
  <DialogRoot v-model:open="model" :modal="modal">
    <DialogPortal>
      <ZDialogBackdrop @click="emit('update:open', false)" />
      <DialogContent
        class="z-dialog-window"
        :class="[`z-dialog-window--${size}`, { 'z-dialog-window--centered': centered }]"
        data-z-dialog-window
      >
        <ZDialogTitle :hidden="frameless">{{ title ?? ariaLabel ?? fallbackTitle }}</ZDialogTitle>
        <ZDialogDescription :hidden="frameless || !description">{{ description ?? `${title ?? ariaLabel ?? fallbackTitle} window` }}</ZDialogDescription>
        <slot v-if="frameless" />
        <ZWindowFrame v-else>
          <template v-if="title || description || $slots.actions" #header>
            <div class="z-window-frame__title-group" aria-hidden="true">
              <h2 class="z-window-frame__title">{{ title ?? ariaLabel ?? fallbackTitle }}</h2>
              <p v-if="description" class="z-window-frame__description">{{ description }}</p>
            </div>
            <div v-if="$slots.actions" class="z-window-frame__actions">
              <slot name="actions" />
            </div>
          </template>
          <slot />
        </ZWindowFrame>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
