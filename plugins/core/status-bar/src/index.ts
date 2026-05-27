import { defineZoridPlugin } from '@zorid/plugin-api';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({ id: 'status-bar.open', title: 'Open Status Bar', callback: async () => undefined });
    ctx.register.setting({ id: 'status-bar', title: 'Status Bar', schema: { type: 'object', properties: { showVault: { type: 'boolean', default: true }, showIndexStatus: { type: 'boolean', default: true } } } });
  },
});
