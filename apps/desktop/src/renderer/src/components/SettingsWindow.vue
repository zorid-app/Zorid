<script setup lang="ts">
import { ZButton, ZDialogWindow } from '@zorid/ui-vue';
import type { SettingProperty, SettingsSectionDto } from '../types.js';

type JsonRecord = Record<string, unknown>;


const props = defineProps<{
  open: boolean;
  sections: readonly SettingsSectionDto[];
  values: Readonly<Record<string, unknown>>;
}>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  updateProperty: [section: SettingsSectionDto, property: SettingProperty, value: string | boolean];
}>();

function settingsKey(section: SettingsSectionDto): string {
  return `${section.pluginId ?? 'app'}:${section.id}`;
}
function jsonRecord(value: unknown): JsonRecord {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}
function schemaRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function settingProperties(section: SettingsSectionDto): readonly SettingProperty[] {
  const properties = schemaRecord(section.schema).properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.entries(properties as Record<string, Record<string, unknown>>).map(([name, schema]) => ({
    name,
    title: typeof schema.title === 'string' ? schema.title : name,
    type: typeof schema.type === 'string' ? schema.type : 'string',
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    ...(schema.default !== undefined ? { defaultValue: schema.default } : {}),
  }));
}
function settingObject(section: SettingsSectionDto): JsonRecord {
  return jsonRecord(props.values[settingsKey(section)]);
}
function settingDisplayValue(section: SettingsSectionDto, property: SettingProperty): string {
  const value = settingObject(section)[property.name] ?? property.defaultValue;
  if (value === undefined || value === null) return '';
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
}
function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : '';
}
function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false;
}
</script>

<template>
  <ZDialogWindow
    :open="open"
    aria-label="Settings"
    size="lg"
    frameless
    @update:open="emit('update:open', $event)"
  >
    <section class="settings-shell" data-app-settings-window>
      <header class="settings-header">
        <div>
          <p class="eyebrow">Settings</p>
          <h2>App and plugin settings</h2>
        </div>
        <ZButton @click="emit('update:open', false)">Close</ZButton>
      </header>
      <article v-for="section in sections" :key="settingsKey(section)" class="settings-section">
        <header>
          <h3>{{ section.title }}</h3>
          <p class="muted">{{ section.source }}<template v-if="section.pluginId"> · {{ section.pluginId }} · {{ section.pluginStatus }}</template></p>
        </header>
        <div v-if="settingProperties(section).length > 0" class="settings-grid">
          <label v-for="property in settingProperties(section)" :key="property.name" class="setting-field">
            <span>{{ property.title }}</span>
            <input
              v-if="property.type === 'boolean'"
              type="checkbox"
              :checked="Boolean(settingObject(section)[property.name] ?? property.defaultValue)"
              @change="emit('updateProperty', section, property, inputChecked($event))"
            />
            <input
              v-else
              :type="property.type === 'number' || property.type === 'integer' ? 'number' : 'text'"
              :value="settingDisplayValue(section, property)"
              @change="emit('updateProperty', section, property, inputValue($event))"
            />
            <small v-if="property.description">{{ property.description }}</small>
          </label>
        </div>
        <p v-else class="muted">Schema registered; no editable primitive properties yet.</p>
      </article>
    </section>
  </ZDialogWindow>
</template>
