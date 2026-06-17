export interface DisposableView {
  readonly element: HTMLElement;
  dispose?(): void;
}

export interface EditorWindowSourceRange {
  readonly from: number;
  readonly to: number;
}

export type PlacementPredicate = (context: EditorWindowContext) => boolean;
export type DynamicRangeProvider = (context: EditorWindowContext) => EditorWindowSourceRange | null;

export interface ViewportPosition {
  readonly x: number;
  readonly y: number;
}

export type EditorWindowPlacement =
  | { readonly kind: 'document-header' }
  | { readonly kind: 'document-footer' }
  | { readonly kind: 'side-panel'; readonly side: 'left' | 'right' }
  | { readonly kind: 'status-area' }
  | { readonly kind: 'cursor-popover'; readonly mode?: 'stacked' | 'exclusive'; readonly when?: PlacementPredicate }
  | { readonly kind: 'selection-popover'; readonly mode?: 'stacked' | 'exclusive'; readonly when?: PlacementPredicate }
  | { readonly kind: 'range-overlay'; readonly range?: EditorWindowSourceRange | DynamicRangeProvider }
  | { readonly kind: 'hover-popover'; readonly mode?: 'stacked' | 'exclusive'; readonly when?: PlacementPredicate }
  | { readonly kind: 'viewport-overlay'; readonly position?: ViewportPosition };

export interface EditorWindowContext {
  readonly documentPath: string;
  readonly editor?: {
    readonly hasFocus: boolean;
    readonly selection: readonly EditorWindowSourceRange[];
    readonly mainCursor: number;
    readonly visibleRanges: readonly EditorWindowSourceRange[];
    coordsAtPos(position: number): DOMRect | null;
    readonly stateReadonly: unknown;
  };
  readonly workspace?: unknown;
  readonly commands?: unknown;
}

export interface EditorWindowContribution {
  readonly id: string;
  readonly placement: EditorWindowPlacement;
  readonly priority?: number;
  render?(context: EditorWindowContext): HTMLElement | DisposableView | undefined;
  update?(context: EditorWindowContext): void;
  dispose?(): void;
}

export interface GroupedEditorWindowContribution {
  readonly placementKey: string;
  readonly mode: 'stacked' | 'exclusive';
  readonly active: readonly EditorWindowContribution[];
  readonly suppressed: readonly EditorWindowContribution[];
  readonly diagnostics: readonly string[];
}

export function editorWindowPlacementKey(placement: EditorWindowPlacement): string {
  if (placement.kind === 'side-panel') return `${placement.kind}:${placement.side}`;
  return placement.kind;
}

function placementMode(placement: EditorWindowPlacement): 'stacked' | 'exclusive' {
  if (
    placement.kind === 'cursor-popover' ||
    placement.kind === 'selection-popover' ||
    placement.kind === 'hover-popover'
  )
    return placement.mode ?? 'stacked';
  return 'stacked';
}

function contributionIsEnabled(contribution: EditorWindowContribution, context: EditorWindowContext): boolean {
  const { placement } = contribution;
  if (
    (placement.kind === 'cursor-popover' ||
      placement.kind === 'selection-popover' ||
      placement.kind === 'hover-popover') &&
    placement.when
  ) {
    return placement.when(context);
  }
  return true;
}

function contributionPriority(contribution: EditorWindowContribution): number {
  return contribution.priority ?? 0;
}

export function groupEditorWindowContributions(
  contributions: readonly EditorWindowContribution[],
  context: EditorWindowContext,
): GroupedEditorWindowContribution[] {
  const buckets = new Map<string, EditorWindowContribution[]>();
  for (const contribution of contributions.filter((candidate) => contributionIsEnabled(candidate, context))) {
    const key = editorWindowPlacementKey(contribution.placement);
    buckets.set(key, [...(buckets.get(key) ?? []), contribution]);
  }

  return [...buckets.entries()].map(([placementKey, bucket]) => {
    const ordered = [...bucket].sort(
      (left, right) => contributionPriority(right) - contributionPriority(left) || left.id.localeCompare(right.id),
    );
    const mode = placementMode(ordered[0]!.placement);
    if (mode === 'exclusive') {
      const active = ordered.slice(0, 1);
      const suppressed = ordered.slice(1);
      return {
        placementKey,
        mode,
        active,
        suppressed,
        diagnostics: suppressed.map(
          (contribution) =>
            `${contribution.id} suppressed at ${placementKey} by ${active[0]!.id} because the placement is exclusive.`,
        ),
      };
    }
    return { placementKey, mode, active: ordered, suppressed: [], diagnostics: [] };
  });
}

export interface EditorWindowContributionHostOptions {
  readonly parent: HTMLElement;
  readonly contributions: readonly EditorWindowContribution[];
  readonly context: EditorWindowContext;
}

interface MountedContributionView {
  readonly contribution: EditorWindowContribution;
  readonly view: DisposableView;
}

function asDisposableView(rendered: HTMLElement | DisposableView): DisposableView {
  return rendered instanceof HTMLElement ? { element: rendered } : rendered;
}

