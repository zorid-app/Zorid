// Independent disposable inputs. Nothing here is positive product-creation proof.
export const vaultName = 'bases-safety';
export const template = '---\nkind: scalar\nstage: Template only\nliteral: "{{date}}"\n---\n# Literal conflict template 😀\nKeep {{title}} unchanged.\n';
export const actor = (kind, fields, body) => `---\nkind: ${kind}\n${fields}untouched: keep\n---\n${body}\n`;
const table = 'views:\n  - type: table\n    name: Main\n    order: [file.name, score, topics]\n    sort: [{property: file.name, direction: ASC}]\n    summaries: {score: Total}\n';
const board = (kind, property, extra = '') => `filters: 'note.kind == "${kind}"'\nnewItemFolder: Created\nviews:\n  - type: kanban\n    name: Board\n    order: [file.name, ${property}]\n    groupBy: {property: ${property}, direction: ASC}\n${extra}`;
export function fixtureFiles() {
  return new Map([
    ['Properties.yaml', 'properties:\n  score: {type: number}\n  topics:\n    type: multiselect\n    options: [{value: Alpha, label: Original Alpha}, {value: Beta}]\n  day: {type: date}\n  project:\n    type: relation\n    relation: {targetFilter: \'kind == "project"\'}\n'],
    ['Created/.keep', 'Disposable output folder.\n'],
    ['Safety.base', `# Safety unknown configuration/comment sentinel\nextraSafety: preserve\nfilters: 'note.kind == "safety" && (file.name == "A" || file.name == "B")'\nsummaries: {Total: 'values.sum()'}\n${table}`],
    ['A.md', actor('safety', 'score: 1\ntopics: [Alpha]\n', '# A body 😀\nBody A sentinel')],
    ['B.md', actor('safety', 'score: 2\ntopics: [Beta]\n', '# B body\nBody B sentinel')],
    ['Replace.md', actor('replacement', 'score: 3\n', '# Original actor')],
    ['Replacement.base', `filters: 'note.kind == "replacement"'\n${table}`],
    ['Sidebars/Context.base', 'filters: \'note.kind == "sidebar-row" && note.category == this.category\'\nviews: [{type: table, name: Sidebar context, order: [file.name, score, topics]}]\n'],
    ['Sidebars/Other.base', 'filters: \'file.name == "Sidebar Two"\'\nviews: [{type: table, name: Other sidebar, order: [file.name, score]}]\n'],
    ['Context One.md', actor('context', 'category: One\n', '# Context One outline heading')],
    ['Context Two.md', actor('context', 'category: Two\n', '# Context Two outline heading')],
    ['Sidebar One.md', actor('sidebar-row', 'category: One\nscore: 11\ntopics: [Alpha]\n', 'First sidebar row')],
    ['Sidebar Two.md', actor('sidebar-row', 'category: Two\nscore: 22\ntopics: [Beta]\n', 'Second sidebar row')],
    ['Named.base', `filters: 'note.kind == "safety"'\nviews: [{type: table, name: Old view, order: [file.name, score]}, {type: list, name: Other, order: [file.name]}]\n`],
    ['Named host.md', '# Host 😀\n\n![[Named.base#Old view|Keep alias]]\n\n[Read](Named.base#Old%20view)\n\n![[Named.base#Other]]\n\nHost unrelated body sentinel.\n'],
    ['Named clean.md', '# Clean reference\n![[Named.base#Old view]]\n'],
    ['Scalar.base', board('scalar', 'stage', '    groupOrder: [null, Todo, Done]\n')],
    ['Scalar A.md', actor('scalar', 'stage: Todo\n', 'Scalar A body')],
    ['Scalar B.md', actor('scalar', 'stage: Done\n', 'Scalar B body')],
    ['Scalar missing.md', actor('scalar', '', 'Missing scalar body')],
    ['Null defaults.base', `filters: 'note.kind == "scalar-default" && note.stage == "Todo"'\nnewItemFolder: Created\nviews: [{type: kanban, name: Defaults, order: [file.name], groupBy: {property: stage, direction: ASC}, groupOrder: [null, Todo, Done]}]\n`],
    ['Default seed.md', actor('scalar-default', 'stage: Todo\n', 'Default seed')],
    ['Template group.base', board('scalar', 'stage').replace('newItemFolder: Created\n', 'newItemFolder: Created\nnewItemTemplate: Templates/Conflict.md\n')],
    ['Templates/Conflict.md', template],
    ['List.base', board('list-group', 'topics')],
    ['List A.md', actor('list-group', 'topics: [Alpha, Beta]\n', 'List source')],
    ['List B.md', actor('list-group', 'topics: [Beta]\n', 'List destination')],
    ['Date.base', board('date-group', 'day')],
    ['Date A.md', actor('date-group', 'day: "2026-10-01"\n', 'Date source')],
    ['Date B.md', actor('date-group', 'day: "2026-10-02"\n', 'Date destination')],
    ['Link.base', board('link-group', 'project')],
    ['Link A.md', actor('link-group', 'project: "[[Projects/One|Alias One]]"\n', 'Link source')],
    ['Link B.md', actor('link-group', 'project: "[[Projects/Two|Alias Two]]"\n', 'Link destination')],
    ['Projects/One.md', actor('project', '', 'Project One')],
    ['Projects/Two.md', actor('project', '', 'Project Two')],
    ['Folder.base', board('folder-group', 'file.folder')],
    ['From/Move.md', actor('folder-group', 'score: 4\n', 'Folder source exact body 😀')],
    ['To/Target.md', actor('folder-group', 'score: 5\n', 'Folder destination')],
  ]);
}
export const openBoundaries = [
  'This campaign is limited to owned post-prepare checkpoint-access denial and original retry; actual phase results establish execution. Arbitrary disk/power loss and lost-create recovery are separate gates.',
  'Queued newer drafts during a failed live save require a deterministic native failure fixture; external stale-CAS coverage does not establish that retry continuation.',
  'Native OS clipboard, screen reader, IME and matched visual/scaling scenarios belong to separate acceptance campaigns.',
  'Sidebar newest-selection race requires an observable real UI in-flight boundary; sequential selection does not establish that race. No synthetic pending controller is installed.',
  'This campaign uses normal frontend/native artifacts; source-only authoring is not runtime acceptance.',
];
