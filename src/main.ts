import { createPlatformAdapter } from './platform/index.ts';
import { Workspace } from './ui/workspace.ts';
import { el, textButton } from './ui/dom.ts';
import './ui/styles.css';
import './ui/reference-defaults.css';
import './editor/table-controls.css';
import './editor/live-lists.css';
import './editor/live-inline.css';
import './ui/pdf-view.css';
import './canvas/view.css';
import './ui/split-layout.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
async function start(): Promise<void> {
  try {
    const workspace = new Workspace(root);
    await workspace.start(await createPlatformAdapter());
  } catch (error) {
    root.replaceChildren();
    const screen = el('div', 'startup-error');
    screen.append(el('h1', '', 'Unable to open the workspace'), el('p', '', error instanceof Error ? error.message : String(error)), textButton('Try again', () => void start(), 'mod-cta'));
    root.append(screen);
    console.error(error);
  }
}
void start();
