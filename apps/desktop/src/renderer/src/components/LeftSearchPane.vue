<script setup lang="ts">
import { Search, SlidersHorizontal, Type } from '@lucide/vue';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { SearchCandidateDto, SearchResultDto } from '../types.js';

const props = defineProps<{
  searchQuery: string;
  searchResults: readonly SearchResultDto[];
  searchCandidates: readonly SearchCandidateDto[];
}>();

const emit = defineEmits<{
  'update:searchQuery': [value: string];
  runSearch: [];
  openSearchResult: [path: string];
}>();

function inputValue(event: Event): string {
  return event.target instanceof HTMLInputElement ? event.target.value : '';
}

interface SearchOperatorOption {
  readonly label: string;
  readonly token: string;
  readonly description: string;
}

const operatorOptions: readonly SearchOperatorOption[] = [
  { label: 'path', token: 'path:', description: 'match path of the file' },
  { label: 'file', token: 'file:', description: 'match file name' },
  { label: 'tag', token: 'tag:', description: 'search for tags' },
  { label: 'line', token: 'line:', description: 'search keywords on same line' },
  { label: 'section', token: 'section:', description: 'search keywords under same heading' },
  { label: '[property]', token: '[', description: 'match property' },
];

const inputEl = ref<HTMLInputElement>();
const menuOpen = ref(false);
const activeOptionIndex = ref(0);
const activeCandidateIndex = ref(0);
const menuCandidates = computed(() => props.searchCandidates);
const showingCandidateMenu = computed(() => menuOpen.value && menuCandidates.value.length > 0);

function focusSearchInput(): void {
  nextTick(() => {
    inputEl.value?.focus();
    menuOpen.value = true;
    activeOptionIndex.value = 0;
  });
}

function closeMenu(): void {
  menuOpen.value = false;
}

function appendOperatorToken(query: string, token: string): string {
  const trimmed = query.trim();
  if (!trimmed) return token;
  return query.endsWith(' ') ? `${query}${token}` : `${query} ${token}`;
}

function selectOperator(option: SearchOperatorOption): void {
  const nextQuery = appendOperatorToken(props.searchQuery, option.token);
  emit('update:searchQuery', nextQuery);
  emit('runSearch');
  nextTick(() => {
    inputEl.value?.focus();
    const cursor = nextQuery.length;
    inputEl.value?.setSelectionRange(cursor, cursor);
  });
}

function replaceLastToken(query: string, replacement: string): string {
  let inQuotes = false;
  let escaped = false;
  for (let index = query.length - 1; index >= 0; index -= 1) {
    const char = query[index];
    if (char === undefined) continue;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) return `${query.slice(0, index + 1)}${replacement}`;
  }
  return replacement;
}

function selectCandidate(candidate: SearchCandidateDto): void {
  const nextQuery = replaceLastToken(props.searchQuery, candidate.replacement);
  emit('update:searchQuery', nextQuery);
  emit('runSearch');
  closeMenu();
}

function handleInputKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    closeMenu();
    inputEl.value?.blur();
    return;
  }
  if (!menuOpen.value || operatorOptions.length === 0) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (showingCandidateMenu.value) {
      activeCandidateIndex.value = (activeCandidateIndex.value + 1) % menuCandidates.value.length;
      return;
    }
    activeOptionIndex.value = (activeOptionIndex.value + 1) % operatorOptions.length;
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (showingCandidateMenu.value) {
      activeCandidateIndex.value =
        (activeCandidateIndex.value - 1 + menuCandidates.value.length) % menuCandidates.value.length;
      return;
    }
    activeOptionIndex.value = (activeOptionIndex.value - 1 + operatorOptions.length) % operatorOptions.length;
    return;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault();
    if (showingCandidateMenu.value) {
      const selectedCandidate = menuCandidates.value[activeCandidateIndex.value] ?? menuCandidates.value[0];
      if (!selectedCandidate) return;
      selectCandidate(selectedCandidate);
      return;
    }
    const selectedOption = operatorOptions[activeOptionIndex.value] ?? operatorOptions[0];
    if (!selectedOption) return;
    selectOperator(selectedOption);
  }
}

function toggleMenuFromButton(): void {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) inputEl.value?.focus();
}

onMounted(() => {
  focusSearchInput();
});

watch(menuCandidates, (candidates) => {
  if (candidates.length === 0) {
    activeCandidateIndex.value = 0;
    return;
  }
  if (activeCandidateIndex.value >= candidates.length) activeCandidateIndex.value = 0;
});
</script>

<template>
  <section class="left-search-pane" data-app-left-search-pane>
    <div class="left-search-pane-input-row">
      <div class="left-search-pane-input-wrap">
        <Search class="left-search-pane-search-icon" aria-hidden="true" />
        <input
          ref="inputEl"
          :value="searchQuery"
          class="side-input left-search-pane-input"
          placeholder="Search..."
          @focus="menuOpen = true"
          @blur="closeMenu"
          @keydown="handleInputKeydown"
          @input="emit('update:searchQuery', inputValue($event)); emit('runSearch')"
        />
        <Type class="left-search-pane-type-icon" aria-hidden="true" />
      </div>
      <button
        type="button"
        class="left-search-pane-menu-button"
        aria-label="Search options"
        @mousedown.prevent
        @click="toggleMenuFromButton"
      >
        <SlidersHorizontal class="left-search-pane-menu-icon" aria-hidden="true" />
      </button>
    </div>
    <section v-if="menuOpen" class="left-search-pane-menu-card" aria-label="Search options" data-search-options-menu>
      <template v-if="showingCandidateMenu">
        <ul class="left-search-pane-menu-list" aria-label="Search candidates">
          <li v-for="(candidate, index) in menuCandidates" :key="candidate.value">
            <button
              type="button"
              :class="{ active: activeCandidateIndex === index }"
              @mousedown.prevent
              @mouseenter="activeCandidateIndex = index"
              @click="selectCandidate(candidate)"
            >
              <span>{{ candidate.value }}</span>
            </button>
          </li>
        </ul>
      </template>
      <template v-else>
        <p class="left-search-pane-menu-title">Search options</p>
        <ul class="left-search-pane-menu-list">
          <li v-for="(option, index) in operatorOptions" :key="option.label">
            <button
              type="button"
              :class="{ active: activeOptionIndex === index }"
              @mousedown.prevent
              @mouseenter="activeOptionIndex = index"
              @click="selectOperator(option)"
            >
              <strong>{{ option.label }}<template v-if="option.label !== '[property]'">:</template></strong>
              <span>{{ option.description }}</span>
            </button>
          </li>
        </ul>
      </template>
    </section>
    <ul class="result-list" aria-label="Search results">
      <li v-for="result in searchResults" :key="result.path">
        <button type="button" @click="emit('openSearchResult', result.path)">
          <strong>{{ result.title }}</strong>
          <small>{{ result.path }}</small>
          <span>{{ result.excerpt }}</span>
        </button>
      </li>
    </ul>
    <p v-if="searchResults.length === 0" class="muted left-search-pane-empty">No matches found.</p>
  </section>
</template>
