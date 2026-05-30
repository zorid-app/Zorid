import { createApp } from 'vue';
import App from './App.vue';
import { createRendererDebugLogger, installRendererDebugLogging } from './debug-log.js';
import '@zorid/ui-vue/tokens.css';
import '@zorid/ui-vue/components.css';
import './styles.css';

const saveDebugLog = window.zoridDesktop.saveDebugLog.bind(window.zoridDesktop);
const log = createRendererDebugLogger(saveDebugLog, { scope: 'renderer.vue' });

installRendererDebugLogging(saveDebugLog);

const app = createApp(App);
app.config.errorHandler = (error, _instance, info) => {
  log({ level: 'error', message: `Vue renderer error: ${info}`, data: error });
  console.error(error);
};
app.mount('#app');
