<script setup lang="ts">
import { ZPanel, ZTag } from '@zorid/ui-vue';
import { computed, ref, watch } from 'vue';

import type { OutlineTreeItem } from '../outline-tree.js';
import type {
  BacklinkDto,
  BaseDto,
  DataViewResultDto,
  FieldDto,
  FileFieldsDto,
  IndexStatusDto,
  MarkdownEmbedDto,
  OutlineItemDto,
  PluginStatus,
  SettingsSectionDto,
  TagDto,
  TypeDto,
} from '../types.js';

const props = defineProps<{
  outline: readonly OutlineItemDto[];
  outlineTree: readonly OutlineTreeItem[];
  currentOutlineId?: string | undefined;
  backlinks: readonly BacklinkDto[];
  tags: readonly TagDto[];
  selectedPath?: string | undefined;
  fileFields?: FileFieldsDto | undefined;
  types: readonly TypeDto[];
  bases: readonly BaseDto[];
  activeBasePath?: string | undefined;
  activeViewId?: string | undefined;
  dataView?: DataViewResultDto | undefined;
  markdownEmbeds: readonly MarkdownEmbedDto[];
  indexStatus: IndexStatusDto;
  activePlugins: number;
  plugins: readonly PluginStatus[];
  settingsSections: readonly SettingsSectionDto[];
}>();
const emit = defineEmits<{
  openSearchResult: [path: string];
  searchTag: [tag: string];
  updateActiveType: [event: Event];
  updateActiveField: [field: FieldDto, value: string | boolean];
  selectBase: [event: Event];
  selectView: [event: Event];
  selectEmbed: [embed: MarkdownEmbedDto];
  refreshShellData: [];
  openSettings: [];
}>();

const activeBase = () => props.bases.find((base) => base.path === props.activeBasePath);
const collapsedOutlineIds = ref<ReadonlySet<string>>(new Set());
const outlineBranchIds = computed(() => collectBranchIds(props.outlineTree));
const allOutlineBranchesCollapsed = computed(
  () => outlineBranchIds.value.length > 0 && outlineBranchIds.value.every((id) => collapsedOutlineIds.value.has(id)),
);
const visibleOutlineItems = computed(() => flattenVisibleOutlineItems(props.outlineTree, collapsedOutlineIds.value));

function collectBranchIds(items: readonly OutlineTreeItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) {
    if (item.children.length > 0) ids.push(item.id);
    ids.push(...collectBranchIds(item.children));
  }
  return ids;
}

function flattenVisibleOutlineItems(
  items: readonly OutlineTreeItem[],
  collapsedIds: ReadonlySet<string>,
  depth = 0,
): Array<{ readonly item: OutlineTreeItem; readonly depth: number }> {
  const visible: Array<{ readonly item: OutlineTreeItem; readonly depth: number }> = [];
  for (const item of items) {
    visible.push({ item, depth });
    if (item.children.length > 0 && !collapsedIds.has(item.id)) {
      visible.push(...flattenVisibleOutlineItems(item.children, collapsedIds, depth + 1));
    }
  }
  return visible;
}

function toggleOutlineItem(item: OutlineTreeItem): void {
  if (item.children.length === 0) return;
  const next = new Set(collapsedOutlineIds.value);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  collapsedOutlineIds.value = next;
}

function toggleAllOutlineBranches(): void {
  collapsedOutlineIds.value = allOutlineBranchesCollapsed.value ? new Set() : new Set(outlineBranchIds.value);
}

watch(
  outlineBranchIds,
  (ids) => {
    const valid = new Set(ids);
    const next = new Set([...collapsedOutlineIds.value].filter((id) => valid.has(id)));
    if (next.size !== collapsedOutlineIds.value.size) collapsedOutlineIds.value = next;
  },
  { immediate: true },
);

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : '';
}
function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false;
}
function fieldInputValue(field: FieldDto): string {
  if (field.value === undefined || field.value === null) return '';
  if (Array.isArray(field.value)) return field.value.join(', ');
  return String(field.value);
}
</script>

