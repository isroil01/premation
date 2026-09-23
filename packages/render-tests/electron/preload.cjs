/**
 * Preload for the render-tests harness window. Exposes a minimal, typed bridge
 * to the renderEntry: pull config synchronously, stream frames/manifest to main,
 * and signal completion. contextIsolation stays on — no node in the page.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harnessBridge', {
  config: ipcRenderer.sendSync('harness:config'),
  frame: (payload) => ipcRenderer.invoke('harness:frame', payload),
  // D2 `native` backend: a RenderFrameFile per webgpu frame (Uint8Array rides structured clone).
  sceneFile: (payload) => ipcRenderer.invoke('harness:scene-file', payload),
  // ...and the measured readback table it compares through (renderEntry measureReadbackTable).
  readbackTable: (payload) => ipcRenderer.invoke('harness:readback-table', payload),
  // D2w `native-scene`: the scene as a project document (harness/sceneProject.ts).
  sceneProject: (payload) => ipcRenderer.invoke('harness:scene-project', payload),
  manifest: (scenes) => ipcRenderer.invoke('harness:manifest', scenes),
  done: (error) => ipcRenderer.invoke('harness:done', error ?? null),
});
