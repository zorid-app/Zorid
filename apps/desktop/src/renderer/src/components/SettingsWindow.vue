<script setup lang="ts">
import { ZDialogWindow } from '@zorid/ui-vue';
import { computed, ref, watch } from 'vue';
import type { SettingProperty, SettingsSectionDto } from '../types.js';

type JsonRecord = Record<string, unknown>;

interface SettingsNavEntry {
  readonly key: string;
  readonly section: SettingsSectionDto;
  readonly title: string;
  readonly subtitle: string;
  readonly icon: string;
}

interface SettingsNavGroup {
  readonly title: string;
  readonly entries: readonly SettingsNavEntry[];
}

const props = defineProps<{
  open: boolean;
  sections: readonly SettingsSectionDto[];
  values: Readonly<Record<string, unknown>>;
}>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  updateProperty: [section: SettingsSectionDto, property: SettingProperty, value: string | boolean];
}>();

const activeSettingsKey = ref<string | undefined>();

function navKey(section: SettingsSectionDto | undefined): string {
  return section ? `settings-section:${section.source}:${section.pluginId ?? 'app'}:${section.id}` : '';
}
function settingsValueKey(section: SettingsSectionDto): string {
  return `${section.pluginId ?? 'app'}:${section.id}`;
}
function jsonRecord(value: unknown): JsonRecord {
  return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
function schemaRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
  return jsonRecord(props.values[settingsValueKey(section)]);
}
function settingDisplayValue(section: SettingsSectionDto, property: SettingProperty): string {
  const value = settingObject(section)[property.name] ?? property.defaultValue;
  if (value === undefined || value === null) return '';
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value);
}
function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : '';
}
function inputChecked(event: Event): boolean {
  return event.target instanceof HTMLInputElement ? event.target.checked : false;
}
function sourceLabel(section: SettingsSectionDto): string {
  if (section.source === 'app') return 'App setting';
  if (section.pluginId)
    return section.pluginStatus ? `${section.pluginId} · ${section.pluginStatus}` : section.pluginId;
  return section.source === 'plugin-runtime' ? 'Runtime plugin setting' : 'Plugin manifest setting';
}
function navGroupTitle(section: SettingsSectionDto): string {
  return section.source === 'app' ? 'Options' : 'Plugin settings';
}
function navIcon(section: SettingsSectionDto): string {
  if (section.source === 'app') return '⚙';
  if (section.source === 'plugin-runtime') return '◈';
  return '◇';
}
function propertyControlType(property: SettingProperty): 'number' | 'text' {
  return property.type === 'number' || property.type === 'integer' ? 'number' : 'text';
}
function propertySubtitle(property: SettingProperty): string {
  if (property.description) return property.description;
  if (property.defaultValue !== undefined) return `Default: ${String(property.defaultValue)}`;
  return property.type;
}

const navEntries = computed<readonly SettingsNavEntry[]>(() =>
  props.sections.map((section) => ({
    key: navKey(section),
    section,
    title: section.title,
    subtitle: sourceLabel(section),
    icon: navIcon(section),
  })),
);

const navGroups = computed<readonly SettingsNavGroup[]>(() => {
  const groups = new Map<string, SettingsNavEntry[]>();
  for (const entry of navEntries.value) {
    const title = navGroupTitle(entry.section);
    const entries = groups.get(title) ?? [];
    entries.push(entry);
    groups.set(title, entries);
  }
  return [...groups.entries()].map(([title, entries]) => ({ title, entries }));
});

const selectedSection = computed<SettingsSectionDto | undefined>(() => {
  const active = activeSettingsKey.value;
  return props.sections.find((section) => navKey(section) === active) ?? props.sections[0];
});

const selectedSectionProperties = computed<readonly SettingProperty[]>(() =>
  selectedSection.value ? settingProperties(selectedSection.value) : [],
);

watch(
  navEntries,
  (entries) => {
    if (entries.length === 0) {
      activeSettingsKey.value = undefined;
      return;
    }
    if (!entries.some((entry) => entry.key === activeSettingsKey.value)) activeSettingsKey.value = entries[0]?.key;
  },
  { immediate: true },
);
</script>

<template>
  <ZDialogWindow
    :open="open"
    aria-label="Settings"
    size="xl"
    frameless
    @update:open="emit('update:open', $event)"
  >
    <section class="settings-shell" data-app-settings-window>
      <div class="settings-layout">
        <nav class="settings-nav" aria-label="Settings navigation">
          <section v-for="group in navGroups" :key="group.title" class="settings-nav-group">
            <h3>{{ group.title }}</h3>
            <button
              v-for="entry in group.entries"
              :key="entry.key"
              type="button"
              class="settings-nav-entry"
              :class="{ 'settings-nav-entry--active': navKey(selectedSection) === entry.key }"
              :aria-current="navKey(selectedSection) === entry.key ? 'page' : undefined"
              @click="activeSettingsKey = entry.key"
            >
              <span class="settings-nav-icon" aria-hidden="true">{{ entry.icon }}</span>
              <span class="settings-nav-text">
                <span>{{ entry.title }}</span>
                <small>{{ entry.subtitle }}</small>
              </span>
            </button>
          </section>
        </nav>

        <main class="settings-content" aria-live="polite">
          <article v-if="selectedSection" :key="navKey(selectedSection)" class="settings-section settings-section--selected">
            <header class="settings-section-header">
              <div>
                <p class="eyebrow">{{ navGroupTitle(selectedSection) }}</p>
                <h3>{{ selectedSection.title }}</h3>
                <p class="muted">{{ sourceLabel(selectedSection) }}</p>
              </div>
            </header>

            <div v-if="selectedSectionProperties.length > 0" class="settings-item-list">
              <label v-for="property in selectedSectionProperties" :key="property.name" class="setting-item">
                <span class="setting-item-copy">
                  <span class="setting-item-title">{{ property.title }}</span>
                  <small>{{ propertySubtitle(property) }}</small>
                </span>
                <span class="setting-item-control">
                  <input
                    v-if="property.type === 'boolean'"
                    type="checkbox"
                    :checked="Boolean(settingObject(selectedSection)[property.name] ?? property.defaultValue)"
                    @change="emit('updateProperty', selectedSection, property, inputChecked($event))"
                  />
                  <input
                    v-else
                    :type="propertyControlType(property)"
                    :value="settingDisplayValue(selectedSection, property)"
                    @change="emit('updateProperty', selectedSection, property, inputValue($event))"
                  />
                </span>
              </label>
            </div>
            <p v-else class="muted">Schema registered; no editable primitive properties yet.</p>
          </article>

          <p v-else class="muted">No settings sections registered yet.</p>
        </main>
      </div>
    </section>
  </ZDialogWindow>
</template>
