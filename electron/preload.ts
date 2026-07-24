/**
 * Preload — the ONLY bridge between the sandboxed renderer and the privileged
 * main process. Exposes a narrow, typed surface on `window.motionEditor`
 * (see src/types/motionEditor.d.ts for the renderer-side contract). Everything
 * here is a thin IPC forwarder; no privileged work happens in the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';

const bridge = {
  platform: process.platform,
  version: process.versions.electron,

  project: {
    open: () => ipcRenderer.invoke('project:open'),
    chooseSavePath: (defaultName: string) => ipcRenderer.invoke('project:chooseSavePath', defaultName),
    openBundleDir: () => ipcRenderer.invoke('project:openBundleDir'),
  },

  file: {
    read: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
    write: (filePath: string, contents: string) => ipcRenderer.invoke('file:write', filePath, contents),
  },

  bundle: {
    read: (root: string, name: string) => ipcRenderer.invoke('bundle:read', root, name),
    writeAtomic: (root: string, name: string, contents: string) =>
      ipcRenderer.invoke('bundle:writeAtomic', root, name, contents),
    remove: (root: string, name: string) => ipcRenderer.invoke('bundle:remove', root, name),
    list: (root: string) => ipcRenderer.invoke('bundle:list', root),
  },

  blob: {
    has: (root: string, hash: string) => ipcRenderer.invoke('blob:has', root, hash),
    read: (root: string, hash: string) => ipcRenderer.invoke('blob:read', root, hash),
    write: (root: string, hash: string, bytes: Uint8Array) => ipcRenderer.invoke('blob:write', root, hash, bytes),
    remove: (root: string, hash: string) => ipcRenderer.invoke('blob:remove', root, hash),
    list: (root: string) => ipcRenderer.invoke('blob:list', root),
  },

  render: {
    beginJob: () => ipcRenderer.invoke('render:beginJob'),
    stageFrame: (jobId: string, index: number, bytes: Uint8Array) =>
      ipcRenderer.invoke('render:stageFrame', jobId, index, bytes),
    stageAudio: (jobId: string, bytes: Uint8Array) => ipcRenderer.invoke('render:stageAudio', jobId, bytes),
    muxMp4: (jobId: string, opts: { fps: number; hasAudio?: boolean }) =>
      ipcRenderer.invoke('render:muxMp4', jobId, opts),
    cleanJob: (jobId: string) => ipcRenderer.invoke('render:cleanJob', jobId),
  },

  index: {
    available: () => ipcRenderer.invoke('index:available'),
    upsertProject: (row: unknown) => ipcRenderer.invoke('index:upsertProject', row),
    getProject: (id: string) => ipcRenderer.invoke('index:getProject', id),
    listProjects: (opts?: unknown) => ipcRenderer.invoke('index:listProjects', opts),
    removeProject: (id: string) => ipcRenderer.invoke('index:removeProject', id),
    markMissing: (id: string, missing: boolean) => ipcRenderer.invoke('index:markMissing', id, missing),
    addRecovery: (row: unknown) => ipcRenderer.invoke('index:addRecovery', row),
    listRecovery: (projectId: string) => ipcRenderer.invoke('index:listRecovery', projectId),
    clearRecovery: (projectId: string) => ipcRenderer.invoke('index:clearRecovery', projectId),
  },

  popout: {
    spawnWindow: (panelId: string) => ipcRenderer.invoke('popout:spawnWindow', panelId),
  },

  getMonitors: () => ipcRenderer.invoke('monitors:get'),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },

  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    version: () => ipcRenderer.invoke('app:version'),
  },

  onMenuCommand: (handler: (commandId: string) => void) => {
    const listener = (_event: unknown, commandId: string): void => handler(commandId);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },

  // NOTE: there is deliberately no `ai` surface here any more. AI runs through
  // the backend gateway (POST /ai/stream) with keys stored server-side — the
  // desktop shell holds no AI privileges at all.
};

contextBridge.exposeInMainWorld('motionEditor', bridge);
contextBridge.exposeInMainWorld('electronAPI', bridge);
