import { defineZoridPlugin } from '@zorid/plugin-api';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.command({
      id: 'fields.inspect-active',
      title: 'Inspect Active Fields',
      callback: async () => {
        const active = ctx.workspace.activeFile();
        if (active) await ctx.fields.getFields(active);
      },
    });
  },
});
