import { normalizeBaseProperty } from './query.ts';
import type { BaseValue, BaseViewConfig, BaseViewPatch } from './document.ts';

/** Persisted layout keys stay stable while their labels follow the database UI. */
export const BASE_LAYOUTS = [['table', 'Table', 'table'], ['cards', 'Gallery', 'layout-grid'], ['list', 'List', 'list'], ['kanban', 'Board', 'columns-3']] as const;
export function layoutIcon(type: string): string { return BASE_LAYOUTS.find(([key]) => key === type)?.[2] ?? 'file-question'; }
export function uniqueViewName(views: readonly BaseViewConfig[], proposed = 'View'): string {
  const used = new Set(views.map(view => view.name));
  const name = proposed.trim() || 'View'; let candidate = name;
  for (let suffix = 2; used.has(candidate); suffix++) candidate = `${name} ${suffix}`;
  return candidate;
}
export function validateViewName(views: readonly BaseViewConfig[], name: string, selectedIndex = -1): string {
  const normalized = name.trim();
  if (!normalized) throw new Error('View name must not be empty.');
  if (/#|:|\||\^|%%|\[\[|\]\]/.test(normalized)) throw new Error('View names cannot contain # : | ^ %% [[ or ]].');
  return normalized;
}

export function createLayoutSettings(doc: Document, parent: HTMLElement, view: BaseViewConfig, properties: readonly (readonly [string, string])[], changed: () => void,onControl?:(key:string,control:HTMLInputElement|HTMLSelectElement)=>void): () => BaseViewPatch {
  const patch: BaseViewPatch = {};
  const row = (label: string, input: HTMLElement) => { const wrapper = doc.createElement('label'); wrapper.className = 'input-row'; wrapper.append(doc.createTextNode(label), input); parent.append(wrapper); input.setAttribute('aria-label', label); return wrapper; };
  const dropdown = (key: string, label: string, choices: readonly (readonly [string, string])[], fallback = '') => {
    const input = doc.createElement('select');
    for (const [value, text] of choices) { const option = doc.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
    const saved = typeof view[key] === 'string' ? view[key] : fallback;
    if (!choices.some(([value]) => value === saved)) { const option = doc.createElement('option'); option.value = saved; option.textContent = saved; input.prepend(option); }
    input.value = saved;onControl?.(key,input); input.addEventListener('change', () => { patch[key] = input.value || undefined; changed(); }); row(label, input); return input;
  };
  const slider = (key: string, label: string, min: number, max: number, step: number, fallback: number) => {
    const wrapper = doc.createElement('span'), input = doc.createElement('input'), output = doc.createElement('output'); input.type = 'range'; input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(typeof view[key] === 'number' ? view[key] : fallback); input.setAttribute('aria-label', label);onControl?.(key,input); output.value = input.value; wrapper.append(input, output);
    input.addEventListener('input', () => { output.value = input.value; patch[key] = Number(input.value); changed(); }); const labelRow = row(label, wrapper); wrapper.removeAttribute('aria-label'); labelRow.removeAttribute('for');
  };
  if (view.type === 'table') dropdown('rowHeight', 'Row height', [['', 'Short'], ['medium', 'Medium'], ['tall', 'Tall'], ['extra', 'Extra tall']]);
  if (view.type === 'cards' || view.type === 'kanban') {
    if (view.type === 'cards') slider('cardSize', 'Card size', 50, 800, 10, 200);
    else slider('columnWidth', 'Column width', 200, 500, 1, 276);
    dropdown('image', 'Image property', [['', 'None'], ...properties.filter(([key]) => key === 'file.file' || !key.startsWith('file.'))]);
    dropdown('imageFit', 'Image fit', [['', 'Cover'], ['contain', 'Contain']]);
    slider('imageAspectRatio', 'Image aspect ratio', .25, 2.5, .05, view.type === 'cards' ? 1 : .5);
  }
  if (view.type === 'list') {
    // Missing presentation keys select the renderer's database page rows, not
    // its legacy bullet/separator flow. This choice only edits existing keys.
    const pageRows = !view.indentProperties && !['bullet', 'number', 'none'].includes(String(view.markers)) && view.separator === undefined;
    const rows = doc.createElement('select');
    for (const [value, text] of [['page', 'Page rows (default)'], ['custom', 'Custom list rows']]) {
      const option = doc.createElement('option'); option.value = value; option.textContent = text; rows.append(option);
    }
    rows.value = pageRows ? 'page' : 'custom'; row('Rows', rows);onControl?.('rows',rows);
    const custom: BaseViewPatch = { markers: typeof view.markers === 'string' ? view.markers : 'bullet', indentProperties: view.indentProperties, separator: view.separator };
    const markers = dropdown('markers', 'Markers', [['bullet', 'Bullet'], ['number', 'Number'], ['none', 'None']], 'bullet');
    const indent = doc.createElement('input'); indent.type = 'checkbox'; indent.checked = view.indentProperties === true; const indentRow = row('Indent properties', indent);onControl?.('indentProperties',indent);
    const separator = doc.createElement('input'); separator.value = typeof view.separator === 'string' ? view.separator : ', '; const separatorRow = row('Property separator', separator);onControl?.('separator',separator);
    const sync = () => {
      const page = rows.value === 'page';
      markers.parentElement!.hidden = indentRow.hidden = page;
      separatorRow.hidden = page || indent.checked;
      markers.disabled = indent.disabled = separator.disabled = page;
    };
    rows.addEventListener('change', () => {
      if (rows.value === 'page') Object.assign(patch, { markers: undefined, indentProperties: undefined, separator: undefined });
      else {
        // A retained unknown marker alone still renders as page rows. Choosing
        // custom rows must actually enter the existing marked-list flow.
        if (!custom.indentProperties && custom.separator === undefined && !['bullet', 'number', 'none'].includes(String(custom.markers))) custom.markers = 'bullet';
        markers.value = String(custom.markers); Object.assign(patch, custom);
      }
      sync(); changed();
    });
    markers.addEventListener('change', () => { custom.markers = markers.value || undefined; });
    indent.addEventListener('change', () => { custom.indentProperties = patch.indentProperties = indent.checked; sync(); changed(); });
    separator.addEventListener('input', () => { custom.separator = patch.separator = separator.value; changed(); });
    sync();
  }
  return () => patch;
}

/** Root settings edits retain unknown settings and property extensions. */
export function propertyDisplayPatch(root: Readonly<Record<string, BaseValue>> | undefined, names: ReadonlyMap<string, string>): Record<string, BaseValue> {
  const existing = root?.properties;
  const properties: Record<string, BaseValue> = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing as Record<string, BaseValue> } : {};
  for (const [property, name] of names) {
    const key = Object.keys(properties).find(key => normalizeBaseProperty(key) === normalizeBaseProperty(property)) ?? property;
    const previous = properties[key], configuration: Record<string, BaseValue> = previous && typeof previous === 'object' && !Array.isArray(previous) ? { ...previous as Record<string, BaseValue> } : {};
    if (name.trim()) configuration.displayName = name.trim(); else delete configuration.displayName;
    properties[key] = configuration;
  }
  return { properties };
}
