/**
 * Preload — the ONLY bridge between the sandboxed renderer and the privileged
 * main process. Exposes a narrow, typed surface on `window.motionEditor`
 * (see src/types/motionEditor.d.ts for the renderer-side contract). Everything
 * here is a thin IPC forwarder; no privileged work happens in the renderer.
 */

import { contextBridge, ipcRenderer, sharedTexture, webUtils } from 'electron';

// ── C++ engine frames (electron/engineHost.ts) ──────────────────────────────
//
// `sharedTexture` is one of the modules a SANDBOXED preload is given
// (Electron ≥ 40; proven in this app's real window by C4's route-C spike),
// and a `VideoFrame` is one of the types contextBridge carries into the page.
// The receiver is installed only when the page asks for frames, and main is
// told so — a transfer to a page without a receiver times out.
//
// Ownership: every texture main sends is released exactly once. With no page
// consumer it is released at once; otherwise the page gets the frame and a
// `release()` it must call after drawing (the engine's ring slot is freed only
// when every process, queued GPU work included, has let go).

type EngineFrameConsumer = (frame: VideoFrame, meta: unknown, release: () => void) => void;
let engineFrameConsumer: EngineFrameConsumer | null = null;
let engineReceiverInstalled = false;

/**
 * Preview resolution: a reduced frame fills only the slot's top-left
 * `contentWidth` × `contentHeight` (FrameReady). The page gets a VideoFrame of
 * that part alone (`visibleRect`: no copy), so its blit and its sizing see
 * the frame's own pixels. `close` closes both frames.
 */
function contentOf(frame: VideoFrame, meta: unknown): { frame: VideoFrame; close: () => void } {
  const m = meta as { contentWidth?: number; contentHeight?: number } | null;
  const w = m?.contentWidth ?? 0;
  const h = m?.contentHeight ?? 0;
  if (!(w > 0 && h > 0) || (w >= frame.codedWidth && h >= frame.codedHeight)) return { frame, close: () => frame.close() };
  try {
    const part = new VideoFrame(frame, { visibleRect: { x: 0, y: 0, width: Math.min(w, frame.codedWidth), height: Math.min(h, frame.codedHeight) } });
    return {
      frame: part,
      close: () => {
        try {
          part.close();
        } finally {
          frame.close();
        }
      },
    };
  } catch {
    return { frame, close: () => frame.close() };
  }
}

function installEngineFrameReceiver(): boolean {
  if (engineReceiverInstalled) return true;
  if (!sharedTexture || typeof sharedTexture.setSharedTextureReceiver !== 'function') return false;
  sharedTexture.setSharedTextureReceiver(async (data, meta: unknown) => {
    const imported = data.importedSharedTexture;
    const consumer = engineFrameConsumer;
    if (!consumer) {
      imported.release();
      return;
    }
    let shown: { frame: VideoFrame; close: () => void };
    try {
      shown = contentOf(imported.getVideoFrame(), meta);
    } catch {
      imported.release();
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        shown.close();
      } finally {
        imported.release();
      }
    };
    try {
      consumer(shown.frame, meta, release);
    } catch {
      release();
    }
  });
  engineReceiverInstalled = true;
  return true;
}

// Route A (docs/VIEWPORT_ROUTE.md): where shared textures do not work, main
// pushes each frame's RGBA8 pixels (`engine:pixels`). They become a VideoFrame
// here, so the page's consumer is the same for both routes; its release()
// closes the frame and tells main the engine's slot is free.
let enginePixelsInstalled = false;

function installEnginePixelReceiver(): boolean {
  if (enginePixelsInstalled) return true;
  if (typeof VideoFrame !== 'function') return false;
  ipcRenderer.on('engine:pixels', (_event: unknown, meta: { generation: number; slot: number; width: number; height: number; renderDoneUs: number; contentWidth?: number; contentHeight?: number }, pixels: Uint8Array) => {
    const free = (): void => ipcRenderer.send('engine:pixelsRelease', meta.generation, meta.slot);
    const consumer = engineFrameConsumer;
    if (!consumer) {
      free();
      return;
    }
    let shown: { frame: VideoFrame; close: () => void };
    try {
      shown = contentOf(
        new VideoFrame(pixels, {
          format: 'RGBA',
          codedWidth: meta.width,
          codedHeight: meta.height,
          timestamp: Math.max(0, Math.trunc(meta.renderDoneUs)),
        }),
        meta,
      );
    } catch {
      free();
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        shown.close();
      } finally {
        free();
      }
    };
    try {
      consumer(shown.frame, meta, release);
    } catch {
      release();
    }
  });
  enginePixelsInstalled = true;
  return true;
}

