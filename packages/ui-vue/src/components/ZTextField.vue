<script setup lang="ts">
import { computed, useId } from 'vue';

const props = withDefaults(defineProps<{
  modelValue: string;
  label?: string | undefined;
  description?: string | undefined;
  hint?: string | undefined;
  placeholder?: string | undefined;
  type?: 'text' | 'search' | 'number' | 'password' | 'email' | 'url' | undefined;
  autofocus?: boolean;
}>(), {
  type: 'text',
  autofocus: false,
});

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const inputId = useId();
const descriptionId = useId();
const model = computed({
  get: () => props.modelValue,
  set: (value: string) => emit('update:modelValue', value),
});
</script>

<template>
  <label class="z-field" :for="inputId">
    <span v-if="label || hint" class="z-field__label-row">
      <span v-if="label" class="z-field__label">{{ label }}</span>
      <span v-if="hint" class="z-field__hint">{{ hint }}</span>
    </span>
    <input
      :id="inputId"
      v-model="model"
      class="z-input"
      :type="type"
      :placeholder="placeholder"
      :autofocus="autofocus"
      :aria-describedby="description ? descriptionId : undefined"
    />
    <span v-if="description" :id="descriptionId" class="z-field__description">{{ description }}</span>
  </label>
</template>
