import { defineZoridPlugin } from '@zorid/plugin-api';
import { createFieldsPropertiesEditorRegistration } from './properties-editor.js';

export type { FieldsPluginApi, PropertiesEditorContext, PropertiesEditorRegistration } from './properties-editor.js';
export { createFieldsPropertiesEditorRegistration };

export const fieldsPropertiesEditorRegistration = createFieldsPropertiesEditorRegistration();

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
