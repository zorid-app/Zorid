export const vaultName = 'bases-sidebar-race';
export const ROW_COUNT = 32;
export const OLD_BASE = 'Sidebar pending.base';
export const FIRST_BASE = 'Sidebar first.base';
export const NEWEST_BASE = 'Sidebar newest.base';
export const OLD_VIEW = 'Pending sidebar';
export const FIRST_VIEW = 'Superseded sidebar';
export const NEWEST_VIEW = 'Newest sidebar';
export const FIRST_NOTE = 'SidebarRaceFirst.md';
export const NEWEST_NOTE = 'SidebarRaceNewest.md';
export const rowNames = Object.freeze(Array.from({length: ROW_COUNT}, (_, i) => `SidebarRaceRows/Row${String(i + 1).padStart(2, '0')}.md`));
const config = (filter, name) => `fixtureSentinel: sidebar-race-only\nfilters: ${filter}\nviews:\n  - type: table\n    name: ${name}\n    order: [file.name, race_score]\n    sort: [{property: file.name, direction: ASC}]\n`;
export const baseSources = Object.freeze({
  [OLD_BASE]: config('file.inFolder("SidebarRaceRows")', OLD_VIEW),
  [FIRST_BASE]: config(`file.path == "${FIRST_NOTE}"`, FIRST_VIEW),
  [NEWEST_BASE]: config(`file.path == "${NEWEST_NOTE}"`, NEWEST_VIEW),
});
export const rowSource = index => `---\nrace_score: ${index + 1}\nsentinel: keep-${index + 1}\n---\n# Row ${index + 1}\nSidebar race body ${index + 1} 😀\n`;
export function fixtureFiles() {
  return new Map([
    ...Object.entries(baseSources),
    ...rowNames.map((name, index) => [name, rowSource(index)]),
    [FIRST_NOTE, '---\nrace_score: 111\n---\n# First\nFirst target immutable body.\n'],
    [NEWEST_NOTE, '---\nrace_score: 999\n---\n# Newest\nNewest target immutable body.\n'],
    ['Properties.yaml', 'properties:\n  race_score: {type: number}\n'],
  ]);
}
