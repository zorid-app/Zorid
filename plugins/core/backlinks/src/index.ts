import { defineZoridPlugin } from '@zorid/plugin-api';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({ id: 'backlinks.open', title: 'Open Backlinks', callback: async () => undefined });
  },
});