<template>
  <aside v-show="true" class="sidebar right" data-region="right-sidebar" data-app-right-sidebar>
    <ZPanel class="panel">
      <div class="panel-header outline-panel-header">
        <p class="eyebrow">Outline</p>
        <button
          type="button"
          class="outline-toggle-all"
          :disabled="outlineBranchIds.length === 0"
          :aria-pressed="allOutlineBranchesCollapsed"
          :aria-label="allOutlineBranchesCollapsed ? 'Expand all outline headings' : 'Collapse all outline headings'"
          @click="toggleAllOutlineBranches"
        >
          {{ allOutlineBranchesCollapsed ? 'Expand' : 'Collapse' }}
        </button>
      </div>
      <ol v-if="outlineTree.length > 0" class="outline-list outline-tree" aria-label="Document outline">
        <li
          v-for="{ item, depth } in visibleOutlineItems"
          :key="item.id"
          class="outline-tree-item"
          :class="{ current: item.id === currentOutlineId }"
          :style="{ '--outline-depth': depth }"
          :aria-current="item.id === currentOutlineId ? 'location' : undefined"
        >
          <button
            v-if="item.children.length > 0"
            type="button"
            class="outline-row-chevron"
            :aria-expanded="!collapsedOutlineIds.has(item.id)"
            :aria-label="collapsedOutlineIds.has(item.id) ? `Expand ${item.heading}` : `Collapse ${item.heading}`"
            @click="toggleOutlineItem(item)"
          >
            {{ collapsedOutlineIds.has(item.id) ? '›' : '⌄' }}
          </button>
          <span v-else class="outline-row-chevron outline-row-chevron-spacer" aria-hidden="true"></span>
          <span class="outline-row-text">{{ item.heading }}</span>
        </li>
      </ol>
      <p v-else class="muted">No indexed headings for this file.</p>
    </ZPanel>
    <ZPanel class="panel">
      <p class="eyebrow">Backlinks</p>
      <ul v-if="backlinks.length > 0" class="result-list"><li v-for="link in backlinks" :key="link.fromPath"><button type="button" @click="emit('openSearchResult', link.fromPath)"><strong>{{ link.fromPath }}</strong><span>{{ link.excerpt }}</span></button></li></ul>
      <p v-else class="muted">No backlinks found.</p>
    </ZPanel>
    <ZPanel class="panel">
      <p class="eyebrow">Tags</p>
      <div v-if="tags.length > 0" class="tag-cloud"><ZTag v-for="tag in tags" :key="tag.tag" :count="tag.count" @click="emit('searchTag', tag.tag)">#{{ tag.tag }}</ZTag></div>
      <p v-else class="muted">No tags indexed.</p>
    </ZPanel>
    <ZPanel class="panel">
      <p class="eyebrow">Fields</p>
      <template v-if="selectedPath && fileFields">
        <label class="setting-field"><span>Type</span><select :value="fileFields.typeName ?? ''" @change="emit('updateActiveType', $event)"><option value="">None</option><option v-for="type in types" :key="type.path" :value="type.name">{{ type.name }}</option></select></label>
        <div v-if="fileFields.diagnostics.length > 0" class="diagnostics"><p v-for="diagnostic in fileFields.diagnostics" :key="`${diagnostic.key}:${diagnostic.message}`">{{ diagnostic.key }}: {{ diagnostic.message }}</p></div>
        <div class="fields-grid"><label v-for="field in fileFields.fields" :key="field.key" class="setting-field"><span>{{ field.key }} <small v-if="field.required">required</small></span><input v-if="field.type === 'boolean'" type="checkbox" :checked="Boolean(field.value)" @change="emit('updateActiveField', field, inputChecked($event))" /><input v-else :type="field.type === 'int' || field.type === 'float' ? 'number' : 'text'" :value="fieldInputValue(field)" @change="emit('updateActiveField', field, inputValue($event))" /></label></div>
      </template>
      <p v-else class="muted">Select an indexed Markdown file to edit fields.</p>
    </ZPanel>
    <ZPanel class="panel">
      <p class="eyebrow">Types</p>
      <ul v-if="types.length > 0" class="type-list"><li v-for="type in types" :key="type.path"><strong>{{ type.name }}</strong><small>{{ type.fields.length }} fields</small><p v-for="diagnostic in type.diagnostics" :key="diagnostic" class="error">{{ diagnostic }}</p></li></ul>
      <p v-else class="muted">No .ztype schemas found in .zorid/types.</p>
    </ZPanel>
    <ZPanel class="panel">
      <p class="eyebrow">Bases</p>
      <template v-if="bases.length > 0">
        <label class="setting-field"><span>.zbase</span><select :value="activeBasePath ?? ''" @change="emit('selectBase', $event)"><option v-for="base in bases" :key="base.path" :value="base.path">{{ base.name }}</option></select></label>
        <label v-if="activeBase()" class="setting-field"><span>View</span><select :value="activeViewId ?? ''" @change="emit('selectView', $event)"><option v-for="view in activeBase()?.views" :key="view.id" :value="view.id">{{ view.id }} · {{ view.renderer }}</option></select></label>
        <div v-if="dataView" class="data-view" :data-renderer="dataView.renderer"><p class="muted">{{ dataView.renderer }} · {{ dataView.rows.length }} rows</p><table v-if="dataView.renderer === 'table'"><thead><tr><th v-for="column in dataView.columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="row in dataView.rows" :key="row.path"><td v-for="column in dataView.columns" :key="column">{{ column === 'path' ? row.path : row.fields[column] }}</td></tr></tbody></table><ul v-else class="result-list"><li v-for="row in dataView.rows" :key="row.path"><button type="button" @click="emit('openSearchResult', row.path)">{{ row.path }}</button></li></ul><div v-if="dataView.groups.length > 0" class="group-list"><p v-for="group in dataView.groups" :key="group.key">{{ group.key }} · {{ group.rows.length }}</p></div></div>
      </template>
      <p v-else class="muted">No .zbase files found.</p>
    </ZPanel>
    <ZPanel class="panel">
      <p class="eyebrow">Markdown embeds</p>
      <div v-if="markdownEmbeds.length > 0" class="embed-list"><button v-for="embed in markdownEmbeds" :key="`${embed.basePath}:${embed.viewId ?? ''}`" type="button" @click="emit('selectEmbed', embed)">{{ embed.basePath }}<template v-if="embed.viewId">#{{ embed.viewId }}</template></button></div>
      <p v-else class="muted">No ![[*.zbase]] embeds in this file.</p>
    </ZPanel>
    <ZPanel class="panel"><p class="eyebrow">Status</p><p class="muted">Index: {{ indexStatus.state }} · {{ indexStatus.fileCount }} files</p><p class="muted">Plugins: {{ activePlugins }} active / {{ plugins.length }} registered</p></ZPanel>
    <ZPanel class="panel"><div class="panel-header"><p class="eyebrow">Plugins</p><button type="button" @click="emit('refreshShellData')">Refresh</button></div><ul class="plugin-list" aria-label="Plugin statuses"><li v-for="plugin in plugins" :key="plugin.pluginId"><span>{{ plugin.pluginId.replace('zorid.core.', '') }}</span><strong>{{ plugin.status }}</strong></li></ul></ZPanel>
    <ZPanel class="panel"><div class="panel-header"><p class="eyebrow">Settings</p><button type="button" @click="emit('openSettings')">Open</button></div><p class="muted">{{ settingsSections.length }} schema sections discovered without activating placeholders.</p></ZPanel>
  </aside>
</template>