// ── premation:// links the page acts on (electron/deepLink.ts) ──────────────
//
// Held here, not just forwarded: a COLD start sends one at `did-finish-load`,
// while the page is still behind AppRouter's boot splash (the stored token's
// round trip) and nothing has subscribed yet. Listening from the preload means
// it cannot arrive too early; the first subscriber gets it. One flag, because
// the link carries no data — it only names a destination.
function heldLink(channel: string): (handler: () => void) => () => void {
  const handlers = new Set<() => void>();
  let pending = false;
  ipcRenderer.on(channel, () => {
    if (handlers.size === 0) {
      pending = true;
      return;
    }
    for (const handler of handlers) handler();
  });
  return (handler) => {
    handlers.add(handler);
    if (pending) {
      pending = false;
      // After the subscribing effect has returned, not inside it — and to
      // whoever is subscribed THEN: a StrictMode remount has swapped the
      // handler by the time this runs.
      queueMicrotask(() => {
        if (handlers.size === 0) {
          pending = true;
          return;
        }
        for (const subscribed of handlers) subscribed();
      });
    }
    return () => {
      handlers.delete(handler);
    };
  };
}

const onOpenConnections = heldLink('deepLink:connections');
const onCheckoutReturn = heldLink('deepLink:billing');

const bridge = {
  platform: process.platform,
  version: process.versions.electron,

  project: {
    open: () => ipcRenderer.invoke('project:open'),
    chooseSavePath: (defaultName: string) => ipcRenderer.invoke('project:chooseSavePath', defaultName),
    chooseOpenPath: () => ipcRenderer.invoke('project:chooseOpenPath'),
    openBundleDir: () => ipcRenderer.invoke('project:openBundleDir'),
  },

  // The ML models (electron/models.json, installed by electron/modelInstaller.ts
  // into <userData>/models/<id> where the engine reads them). No credential
  // attached; a download runs only when the page asks. `models` is the whole
  // list for Settings ▸ Models; the per-model bridges below keep their callers.
  models: {
    list: () => ipcRenderer.invoke('models:list'),
    install: (request: { id: string; requestId: string; urls?: string[] }) => ipcRenderer.invoke('models:install', request),
    remove: (id: string) => ipcRenderer.invoke('models:remove', id),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('objectMatte:cancelDownload', requestId),
    onDownloadProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('models:downloadProgress', listener);
      return () => ipcRenderer.removeListener('models:downloadProgress', listener);
    },
  },
  // Face Tracking's landmark model (electron/faceModel.ts), downloaded on first use.
  faceModel: {
    status: () => ipcRenderer.invoke('faceModel:status'),
    install: (request: { url: string; requestId: string }) => ipcRenderer.invoke('faceModel:install', request),
    remove: () => ipcRenderer.invoke('faceModel:remove'),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('objectMatte:cancelDownload', requestId),
    onDownloadProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('faceModel:downloadProgress', listener);
      return () => ipcRenderer.removeListener('faceModel:downloadProgress', listener);
    },
  },
  // Make 3D from Photo's depth model (electron/depthModel.ts): a PINNED download on first use.
  depthModel: {
    status: () => ipcRenderer.invoke('depthModel:status'),
    install: (request: { requestId: string }) => ipcRenderer.invoke('depthModel:install', request),
    remove: () => ipcRenderer.invoke('depthModel:remove'),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('objectMatte:cancelDownload', requestId),
    onDownloadProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('depthModel:downloadProgress', listener);
      return () => ipcRenderer.removeListener('depthModel:downloadProgress', listener);
    },
  },
  // Live performance input's hand models (electron/handModel.ts): a PINNED download on first use.
  handModel: {
    status: () => ipcRenderer.invoke('handModel:status'),
    install: (request: { requestId: string }) => ipcRenderer.invoke('handModel:install', request),
    remove: () => ipcRenderer.invoke('handModel:remove'),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('objectMatte:cancelDownload', requestId),
    onDownloadProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('handModel:downloadProgress', listener);
      return () => ipcRenderer.removeListener('handModel:downloadProgress', listener);
    },
  },
  // Object Matte walks' SAM 2.1 video model (models.json `sam2-video`, electron/modelInstaller.ts): a PINNED download on first use.
  sam2Model: {
    status: () => ipcRenderer.invoke('sam2Model:status'),
    install: (request: { requestId: string }) => ipcRenderer.invoke('sam2Model:install', request),
    remove: () => ipcRenderer.invoke('sam2Model:remove'),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('objectMatte:cancelDownload', requestId),
    onDownloadProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('sam2Model:downloadProgress', listener);
      return () => ipcRenderer.removeListener('sam2Model:downloadProgress', listener);
    },
  },
  // Refine Edge's learned matting model (models.json `vitmatte`, electron/modelInstaller.ts): a PINNED download on first use.
  vitmatteModel: {
    status: () => ipcRenderer.invoke('vitmatteModel:status'),
    install: (request: { requestId: string }) => ipcRenderer.invoke('vitmatteModel:install', request),
    remove: () => ipcRenderer.invoke('vitmatteModel:remove'),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('objectMatte:cancelDownload', requestId),
    onDownloadProgress: (handler: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('vitmatteModel:downloadProgress', listener);
      return () => ipcRenderer.removeListener('vitmatteModel:downloadProgress', listener);
    },
  },
  // Export's ffmpeg: health, one-click repair, "choose file" (electron/ffmpegService.ts).
  ffmpeg: {
    status: (force?: boolean) => ipcRenderer.invoke('ffmpeg:status', force === true),
    repair: () => ipcRenderer.invoke('ffmpeg:repair'),
    cancelRepair: () => ipcRenderer.invoke('ffmpeg:cancelRepair'),
    chooseFile: () => ipcRenderer.invoke('ffmpeg:chooseFile'),
    clearChoice: () => ipcRenderer.invoke('ffmpeg:clearChoice'),
    onStatus: (handler: (status: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('ffmpeg:statusChanged', listener);
      return () => ipcRenderer.removeListener('ffmpeg:statusChanged', listener);
    },
    onRepairProgress: (handler: (progress: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('ffmpeg:repairProgress', listener);
      return () => ipcRenderer.removeListener('ffmpeg:repairProgress', listener);
    },
  },
  objectMatte: {
    status: () => ipcRenderer.invoke('objectMatte:status'),
    install: (request: { encoderUrl: string; decoderUrl: string; requestId: string }) =>
      ipcRenderer.invoke('objectMatte:install', request),
    remove: () => ipcRenderer.invoke('objectMatte:remove'),
    cancelDownload: (requestId: string) => ipcRenderer.invoke('objectMatte:cancelDownload', requestId),
    onDownloadProgress: (handler: (event: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('objectMatte:downloadProgress', listener);
      return () => ipcRenderer.removeListener('objectMatte:downloadProgress', listener);
    },
  },

  file: {
    /**
     * The disk path of a picked / dropped `File`, or '' when it has none (made
     * in the page, or a transcode). Replaces `File.path`, which Electron 32
     * removed; `webUtils` is given to sandboxed preloads and runs here, in the
     * page's process, so no IPC and no privilege is involved.
     */
    pathOf: (file: File): string => webUtils.getPathForFile(file),
    read: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
    write: (filePath: string, contents: string) => ipcRenderer.invoke('file:write', filePath, contents),
    readBytes: (filePath: string) => ipcRenderer.invoke('file:readBytes', filePath),
    writeBytes: (filePath: string, bytes: Uint8Array) =>
      ipcRenderer.invoke('file:writeBytes', filePath, bytes),
    sessionFootageDir: () => ipcRenderer.invoke('file:sessionFootageDir'),
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

  media: {
    /** Real stream facts for an imported file (frame rate, audio track, codec).
     *  Resolves null when ffprobe/ffmpeg is not installed — callers degrade. */
    probe: (bytes: Uint8Array, ext: string) => ipcRenderer.invoke('media:probe', bytes, ext),
    /** Transcode a file to an editing proxy. Resolves null when ffmpeg is
     *  missing or the encode failed/was cancelled — callers stay at full res. */
    generateProxy: (assetId: string, bytes: Uint8Array, ext: string, args: string[], outExt: string) =>
      ipcRenderer.invoke('proxy:generate', assetId, bytes, ext, args, outExt),
    /** Kill a running proxy encode. True if one was actually running. */
    cancelProxy: (assetId: string) => ipcRenderer.invoke('proxy:cancel', assetId),
    /** The OS microphone switch (electron/ipc/mediaAccess.ts) — no prompt. */
    microphoneStatus: () => ipcRenderer.invoke('mic:status'),
    /** Ask the OS for the microphone (macOS prompts once); resolves to the status after. */
    requestMicrophone: () => ipcRenderer.invoke('mic:request'),
  },

  render: {
    /** Hardware encoders that pass a smoke encode on this machine (cached per session). */
    probeEncoders: () => ipcRenderer.invoke('render:probeEncoders'),
    chooseOutputDir: () => ipcRenderer.invoke('render:chooseOutputDir'),
  },

  /**
   * The export queue main owns (electron/exportProcess.ts) — the EDITOR's side.
   *
   * A job is a project snapshot on disk plus a spec; main renders it in a
   * hidden window of its own and pushes `ExportQueueEvent`s to every window
   * that subscribed. The editor never holds a frame, a sink or a window: it
   * enqueues and watches, and can be closed or crash without the job noticing.
   */
  exportSupervisor: {
    /** An id and a snapshot path the editor writes the project to before enqueueing. */
    reserve: () => ipcRenderer.invoke('export:reserve'),
    enqueue: (req: { id?: string; spec: unknown; priority?: number }) => ipcRenderer.invoke('export:enqueue', req),
    cancel: (id: string) => ipcRenderer.invoke('export:cancel', id),
    retry: (id: string) => ipcRenderer.invoke('export:retry', id),
    setPriority: (id: string, priority: number) => ipcRenderer.invoke('export:setPriority', id, priority),
    remove: (id: string) => ipcRenderer.invoke('export:remove', id),
    list: () => ipcRenderer.invoke('export:list'),
    /** F1: `{ engineExport, bitDepth16 }` — what a job may ask for (the engine export flag). */
    capabilities: () => ipcRenderer.invoke('export:capabilities'),
    /** Start receiving `onEvent` pushes; resolves the current list. */
    subscribe: () => ipcRenderer.invoke('export:subscribe'),
    /** Native save dialog for the destination, asked BEFORE the render. */
    chooseOutputPath: (defaultName: string) => ipcRenderer.invoke('export:chooseOutputPath', defaultName),
    onEvent: (handler: (event: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('export:event', listener);
      return () => ipcRenderer.removeListener('export:event', listener);
    },
  },

  diag: {
    /** One-off GPU/WebGPU report from the renderer, appended to
     *  <userData>/gpu-diagnostics.log so a packaged build with DevTools disabled
     *  can still be diagnosed. Fire-and-forget. */
    gpuReport: (report: unknown) => ipcRenderer.send('diag:gpuReport', report),
    /** Help ▸ Open Logs Folder: reveals <userData>/logs/engine.log. */
    openLogs: () => ipcRenderer.invoke('diag:openLogs'),
    /** Help ▸ Copy Diagnostics Report: the machine, GPU and log tails onto the clipboard (main confirms with a message box). */
    copyReport: () => ipcRenderer.invoke('diag:copyReport'),
    /** Help ▸ Report a Problem: build, OS, GPU, engine state and a path-scrubbed engine.log tail. */
    problemDiagnostics: () => ipcRenderer.invoke('report:diagnostics'),
    /** Help ▸ Report a Problem: PNG bytes of one rectangle of this window (the viewer). */
    captureViewport: (rect: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke('report:captureViewport', rect),
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

  thumbs: {
    write: (hash: string, bytes: Uint8Array) => ipcRenderer.invoke('thumb:write', hash, bytes),
    read: (hash: string) => ipcRenderer.invoke('thumb:read', hash),
  },

  /** Disk-facing verbs for the Assets panel — see electron/ipc/reveal.ts. */
  shell: {
    revealInFolder: (filePath: string) => ipcRenderer.invoke('shell:revealInFolder', filePath),
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
    /** Paths of the files copied in the OS file manager (Edit ▸ Paste of footage). */
    readClipboardFiles: () => ipcRenderer.invoke('clipboard:readFiles'),
    listDir: (dir: string) => ipcRenderer.invoke('fs:listDir', dir),
    /** The Media Browser's on-screen folders, watched; a change arrives through `onDirsChanged`. */
    watchDirs: (dirs: string[]) => ipcRenderer.invoke('fs:watchDirs', dirs),
    onDirsChanged: (handler: (dirs: string[]) => void) => {
      const listener = (_event: unknown, dirs: string[]): void => handler(dirs);
      ipcRenderer.on('fs:dirsChanged', listener);
      return () => ipcRenderer.removeListener('fs:dirsChanged', listener);
    },
    /** Edit ▸ Edit Original: the file in the OS default app for its type (electron/ipc/footageFiles.ts). */
    openFile: (filePath: string) => ipcRenderer.invoke('shell:openFile', filePath),
  },

  /** Footage file watching for the reload after Edit Original — see electron/ipc/footageFiles.ts. */
  footage: {
    watch: (req: { paths: string[]; priority: string[] }) => ipcRenderer.invoke('footage:watch', req),
    check: () => ipcRenderer.invoke('footage:check'),
    onChanged: (handler: (paths: string[]) => void) => {
      const listener = (_event: unknown, paths: string[]): void => handler(paths);
      ipcRenderer.on('footage:changed', listener);
      return () => ipcRenderer.removeListener('footage:changed', listener);
    },
  },

  /** File ▸ Scripts and the Script Editor — see electron/ipc/scripts.ts. */
  scripts: {
    folderPath: () => ipcRenderer.invoke('scripts:folderPath'),
    list: () => ipcRenderer.invoke('scripts:list'),
    openFolder: () => ipcRenderer.invoke('scripts:openFolder'),
    read: (name: string) => ipcRenderer.invoke('scripts:read', name),
    pick: () => ipcRenderer.invoke('scripts:pick'),
    save: (req: { name?: string; path?: string; source: string }) => ipcRenderer.invoke('scripts:save', req),
    saveAs: (req: { name?: string; source: string }) => ipcRenderer.invoke('scripts:saveAs', req),
  },

  /** The preview disk cache's default folder — see electron/ipc/diskCache.ts. */
  diskCache: {
    defaultFolder: () => ipcRenderer.invoke('cache:defaultFolder'),
    /** Volumes with their free / total space (the Cache & Memory panel's Location tab). */
    drives: () => ipcRenderer.invoke('cache:drives'),
  },

  /** The native plugins folder — see electron/ipc/nativePlugins.ts. */
  plugins: {
    openNativeFolder: () => ipcRenderer.invoke('plugins:openNativeFolder'),
    nativeFolderPath: () => ipcRenderer.invoke('plugins:nativeFolderPath'),
    // The plugin store: main downloads, verifies and installs (docs/PLUGIN_STORE.md §4).
    install: (req: { id: string; version: string; owner?: boolean }) => ipcRenderer.invoke('plugins:install', req),
    uninstall: (id: string) => ipcRenderer.invoke('plugins:uninstall', id),
    setEnabled: (req: { id: string; enabled: boolean }) => ipcRenderer.invoke('plugins:setEnabled', req),
    installed: () => ipcRenderer.invoke('plugins:installed'),
    // Install from a `.pplugin` file (electron/pluginFileInstall.ts): main reads and checks it, the page confirms.
    pickPackageFile: () => ipcRenderer.invoke('plugins:pickPackageFile'),
    installPackageFile: (req: { token: string; allowUnknown?: boolean }) => ipcRenderer.invoke('plugins:installPackageFile', req),
    takeOpenedPackages: () => ipcRenderer.invoke('plugins:takeOpenedPackages'),
    // Premation Cloud: refresh the entitlement token now (after an upgrade), or read its status.
    refreshEntitlement: () => ipcRenderer.invoke('plugins:refreshEntitlement'),
    entitlement: () => ipcRenderer.invoke('plugins:entitlement'),
    onPackageOpened: (handler: () => void) => {
      const listener = (): void => handler();
      ipcRenderer.on('plugins:packageOpened', listener);
      return () => ipcRenderer.removeListener('plugins:packageOpened', listener);
    },
    /** Which binaries this machine loads (docs/PLUGIN_STORE.md §1): the store greys out the rest. */
    host: { platform: process.platform, arch: process.arch },
  },

  /** Premium library payloads — main downloads, verifies and keeps them (electron/ipc/libraryCache.ts). */
  library: {
    payload: (req: { id: string; version: number; tier: 'free' | 'cloud' }) => ipcRenderer.invoke('library:payload', req),
    devCatalog: () => ipcRenderer.invoke('library:devCatalog'),
  },

  popout: {
    spawnWindow: (panelId: string) => ipcRenderer.invoke('popout:spawnWindow', panelId),
    close: (panelId: string) => ipcRenderer.invoke('popout:close', panelId),
    list: () => ipcRenderer.invoke('popout:list'),
    onClosed: (handler: (panelId: string) => void) => {
      const listener = (_event: unknown, panelId: string): void => handler(panelId);
      ipcRenderer.on('popout:closed', listener);
      return () => ipcRenderer.removeListener('popout:closed', listener);
    },
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    setTitleBarOverlay: (colors: { color: string; symbolColor: string }) =>
      ipcRenderer.invoke('window:setTitleBarOverlay', colors),
  },

  app: {
    quit: () => ipcRenderer.invoke('app:quit'),
    version: () => ipcRenderer.invoke('app:version'),
    takeRendererGone: () => ipcRenderer.invoke('app:takeRendererGone'),
  },

  /**
   * Authenticated calls to our own backend.
   *
   * Note what is NOT here, and note that it matches `ai.keys` exactly: there is
   * no way to read the session token. There used to be — `credentials.get` —
   * and it made every other protection around that token beside the point, for
   * the same reason a read-back verb would make the AI key vault pointless. A
   * renderer that can ask for the secret is a renderer that holds the secret.
   *
   * So the renderer asks for OPERATIONS. `request` takes a PATH, not a URL:
   * main resolves the base itself and refuses anything that would land
   * elsewhere (electron/apiBase.ts). A general `fetch(url, init)` bridge would
   * be an open relay with the user's bearer attached, callable by anything in
   * the renderer, which is the hole this replaced.
   */
  api: {
    /** Buffered. Resolves `{ok, status, headers, body}` — never a token. */
    request: (req: unknown) => ipcRenderer.invoke('api:request', req),
    /** Resolves once the response headers are in; body follows as events. */
    stream: (req: unknown) => ipcRenderer.invoke('api:stream', req),
    /** Aborts the UPSTREAM request, not just our interest in it. */
    cancel: (requestId: string) => ipcRenderer.invoke('api:cancel', requestId),
    /**
     * Body chunks, in order, for every in-flight stream. Callers filter by
     * `requestId` — one channel rather than one per request, so a stream that
     * ends without a `done` cannot leak a listener.
     */
    onStreamEvent: (handler: (event: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('api:stream:event', listener);
      return () => ipcRenderer.removeListener('api:stream:event', listener);
    },
  },

  /**
   * Session state and the two operations that change it.
   *
   * `status` returns claims — signed in, who, when the access token expires,
   * whether it will survive a restart — and never a credential. `persisted` is
   * false when the OS has no keystore: the session then works until the app
   * closes, which is stated rather than silently degrading to plaintext.
   */
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    signIn: (payload: unknown) => ipcRenderer.invoke('auth:signIn', payload),
    signOut: () => ipcRenderer.invoke('auth:signOut'),
    /**
     * One-way migration for a session created before Track A, when the refresh
     * token lived in renderer `localStorage`.
     *
     * Note the direction: the renderer hands a credential IN and gets a status
     * back. It still cannot ask for one out, which is the difference between
     * this and the `credentials.get` it replaced.
     */
    adoptLegacy: (refreshToken: string) => ipcRenderer.invoke('auth:adoptLegacy', refreshToken),
  },

  /**
   * The assistant, for the local edition — no backend, so the shell holds the
   * keys and makes the calls (electron/aiKeyVault.ts, electron/aiProxy.ts).
   *
   * Note what is NOT here: any way to read a key back. `keys.set` and
   * `keys.clear` write; `keys.status` returns presence and a masked tail. The
   * renderer never holds a provider key, which is why a compromised renderer can
   * spend one but cannot steal one.
   *
   * The server edition ignores all of this and posts to the backend gateway
   * instead — see `aiTransport` on the renderer side, which picks by capability.
   */
  ai: {
    keys: {
      status: () => ipcRenderer.invoke('aiKeys:status'),
      set: (provider: string, key: string) => ipcRenderer.invoke('aiKeys:set', provider, key),
      /** Omit `provider` to forget every key at once. */
      clear: (provider?: string) => ipcRenderer.invoke('aiKeys:clear', provider ?? null),
      /** False when the OS has no keystore — the app then never persists a key. */
      available: () => ipcRenderer.invoke('aiKeys:available'),
    },
    /** Begin a completion. Resolves once the provider's headers are in. */
    stream: (request: unknown) => ipcRenderer.invoke('ai:stream', request),
    cancel: (requestId: string) => ipcRenderer.invoke('ai:cancel', requestId),
    /**
     * Body chunks, in order, for every in-flight stream. Callers filter by
     * `requestId` — one channel rather than one per request, so a stream that
     * ends without a `done` cannot leak a listener.
     */
    onStreamEvent: (handler: (event: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload);
      ipcRenderer.on('ai:stream:event', listener);
      return () => ipcRenderer.removeListener('ai:stream:event', listener);
    },
    /** One image as base64 bytes. Counterpart to motion-back `POST /ai/image`. */
    image: (request: unknown) => ipcRenderer.invoke('ai:image', request),
    video: (request: unknown) => ipcRenderer.invoke('ai:video', request),
    speech: (request: unknown) => ipcRenderer.invoke('ai:speech', request),
    model3d: (request: unknown) => ipcRenderer.invoke('ai:3d', request),
    mediaKeys: {
      status: () => ipcRenderer.invoke('mediaKeys:status'),
      set: (provider: string, key: string) => ipcRenderer.invoke('mediaKeys:set', provider, key),
      clear: (provider?: string) => ipcRenderer.invoke('mediaKeys:clear', provider ?? null),
      available: () => ipcRenderer.invoke('mediaKeys:available'),
    },
  },

  /**
   * Provider sign-in (Google/GitHub) for the desktop app.
   *
   * `openExternal` opens the backend's OAuth start URL in the SYSTEM browser —
   * Google refuses to run its consent screen inside an Electron window.
   * `onResult` delivers the one-time code (or an error) once the backend bounces
   * it back through the premation:// deep link. See src/pages/OAuthCallbackPage.
   */
  oauth: {
    openExternal: (url: string) => ipcRenderer.invoke('oauth:openExternal', url),
    onResult: (handler: (result: { code?: string; error?: string }) => void) => {
      const listener = (_event: unknown, payload: { code?: string; error?: string }): void =>
        handler(payload);
      ipcRenderer.on('oauth:result', listener);
      return () => ipcRenderer.removeListener('oauth:result', listener);
    },
  },

  /**
   * premation:// links the page acts on (other than `oauth`). Main has already
   * restored and focused the window; the page picks the screen — see
   * src/hooks/useConnectionsDeepLink.ts and useCheckoutReturn.ts. A link that
   * arrived before anything subscribed is delivered to the first subscriber, once.
   */
  deepLink: {
    onOpenConnections,
    onCheckoutReturn,
  },

  onMenuCommand: (handler: (commandId: string) => void) => {
    const listener = (_event: unknown, commandId: string): void => handler(commandId);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },

  /**
   * The renderer's serialised menu model — main rebuilds the native menu from
   * it (see `electron/nativeMenu.ts`). Plain data only; main validates it.
   */
  setMenuTemplate: (template: unknown, strings?: unknown) => ipcRenderer.invoke('menu:setTemplate', template, strings),

  /**
   * Auto-update, as the renderer sees it.
   *
   * Read-and-act only: the renderer can observe progress, flip the
   * download-on-its-own setting, and ask to restart into a downloaded update.
   * It cannot point the updater at a different release feed — that comes from
   * the build's publish config and stays in main.
   */
  updates: {
    /** Current status, for a renderer that mounted after the last event. */
    getStatus: () => ipcRenderer.invoke('updater:getStatus'),
    /** Live status pushes. Returns an unsubscribe. */
    onStatus: (handler: (status: unknown) => void) => {
      const listener = (_event: unknown, status: unknown): void => handler(status);
      ipcRenderer.on('updater:status', listener);
      return () => ipcRenderer.removeListener('updater:status', listener);
    },
    getSettings: () => ipcRenderer.invoke('updater:getSettings'),
    setAutoDownload: (enabled: boolean) => ipcRenderer.invoke('updater:setAutoDownload', enabled),
    /** Check now (Settings' "Check for updates"). */
    check: () => ipcRenderer.invoke('updater:check'),
    /** Fetch an update the user declined to auto-download. */
    downloadNow: () => ipcRenderer.invoke('updater:downloadNow'),
    /** Quit into the installer and come back. */
    restartAndInstall: () => ipcRenderer.invoke('updater:restartAndInstall'),
    /** The update dialog's check (Help ▸ Check for Updates…): fetches, and says "up to date". */
    checkInteractive: () => ipcRenderer.invoke('updater:checkInteractive'),
    /** Help ▸ Check for Updates… was chosen. Returns an unsubscribe. */
    onOpenDialog: (handler: () => void) => {
      const listener = (): void => handler();
      ipcRenderer.on('updater:openDialog', listener);
      return () => ipcRenderer.removeListener('updater:openDialog', listener);
    },
    /** `{ from, to }` once, on the first launch after an upgrade; null otherwise. */
    takeJustUpdated: () => ipcRenderer.invoke('updater:takeJustUpdated'),
  },

  /**
   * Tell the main process which edition the RENDERER thinks it is.
   *
   * Diagnostic only. Main does not take its edition from this and must not: the
   * renderer is the untrusted side of this boundary, so an edition it could
   * assert is an edition a compromised one could assert to unlock AI IPC. Main
   * resolves its own (electron/edition.ts) and only compares.
   *
   * It exists because the two answers come from different build inputs —
   * VITE_EDITION for the renderer, MOTION_EDITION or the packaged manifest for
   * main — and a build where they disagree is exactly the failure the edition
   * gate is meant to prevent. A test asserts the npm scripts set both halves;
   * this catches the packaged build where they somehow still did not.
   */
  reportEdition: (edition: string) => ipcRenderer.invoke('edition:report', edition),

  /**
   * Claude for Premation (docs/MCP_PLAN.md; electron/mcp/). Settings drives the
   * setup; the editor page runs the tool calls main relays from the MCP pipe.
   */
  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
    connect: () => ipcRenderer.invoke('mcp:connect'),
    connectConfig: () => ipcRenderer.invoke('mcp:connectConfig'),
    revealExtension: () => ipcRenderer.invoke('mcp:revealExtension'),
    enable: () => ipcRenderer.invoke('mcp:enable'),
    disconnect: () => ipcRenderer.invoke('mcp:disconnect'),
    repair: () => ipcRenderer.invoke('mcp:repair'),
    connectApp: (id: string) => ipcRenderer.invoke('mcp:connectApp', id),
    disconnectApp: (id: string) => ipcRenderer.invoke('mcp:disconnectApp', id),
    test: () => ipcRenderer.invoke('mcp:test'),
    getClaude: () => ipcRenderer.invoke('mcp:getClaude'),
    onStatus: (handler: (status: unknown) => void) => {
      const listener = (_event: unknown, status: unknown): void => handler(status);
      ipcRenderer.on('mcp:status', listener);
      return () => ipcRenderer.removeListener('mcp:status', listener);
    },
    /** The editor page can (or can no longer) take Claude's calls. */
    setPageReady: (ready: boolean) => ipcRenderer.send('mcp:pageReady', ready),
    onCall: (handler: (call: { id: number; clientId: number; name: string; args: unknown }) => void) => {
      const listener = (_event: unknown, call: { id: number; clientId: number; name: string; args: unknown }): void => handler(call);
      ipcRenderer.on('mcp:call', listener);
      return () => ipcRenderer.removeListener('mcp:call', listener);
    },
    onClients: (handler: (clientIds: number[]) => void) => {
      const listener = (_event: unknown, ids: number[]): void => handler(ids);
      ipcRenderer.on('mcp:clients', listener);
      return () => ipcRenderer.removeListener('mcp:clients', listener);
    },
    respond: (id: number, result: unknown) => ipcRenderer.invoke('mcp:result', id, result),
  },

  /**
   * The C++ engine process (NATIVE_CORE_PLAN C3; electron/engineHost.ts). Bytes
   * in, bytes out: the page's ProcessEngineClient owns the codec, main relays.
   * The engine is the only one; `engine:unavailable` says it cannot run (main
   * also shows the dialog — electron/engineUnavailable.ts).
   */
  engine: {
    request: (bytes: Uint8Array) => ipcRenderer.invoke('engine:request', bytes),
    /** Restart the engine on purpose to give its memory back (the document is replayed). */
    restartToFreeMemory: (): Promise<boolean> => ipcRenderer.invoke('engine:restartToFreeMemory').catch(() => false),
    // No handler = no engine host in this process.
    status: () =>
      ipcRenderer.invoke('engine:status').catch(() => ({ enabled: false, state: 'stopped' })),
    /** C: this window's first engine viewport id (0 in the editor, a block of its own in a pop-out). */
    viewportBase: (): Promise<number> =>
      ipcRenderer.invoke('engine:viewportBase').then((n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0), () => 0),
    onEvents: (handler: (bytes: Uint8Array, meta?: { foreign?: boolean }) => void) => {
      // F2: `foreign` = caused by another window's request (a pop-out's edit in the editor, or back).
      const listener = (_event: unknown, bytes: Uint8Array, meta?: { foreign?: boolean }): void => handler(bytes, meta);
      ipcRenderer.on('engine:events', listener);
      return () => ipcRenderer.removeListener('engine:events', listener);
    },
    onState: (handler: (state: string) => void) => {
      const listener = (_event: unknown, state: string): void => handler(state);
      ipcRenderer.on('engine:state', listener);
      return () => ipcRenderer.removeListener('engine:state', listener);
    },
    onRestarted: (handler: (info: unknown) => void) => {
      const listener = (_event: unknown, info: unknown): void => handler(info);
      ipcRenderer.on('engine:restarted', listener);
      return () => ipcRenderer.removeListener('engine:restarted', listener);
    },
    /** The engine's core thread is busy on one item ({ what, ms }), or back (null). */
    onBusy: (handler: (info: unknown) => void) => {
      const listener = (_event: unknown, info: unknown): void => handler(info);
      ipcRenderer.on('engine:busy', listener);
      return () => ipcRenderer.removeListener('engine:busy', listener);
    },
    onUnavailable: (handler: (info: unknown) => void) => {
      const listener = (_event: unknown, info: unknown): void => handler(info);
      ipcRenderer.on('engine:unavailable', listener);
      return () => ipcRenderer.removeListener('engine:unavailable', listener);
    },
    /** Engine frames (shared textures, or route-A copies as VideoFrames); null stops. The consumer must `release()` each frame. */
    onFrame: (consumer: EngineFrameConsumer | null) => {
      engineFrameConsumer = consumer;
      const ready = consumer !== null && installEngineFrameReceiver();
      const copyReady = consumer !== null && installEnginePixelReceiver();
      ipcRenderer.send('engine:receiverReady', ready, copyReady);
    },
  },
};

contextBridge.exposeInMainWorld('motionEditor', bridge);
contextBridge.exposeInMainWorld('electronAPI', bridge);
