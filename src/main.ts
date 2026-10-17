import { createPlatformAdapter, pickDesktopVault } from './platform/index.ts';
import type { PlatformVault } from './platform/index.ts';
import { Workspace } from './ui/workspace.ts';
import { renderStartupError } from './ui/startup-error.ts';
import { legacyBrowserExport } from './platform/browser-legacy-export.ts';
import './ui/recovery.css';
import './ui/import-status.css';
import './ui/styles.css';
import './ui/hotkey-settings.css';
import './ui/reference-defaults.css';
import './ui/chrome.css';
import './ui/sidebar-controls.css';
import './ui/file-tree-create.css';
import './ui/file-tree-drag.css';
import './editor/table-controls.css';
import './editor/live-lists.css';
import './editor/live-inline.css';
import './editor/image-embed-controls.css';
import './editor/wiki-completion.css';
import './editor/folding.css';
import './editor/live-math.css';
import './editor/live-fences.css';
import './editor/live-callouts.css';
import './ui/pdf-view.css';
import './ui/media-view.css';
import './canvas/view.css';
import './canvas/markdown-card.css';
import './canvas/attachment-card.css';
import './canvas/embed-preview.css';
import './bases/session.css';
import './bases/table-view.css';
import './bases/cards-view.css';
import './bases/list-view.css';
import './bases/kanban-view.css';
import './ui/split-layout.css';
import './ui/tab-docking.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
async function start(chooseAnother=false): Promise<void> {
  const workspace = new Workspace(root);
  let platform:PlatformVault|null=null;
  try {
    platform=await (chooseAnother?pickDesktopVault():createPlatformAdapter());
    await workspace.start(platform);
  } catch (error) {
    let canChooseAnother=false;
    try{canChooseAnother=await workspace.cleanupFailedStartup(platform);}catch(cleanupError){console.error('Startup lease cleanup failed',cleanupError);}
    let exportPrevious:(()=>void)|undefined;
    if(!window.zorid)try{exportPrevious=legacyBrowserExport();}catch{/* Unavailable preview storage is never overwritten. */}
    renderStartupError(root,error,{
      ...(exportPrevious?{legacyExport:exportPrevious}:{}),
      retry:()=>window.location.reload(),
      ...(canChooseAnother&&window.zorid?{openAnotherVault:()=>void start(true)}:{}),
    });
    console.error(error);
  }
}
void start();
