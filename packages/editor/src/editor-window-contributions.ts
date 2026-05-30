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
  | { readonly kind: 'range-overlay'; readonly range: EditorWindowSourceRange | DynamicRangeProvider }
  | { readonly kind: 'viewport-overlay'; readonly position: ViewportPosition };

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
  render?(context: EditorWindowContext): HTMLElement | DisposableView;
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
  if (placement.kind === 'cursor-popover' || placement.kind === 'selection-popover') return placement.mode ?? 'stacked';
  return 'stacked';
}

function contributionIsEnabled(contribution: EditorWindowContribution, context: EditorWindowContext): boolean {
  const { placement } = contribution;
  if ((placement.kind === 'cursor-popover' || placement.kind === 'selection-popover') && placement.when) {
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
