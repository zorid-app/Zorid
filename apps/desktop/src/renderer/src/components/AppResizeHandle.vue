<script setup lang="ts">
import { ZResizeHandle } from '@zorid/ui-vue';

withDefaults(defineProps<{
  side: 'left' | 'right';
  active?: boolean;
  label: string;
}>(), {
  active: false,
});
const emit = defineEmits<{ resizeStart: [event: PointerEvent] }>();
</script>

<template>
  <ZResizeHandle
    class="resize-handle"
    :class="[side, { active }]"
    :active="active"
    :label="label"
    @pointerdown="emit('resizeStart', $event)"
  />
</template>
