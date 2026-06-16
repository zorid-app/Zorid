import { defineZoridPlugin } from '@zorid/plugin-api';

export { imageFileRenderer } from './file-renderers.js';

export default defineZoridPlugin({
  activate() {
    // Static manifest contribution only; the trusted renderer host imports file-renderers directly.
  },
});
