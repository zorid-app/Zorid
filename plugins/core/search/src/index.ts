import { defineZoridPlugin } from '@zorid/plugin-api';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({ id: 'search.open', title: 'Open Search', callback: async () => undefined });
  },
});
