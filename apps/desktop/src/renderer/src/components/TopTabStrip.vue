<script setup lang="ts">
import {
  Bookmark,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Search,
  X,
} from '@lucide/vue';
import { ZIconButton } from '@zorid/ui-vue';
import { nextTick, reactive } from 'vue';
import type { TopTabItem } from './top-tab-model.js';

const props = defineProps<{
  openTabs: readonly TopTabItem[];
  selectedTabId?: string | undefined;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}>();
const emit = defineEmits<{
  activate: [tabId: string];
  close: [tabId: string];
  newTab: [];
  toggleLeftPane: [];
  toggleRightPane: [];
}>();

const tabLabelEls = new Map<string, HTMLSpanElement>();
const truncatedTabIds = reactive<Record<string, boolean>>({});

function setTabLabelRef(tabId: string, element: Element | null | unknown): void {
  if (element instanceof HTMLSpanElement) tabLabelEls.set(tabId, element);
  else tabLabelEls.delete(tabId);
}

async function updateTabOverflow(tabId: string): Promise<void> {
  await nextTick();
  const element = tabLabelEls.get(tabId);
  truncatedTabIds[tabId] = element ? element.scrollWidth > element.clientWidth : false;
}
</script>

<template>
  <header class="editor-titlebar" aria-label="Editor title bar" data-app-titlebar>
    <div class="traffic-light-spacer" aria-hidden="true"></div>

    <div class="titlebar-left-actions" aria-label="Primary navigation controls">
      <template v-if="!leftCollapsed">
        <ZIconButton class="titlebar-action" label="Files">
          <FolderOpen class="titlebar-action-icon" aria-hidden="true" />
        </ZIconButton>
        <ZIconButton class="titlebar-action" label="Search">
          <Search class="titlebar-action-icon" aria-hidden="true" />
        </ZIconButton>
        <ZIconButton class="titlebar-action" label="Bookmarks">
          <Bookmark class="titlebar-action-icon" aria-hidden="true" />
        </ZIconButton>
      </template>
      <ZIconButton
        class="titlebar-action"
        :label="leftCollapsed ? 'Show file tree pane' : 'Hide file tree pane'"
        @click="emit('toggleLeftPane')"
      >
        <component
          :is="leftCollapsed ? PanelLeftOpen : PanelLeftClose"
          class="titlebar-action-icon"
          aria-hidden="true"
        />
      </ZIconButton>
    </div>

    <nav class="top-tab-strip" aria-label="Open Markdown files">
      <div
        v-for="tab in props.openTabs"
        :key="tab.id"
        class="top-tab"
        :class="{ selected: selectedTabId === tab.id, 'top-tab-placeholder': tab.kind === 'placeholder' }"
        :title="truncatedTabIds[tab.id] ? tab.title : undefined"
        @mouseenter="updateTabOverflow(tab.id)"
      >
        <button type="button" class="top-tab-activate" @click="emit('activate', tab.id)" @focus="updateTabOverflow(tab.id)">
          <span :ref="(element) => setTabLabelRef(tab.id, element)" class="top-tab-label">{{ tab.title }}</span>
        </button>
        <ZIconButton class="top-tab-close" :label="`Close ${tab.title}`" @click="emit('close', tab.id)">
          <X class="top-tab-close-icon" aria-hidden="true" />
        </ZIconButton>
      </div>
      <ZIconButton class="tab-add-button" label="New tab" @click="emit('newTab')">
        <Plus class="titlebar-action-icon" aria-hidden="true" />
      </ZIconButton>
    </nav>

    <div class="titlebar-right-actions" aria-label="Pane controls">
      <ZIconButton class="titlebar-action" :label="rightCollapsed ? 'Show right pane' : 'Hide right pane'" @click="emit('toggleRightPane')">
        <component :is="rightCollapsed ? PanelRightOpen : PanelRightClose" class="titlebar-action-icon" aria-hidden="true" />
      </ZIconButton>
    </div>
  </header>
</template>
