import { defineZoridPlugin } from '@zorid/plugin-api';
import { normalizeVaultPath } from '@zorid/shared';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({
      id: 'file-explorer.open-root',
      title: 'Open File Explorer',
      callback: async () => {
        await ctx.workspace.openView({
          id: 'file-explorer',
          title: 'Files',
          view: {
            mount(mountCtx) {
              mountCtx.root.textContent = 'Files';
            },
          },
        });
      },
    });
    ctx.register.command({
      id: 'file-explorer.open-readme',
      title: 'Open README',
      callback: () => ctx.workspace.openFile(normalizeVaultPath('README.md')),
    });
  },
});
