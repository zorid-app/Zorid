<script setup lang="ts">
import { computed, useId } from 'vue';

const props = defineProps<{
  modelValue: boolean;
  label: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const inputId = useId();
const model = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});
</script>

<template>
  <label class="z-checkbox-field" :for="inputId">
    <input :id="inputId" v-model="model" type="checkbox" />
    <span>{{ label }}</span>
  </label>
</template>
