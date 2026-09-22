'use strict';
/* global window -- Electron preload: runs in the page's world (contextIsolation off in this host) */
// Prototype preload (contextIsolation is off in this host only — route C's
// VideoFrame cannot cross a contextBridge). Exposes a tiny `host` API.
const electron = require('electron');

const { ipcRenderer } = electron;
let framePort = null;
let framePortCb = null;
ipcRenderer.on('frame-port', (e) => {
  framePort = e.ports[0];
  if (framePortCb) framePortCb(framePort);
});

const st = electron.sharedTexture; // Electron >= 40

window.host = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  send: (channel, value) => ipcRenderer.send(channel, value),
  on: (channel, cb) => ipcRenderer.on(channel, (_e, value) => cb(value)),
  onFramePort: (cb) => {
    framePortCb = cb;
    if (framePort) cb(framePort);
  },
  sharedTexture: st ? { setReceiver: (cb) => st.setSharedTextureReceiver(cb) } : null,
};
