import { defineZoridPlugin } from '@zorid/plugin-api';
import { slashMenuEditorContainer } from './editor-containers.js';

export default defineZoridPlugin({
  activate(ctx) {
    ctx.register.editorContainer(slashMenuEditorContainer);
  },
});
