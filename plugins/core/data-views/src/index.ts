import { defineZoridPlugin } from '@zorid/plugin-api';
import { normalizeVaultPath } from '@zorid/shared';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.viewRenderer({ type: 'table', render: (container) => { container.dataset.renderer = 'table'; return { dispose: () => { delete container.dataset.renderer; } }; } });
    ctx.register.viewRenderer({ type: 'list', render: (container) => { container.dataset.renderer = 'list'; return { dispose: () => { delete container.dataset.renderer; } }; } });
    ctx.register.command({ id: 'data-views.open', title: 'Open Base', callback: () => ctx.dataViews.openBase(normalizeVaultPath('.zorid/views/tasks.zbase')) });
  },
});
