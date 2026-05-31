<script setup lang="ts">
import { ZPanel, ZTag } from '@zorid/ui-vue';

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
      <p class="eyebrow">Outline</p>
      <ol v-if="outline.length > 0" class="outline-list"><li v-for="item in outline" :key="`${item.path}:${item.ordinal}`">{{ item.heading }}</li></ol>
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
