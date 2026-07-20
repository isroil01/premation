/**
 * Preload for the render-tests harness window. Exposes a minimal, typed bridge
 * to the renderEntry: pull config synchronously, stream frames/manifest to main,
 * and signal completion. contextIsolation stays on — no node in the page.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnessBridge', {
  config: ipcRenderer.sendSync('harness:config'),
  frame: (payload) => ipcRenderer.invoke('harness:frame', payload),
  manifest: (scenes) => ipcRenderer.invoke('harness:manifest', scenes),
  done: (error) => ipcRenderer.invoke('harness:done', error ?? null),
});
