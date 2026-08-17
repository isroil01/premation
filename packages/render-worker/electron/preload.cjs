/**
 * Preload for the render worker's offscreen window.
 *
 * Exposes exactly four calls and nothing else — the page it fronts is built
 * from this repo, but it renders DOCUMENTS SUPPLIED BY API CALLERS, and a
 * document is untrusted input. Anything reachable from here is reachable by
 * whoever posted the render.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('renderBridge', {
  job: () => ipcRenderer.invoke('worker:job'),
  frame: (index, base64, ext) => ipcRenderer.invoke('worker:frame', index, base64, ext),
  progress: (done, total) => ipcRenderer.send('worker:progress', done, total),
  done: (result, error) => ipcRenderer.invoke('worker:done', result, error),
});
