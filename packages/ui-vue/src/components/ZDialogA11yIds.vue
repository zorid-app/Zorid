<script setup lang="ts">
import { injectDialogRootContext, useId } from 'reka-ui';

const rootContext = injectDialogRootContext();
rootContext.titleId ||= useId(undefined, 'reka-dialog-title');
rootContext.descriptionId ||= useId(undefined, 'reka-dialog-description');
</script>

<template></template>
