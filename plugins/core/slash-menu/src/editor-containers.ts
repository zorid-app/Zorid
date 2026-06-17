import type { EditorContainerContribution, EditorContainerMountContext } from '@zorid/platform-api';

const actions = ['Insert heading', 'Insert task', 'Insert quote'] as const;

function SlashMenu(ctx: EditorContainerMountContext): HTMLElement {
  const root = document.createElement('section');
  root.className = 'z-editor-slash-menu';
  root.dataset.editorContainer = 'zorid.core.slash-menu.cursor';
  root.tabIndex = ctx.input.keyboardFocus === 'container' ? 0 : -1;

  const title = document.createElement('h3');
  title.textContent = 'Slash menu';
  const list = document.createElement('ul');
  let selectedIndex = 0;

  const render = (): void => {
    list.replaceChildren();
    actions.forEach((action, index) => {
      const item = document.createElement('li');
      item.textContent = action;
      item.dataset.selected = String(index === selectedIndex);
      list.append(item);
    });
  };

  const accept = (): void => {
    root.dataset.acceptedAction = actions[selectedIndex];
    ctx.close();
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (!ctx.input.capturedKeys?.includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'ArrowDown') selectedIndex = (selectedIndex + 1) % actions.length;
    else if (event.key === 'ArrowUp') selectedIndex = (selectedIndex + actions.length - 1) % actions.length;
    else if (event.key === 'Enter') accept();
    else if (event.key === 'Escape') ctx.close();
    render();
  };

  ctx.root.addEventListener('keydown', onKeydown);
  ctx.dispose(() => ctx.root.removeEventListener('keydown', onKeydown));
  render();
  root.append(title, list);
  return root;
}

export const slashMenuEditorContainer: EditorContainerContribution = {
  id: 'zorid.core.slash-menu.cursor',
  title: 'Slash Menu',
  placement: { kind: 'cursor-popover' },
  priority: 100,
  activationReads: ['cursor', 'cursorText'],
  input: {
    keyboardFocus: 'editor',
    textInput: 'editor',
    capturedKeys: ['ArrowUp', 'ArrowDown', 'Enter', 'Escape'],
    pointer: { hitArea: 'content' },
  },
  shouldActivate(ctx) {
    const text = ctx.read.getText({ from: Math.max(0, ctx.read.cursor - 1), to: ctx.read.cursor });
    return text === '/';
  },
  mount(ctx) {
    ctx.root.append(SlashMenu(ctx));
  },
};
