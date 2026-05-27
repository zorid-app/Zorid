export interface MobileShellState {
  readonly primarySurface: 'notes' | 'search' | 'settings';
  readonly sheets: readonly string[];
  readonly hapticsAvailable: boolean;
}
export function createMobileShellState(): MobileShellState { return { primarySurface: 'notes', sheets: [], hapticsAvailable: false }; }
export function openMobileSheet(state: MobileShellState, id: string): MobileShellState { return { ...state, sheets: state.sheets.includes(id) ? state.sheets : [...state.sheets, id] }; }
