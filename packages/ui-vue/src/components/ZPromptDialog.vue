<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import ZButton from './ZButton.vue';
import ZDialogWindow from './ZDialogWindow.vue';
import ZTextField from './ZTextField.vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    description?: string | undefined;
    label?: string | undefined;
    modelValue?: string;
    placeholder?: string | undefined;
    submitLabel?: string;
    cancelLabel?: string;
  }>(),
  {
    label: 'Value',
    modelValue: '',
    submitLabel: 'Submit',
    cancelLabel: 'Cancel',
  },
);

const emit = defineEmits<{
  'update:open': [value: boolean];
  'update:modelValue': [value: string];
  submit: [value: string];
  cancel: [];
}>();

const draft = ref(props.modelValue);
const model = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) draft.value = props.modelValue;
  },
);
watch(
  () => props.modelValue,
  (value) => {
    if (!props.open) draft.value = value;
  },
);

function submit(): void {
  emit('update:modelValue', draft.value);
  emit('submit', draft.value);
  emit('update:open', false);
}

function cancel(): void {
  emit('cancel');
  emit('update:open', false);
}
</script>

<template>
  <ZDialogWindow v-model:open="model" :title="title" :description="description" size="sm" centered data-z-prompt-dialog>
    <form @submit.prevent="submit">
      <ZTextField v-model="draft" :label="label" :placeholder="placeholder" autofocus />
      <footer class="z-dialog-footer">
        <ZButton type="button" @click="cancel">{{ cancelLabel }}</ZButton>
        <ZButton type="submit" variant="primary">{{ submitLabel }}</ZButton>
      </footer>
    </form>
  </ZDialogWindow>
</template>
