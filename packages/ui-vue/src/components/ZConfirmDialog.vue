<script setup lang="ts">
import { computed, useId } from 'vue';
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from 'reka-ui';
import ZButton from './ZButton.vue';
import ZWindowFrame from './ZWindowFrame.vue';

const props = withDefaults(defineProps<{
  open: boolean;
  title: string;
  description?: string | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
  destructive?: boolean;
}>(), {
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  destructive: false,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
  confirm: [];
  cancel: [];
}>();
const titleId = useId();
const descriptionId = useId();
const model = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});
</script>

<template>
  <AlertDialogRoot v-model:open="model">
    <AlertDialogPortal>
      <AlertDialogOverlay class="z-dialog-backdrop" data-z-dialog-backdrop />
      <AlertDialogContent
        class="z-dialog-window z-dialog-window--sm z-dialog-window--centered"
        :aria-labelledby="titleId"
        :aria-describedby="description ? descriptionId : undefined"
        data-z-confirm-dialog
      >
        <ZWindowFrame>
          <template #header>
            <div class="z-window-frame__title-group">
              <AlertDialogTitle :id="titleId" class="z-window-frame__title">{{ title }}</AlertDialogTitle>
              <AlertDialogDescription v-if="description" :id="descriptionId" class="z-window-frame__description">{{ description }}</AlertDialogDescription>
            </div>
          </template>
          <slot />
          <footer class="z-dialog-footer">
            <AlertDialogCancel as-child @click="emit('cancel')">
              <ZButton>{{ cancelLabel }}</ZButton>
            </AlertDialogCancel>
            <AlertDialogAction as-child @click="emit('confirm')">
              <ZButton :variant="destructive ? 'danger' : 'primary'">{{ confirmLabel }}</ZButton>
            </AlertDialogAction>
          </footer>
        </ZWindowFrame>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
