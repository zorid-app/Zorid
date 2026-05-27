import { defineZoridPlugin } from '@zorid/plugin-api';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({ id: 'outline.open', title: 'Open Outline', callback: async () => undefined });
  },
});
