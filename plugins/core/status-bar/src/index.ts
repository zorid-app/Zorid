import { defineZoridPlugin } from '@zorid/plugin-api';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({ id: 'status-bar.open', title: 'Open Status-bar', callback: async () => undefined });
  },
});
