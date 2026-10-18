import { TasksController, taskReadDiagnostics } from './controller.ts';
import type { TasksHost, TaskDraft } from './controller.ts';
import type { DocumentTaskRow, DocumentTaskType } from '../core/document-semantics.ts';

export interface TasksView {
  readonly ready: Promise<void>;
  readonly controller: TasksController;
  hasPendingChanges(): boolean;
  flush(): Promise<void>;
  refresh(): Promise<void>;
  prepareClose(): Promise<void>;
  cancelClose(): void;
  close(): Promise<void>;
  /** Synchronous final cleanup after successful prepareClose. */
  destroy(): void;
}
/** Host imports view.css once, mounts one view per tab, and retains the view while
 * parked. flush waits for explicit saves; it never implicitly saves a draft. */
export function createTasksView(container: HTMLElement, host: TasksHost): TasksView {
  const controller = new TasksController(host), doc = container.ownerDocument;
  let retiring = false;
  const root = doc.createElement('section'); root.className = 'tasks-view'; root.setAttribute('aria-label','Tasks'); container.append(root);
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => { const e = doc.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
  const button = (label: string, action: () => unknown) => { const e = element('button',label); e.type = 'button'; e.dataset.focus = label; e.disabled = controller.state.busy; e.addEventListener('click',() => { if (!retiring) void action(); }); return e; };
  const field = (label: string, input: HTMLElement) => { input.dataset.focus = label; const e = element('label'); e.append(element('span',label),input); return e; };
  const input = (value: string, change: (value: string) => void, type = 'text') => { const e = element('input'); e.type = type; e.value = value; e.disabled = controller.state.busy; e.addEventListener('input',() => { if (!retiring) change(e.value); }); return e; };
  const select = (value: string, options: readonly {id:string;label:string}[], change: (v:string) => void) => {
    const e = element('select'); for (const o of options) { const opt = element('option',o.label); opt.value = o.id; e.append(opt); } e.value = value; e.disabled = controller.state.busy; e.addEventListener('change',() => { if (!retiring) change(e.value); }); return e;
  };
  function editFields(draft: TaskDraft): HTMLElement {
    const form = element('form'); form.className = 'tasks-edit';
    const options = [...draft.type.status.options];
    if (!options.some(o => o.id === draft.status)) options.unshift({id:draft.status,label:`Unknown status (saved value preserved)`,category:null});
    form.append(field('Status',select(draft.status,options,v => { draft.status = v; })));
    for (const name of ['plannedDay','deadline'] as const) if (draft.type[name]) form.append(field(draft.type[name]!.label,input(draft[name],v => { draft[name] = v; },'date')));
    const save = element('button','Save changes'); save.type = 'submit'; save.disabled = controller.state.busy;
    form.append(save,button('Discard draft',() => controller.discard(draft.row.witness.entryId)));
    form.addEventListener('submit',e => { e.preventDefault(); if (retiring) return; void controller.save(draft.row.witness.entryId); });
    form.append(element('small','Draft retained until saved or discarded. Saving checks the original note and type revisions.'));
    return form;
  }
  function task(row: DocumentTaskRow, type?: DocumentTaskType): HTMLElement {
    const item = element('li'); item.className = 'tasks-item'; item.dataset.taskId = row.witness.entryId;
    const heading = element('div'); heading.className = 'tasks-item-heading';
    heading.append(button(row.title || row.path,() => controller.open(row)),element('span',row.category === null ? 'Unknown status (saved value preserved)' : row.statusLabel ?? 'Status unavailable'));
    item.append(heading,element('small',row.path));
    if (row.plannedDay) item.append(element('span',`Planned: ${row.plannedDay}`));
    if (row.deadline) item.append(element('span',`Deadline: ${row.deadline}`));
    const draft = controller.state.drafts.get(row.witness.entryId);
    if (draft) {
      if (draft.row.witness.revision !== row.witness.revision || draft.type.witness.revision !== type?.witness.revision) item.append(element('p','Saved data changed. This draft still uses its original revisions; discard it to edit the latest values.'));
      item.append(editFields(draft));
    } else if (type) item.append(button('Edit status and dates',() => { controller.beginEdit(row); [...root.querySelectorAll<HTMLElement>('[data-task-id]')].find(e => e.dataset.taskId === row.witness.entryId)?.querySelector('select')?.focus(); }));
    return item;
  }
  let focus: {key:string;taskId?:string;start?:number|null;end?:number|null} | undefined;
  function render(): void {
    const active = doc.activeElement as HTMLElement | null;
    if (active && root.contains(active) && active.dataset.focus) focus = {key:active.dataset.focus,taskId:active.closest<HTMLElement>('[data-task-id]')?.dataset.taskId,start:active instanceof doc.defaultView!.HTMLInputElement ? active.selectionStart : undefined,end:active instanceof doc.defaultView!.HTMLInputElement ? active.selectionEnd : undefined};
    const setupOpen = root.querySelector('details')?.open ?? false;
    retiring = controller.phase !== 'active';
    const state = controller.state, data = state.data;
    root.replaceChildren(); root.setAttribute('aria-busy',String(state.busy));
    const header = element('header'); header.append(element('h2','Tasks'),button('Refresh',() => controller.refresh())); root.append(header);
    const filters = element('div'); filters.className = 'tasks-controls';
    filters.append(field('Show',select(state.filter,[{id:'all',label:'All tasks'},{id:'today',label:'Today'},{id:'unscheduled',label:'Unscheduled'}],v => controller.setFilter(v as typeof state.filter))));
    const done = input('',() => controller.setFilter(state.filter,done.checked),'checkbox'); done.checked = state.showDone;
    filters.append(field('Include completed',done)); root.append(filters);
    const status = element('div'); status.setAttribute('role',state.error ? 'alert' : 'status');
    if (state.error) status.append(element('p',state.error));
    if (state.busy) status.append(element('p','Loading saved tasks…'));
    if (data) for (const text of taskReadDiagnostics(data)) status.append(element('p',text));
    root.append(status);
    if (data?.types.length || state.capture.title || state.unconfirmedCapture) {
      const capture = element('form'); capture.className = 'tasks-capture';
      const hasType = !!data?.types.some(t => t.typeId === state.capture.typeId);
      capture.append(element('h3','New task'),field('Title',input(state.capture.title,v => { state.capture.title = v; })),field('Folder',input(state.capture.destination,v => { state.capture.destination = v; })),field('Type',select(state.capture.typeId,(data?.types ?? []).map(t => ({id:t.typeId,label:t.label})),v => { state.capture.typeId = v; render(); })));
      if (!hasType) capture.append(element('p','The selected task Type is unavailable. Your draft is retained. Choose an available Type or repair your Type files before creating.'));
      for (const control of capture.querySelectorAll<HTMLInputElement|HTMLSelectElement>('input,select')) control.disabled ||= !!state.unconfirmedCapture;
      const add = element('button','Create task'); add.type = 'submit'; add.disabled = state.busy || !!state.unconfirmedCapture || !hasType; capture.append(add);
      if (!state.unconfirmedCapture) capture.append(button('Discard capture draft',() => {
        // A retained button must never resolve a later uncertain create.
        if (state.busy || state.unconfirmedCapture) return;
        state.capture.title = ''; render();
      }));
      capture.addEventListener('submit',e => { e.preventDefault(); if (retiring || add.disabled) return; void controller.capture(); }); root.append(capture);
    }
    if (state.unconfirmedCapture) {
      const reconcile = element('section'); reconcile.setAttribute('aria-label','Unconfirmed capture');
      reconcile.append(element('p',`Check the vault for “${state.unconfirmedCapture.title}” in ${state.unconfirmedCapture.destination}. Resolve this capture only after checking whether the task was created.`),button('I checked: task exists',() => controller.resolveCapture(true)),button('I checked: task was not created',() => controller.resolveCapture(false))); root.append(reconcile);
    }
    const list = element('ul'); list.className = 'tasks-list';
    const rows = new Map(data?.result.rows.map(row => [row.witness.entryId,row]));
    const listed = new Set<string>();
    for (const group of data?.result.groups ?? []) {
      const type = data?.types.find(t => t.typeId === group.typeId);
      const label = type?.status.options.find(o => o.id === group.statusId)?.label ?? 'Unknown status';
      const section = element('li'); section.className = 'tasks-group'; section.append(element('h3',`${type?.label ?? 'Task'} · ${label}`));
      const members = element('ul'); members.className = 'tasks-list';
      for (const id of group.entryIds) { const row = rows.get(id); if (row && !listed.has(id)) { members.append(task(row,type)); listed.add(id); } }
      section.append(members); list.append(section);
    }
    for (const row of data?.result.rows ?? []) if (!listed.has(row.witness.entryId)) list.append(task(row,data?.types.find(t => t.typeId === row.typeId)));
    // Hidden/deleted/filter-excluded drafts remain recoverable, never silently dropped.
    for (const [id,draft] of state.drafts) if (!data?.result.rows.some(r => r.witness.entryId === id)) { const orphan = task(draft.row,draft.type); orphan.prepend(element('p','Draft task is outside this result or no longer available.')); list.append(orphan); }
    root.append(list);
    if (data && !data.result.rows.length) root.append(element('p',data.types.length ? 'No matching saved tasks.' : 'No task types available. Install a preset or repair your Type files.'));
    const setup = element('details'); setup.open = setupOpen; setup.append(element('summary','Install Tasks preset'));
    const setupForm = element('form');
    // Values persist across refreshes via closure, including failed non-clobber attempts.
    setupForm.append(field('Type file (inside Types/)',input(locations.type,v => { locations.type = v; })),field('Base file',input(locations.base,v => { locations.base = v; })),field('Task folder',input(locations.destination,v => { locations.destination = v; })));
    setupForm.append(element('p','Creates ordinary Type and Base files without overwriting existing content. Choose unused paths if they conflict.'));
    const install = element('button','Install preset'); install.type = 'submit'; install.disabled = state.busy; setupForm.append(install);
    setupForm.addEventListener('submit',e => { e.preventDefault(); if (retiring) return; void controller.install({...locations}); }); setup.append(setupForm); root.append(setup);
    root.inert = retiring;
    if (retiring) for (const control of root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button')) control.disabled = true;
    if (focus && !state.busy && !retiring) {
      const target = [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(e => e.dataset.focus === focus!.key && e.closest<HTMLElement>('[data-task-id]')?.dataset.taskId === focus!.taskId);
      target?.focus({preventScroll:true});
      if (target instanceof doc.defaultView!.HTMLInputElement && target.type === 'text' && focus.start != null && focus.end != null) target.setSelectionRange(focus.start,focus.end);
      focus = undefined;
    }
  }
  const locations = {type:'Types/Task.yaml',base:'Bases/Tasks.base',destination:'Tasks'};
  const unsubscribe = controller.subscribe(render); render();
  const ready = controller.refresh();
  const destroy = (): void => { controller.destroy(); retiring = true; unsubscribe(); root.remove(); };
  return {
    controller,ready,hasPendingChanges:() => controller.hasPendingChanges(),
    flush:() => controller.flush(),refresh:() => controller.refresh(),
    prepareClose:() => controller.prepareClose(),cancelClose:() => controller.cancelClose(),
    async close() { await controller.prepareClose(); destroy(); },destroy,
  };
}