function appendContributionView(parent: HTMLElement, mounted: MountedContributionView): void {
  mounted.view.element.dataset.editorWindowContribution = mounted.contribution.id;
  parent.append(mounted.view.element);
}

function renderContribution(
  contribution: EditorWindowContribution,
  context: EditorWindowContext,
): MountedContributionView | null {
  const rendered = contribution.render?.(context);
  if (!rendered) return null;
  return { contribution, view: asDisposableView(rendered) };
}

function contributionGroupClassName(group: GroupedEditorWindowContribution): string {
  return `z-editor-window-contribution-group z-editor-window-contribution-group--${group.placementKey.replace(/[^a-z0-9_-]+/giu, '-')}`;
}

function groupUsesPopoverShell(group: GroupedEditorWindowContribution): boolean {
  return (
    group.placementKey === 'cursor-popover' ||
    group.placementKey === 'selection-popover' ||
    group.placementKey === 'hover-popover'
  );
}

function applyCursorPopoverAnchor(groupElement: HTMLElement, parent: HTMLElement, context: EditorWindowContext): void {
  const coords = context.editor?.coordsAtPos(context.editor.mainCursor);
  if (!coords) return;
  const anchorHost = parent.parentElement ?? parent;
  const parentRect = anchorHost.getBoundingClientRect();
  groupElement.dataset.anchor = 'cursor';
  groupElement.style.position = 'absolute';
  groupElement.style.left = `${coords.left - parentRect.left}px`;
  groupElement.style.top = `${coords.bottom - parentRect.top}px`;
}

function mountContributionGroup(
  parent: HTMLElement,
  group: GroupedEditorWindowContribution,
  context: EditorWindowContext,
): MountedContributionView[] {
  const groupElement = document.createElement('section');
  groupElement.className = contributionGroupClassName(group);
  groupElement.dataset.placementKey = group.placementKey;
  groupElement.dataset.mode = group.mode;
  if (group.placementKey === 'cursor-popover') applyCursorPopoverAnchor(groupElement, parent, context);
  parent.append(groupElement);

  const mounted = group.active.flatMap((contribution) => {
    const view = renderContribution(contribution, context);
    return view ? [view] : [];
  });

  if (!groupUsesPopoverShell(group)) {
    for (const view of mounted) appendContributionView(groupElement, view);
    return mounted;
  }

  const shell = document.createElement('div');
  shell.className = 'z-editor-window-popover';
  shell.dataset.placementKey = group.placementKey;
  shell.setAttribute('role', 'group');
  groupElement.append(shell);

  if (mounted.length > 1) {
    const tabs = document.createElement('div');
    tabs.className = 'z-editor-window-popover__tabs';
    tabs.setAttribute('role', 'tablist');
    shell.append(tabs);
    for (const view of mounted) {
      const tab = document.createElement('button');
      tab.className = 'z-editor-window-popover__tab';
      tab.type = 'button';
      tab.textContent = view.contribution.id;
      tab.dataset.editorWindowContributionTab = view.contribution.id;
      tab.setAttribute('role', 'tab');
      tabs.append(tab);
    }
  }

  const sections = document.createElement('div');
  sections.className = 'z-editor-window-popover__sections';
  shell.append(sections);
  for (const view of mounted) {
    const section = document.createElement('section');
    section.className = 'z-editor-window-popover__section';
    section.dataset.editorWindowContributionSection = view.contribution.id;
    section.setAttribute('role', 'tabpanel');
    appendContributionView(section, view);
    sections.append(section);
  }

  return mounted;
}

export class EditorWindowContributionHost {
  readonly root: HTMLElement;
  #parent: HTMLElement;
  #contributions: readonly EditorWindowContribution[];
  #context: EditorWindowContext;
  #mounted: MountedContributionView[] = [];

  constructor({ parent, contributions, context }: EditorWindowContributionHostOptions) {
    this.#parent = parent;
    this.#contributions = contributions;
    this.#context = context;
    this.root = document.createElement('div');
    this.root.className = 'z-editor-window-contributions';
    this.#parent.append(this.root);
    this.#render();
  }

  update(context: EditorWindowContext, contributions: readonly EditorWindowContribution[] = this.#contributions): void {
    this.#context = context;
    this.#contributions = contributions;
    this.#render();
  }

  dispose(): void {
    for (const mounted of this.#mounted) {
      mounted.contribution.dispose?.();
      mounted.view.dispose?.();
    }
    this.#mounted = [];
    this.root.remove();
  }

  #render(): void {
    for (const mounted of this.#mounted) {
      mounted.contribution.dispose?.();
      mounted.view.dispose?.();
    }
    this.#mounted = [];
    this.root.replaceChildren();
    for (const group of groupEditorWindowContributions(this.#contributions, this.#context)) {
      this.#mounted.push(...mountContributionGroup(this.root, group, this.#context));
    }
    for (const contribution of this.#contributions) contribution.update?.(this.#context);
  }
}

export function renderEditorWindowContributions(
  options: EditorWindowContributionHostOptions,
): EditorWindowContributionHost {
  return new EditorWindowContributionHost(options);
}
