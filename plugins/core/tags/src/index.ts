import { defineZoridPlugin } from '@zorid/plugin-api';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({ id: 'tags.open', title: 'Open Tags', callback: async () => undefined });
  },
});
