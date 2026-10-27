// Prototype transport only: the renderer uses the same NativeVaultPlugin facade
// and capability subset as the direct-Rust Tauri shell.
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('__ZORID_TAURI__', true);
contextBridge.exposeInMainWorld('__ZORID_NATIVE_BENCH_ENABLED__', process.argv.includes('--zorid-native-bench'));
contextBridge.exposeInMainWorld('__TAURI__', {
  core: {invoke: (command, args) => ipcRenderer.invoke('zorid-native:invoke', command, args)},
  event: {listen: async (name, callback) => {
    if (typeof name !== 'string' || !/^tauri:[A-Za-z]+$/.test(name) || typeof callback !== 'function')
      throw new Error('Invalid prototype event subscription');
    const listener = (_event, event) => { if (event?.event === name) callback({payload: event.payload}); };
    ipcRenderer.on('zorid-native:event', listener);
    return () => ipcRenderer.removeListener('zorid-native:event', listener);
  }},
});
