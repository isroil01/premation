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
    let frame: VideoFrame;
    try {
      frame = imported.getVideoFrame();
    } catch {
      imported.release();
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        frame.close();
      } finally {
        imported.release();
      }
    };
    try {
      consumer(frame, meta, release);
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
  ipcRenderer.on('engine:pixels', (_event: unknown, meta: { generation: number; slot: number; width: number; height: number; renderDoneUs: number }, pixels: Uint8Array) => {
    const free = (): void => ipcRenderer.send('engine:pixelsRelease', meta.generation, meta.slot);
    const consumer = engineFrameConsumer;
    if (!consumer) {
      free();
      return;
    }
    let frame: VideoFrame;
    try {
      frame = new VideoFrame(pixels, {
        format: 'RGBA',
        codedWidth: meta.width,
        codedHeight: meta.height,
        timestamp: Math.max(0, Math.trunc(meta.renderDoneUs)),
      });
    } catch {
      free();
      return;
    }
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try {
        frame.close();
      } finally {
        free();
      }
    };
    try {
      consumer(frame, meta, release);
    } catch {
      release();
    }
  });
  enginePixelsInstalled = true;
  return true;
}

const bridge = {
  platform: process.platform,
  version: process.versions.electron,

  project: {
    open: () => ipcRenderer.invoke('project:open'),
    chooseSavePath: (defaultName: string) => ipcRenderer.invoke('project:chooseSavePath', defaultName),
    chooseOpenPath: () => ipcRenderer.invoke('project:chooseOpenPath'),
    openBundleDir: () => ipcRenderer.invoke('project:openBundleDir'),
  },

  // The user's Object Matte model: main downloads it into <userData> where the
  // engine reads it (electron/objectMatteModel.ts). No credential attached; it
  // runs only on an explicit Install press.
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
    listDir: (dir: string) => ipcRenderer.invoke('fs:listDir', dir),
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
    onPackageOpened: (handler: () => void) => {
      const listener = (): void => handler();
      ipcRenderer.on('plugins:packageOpened', listener);
      return () => ipcRenderer.removeListener('plugins:packageOpened', listener);
    },
    /** Which binaries this machine loads (docs/PLUGIN_STORE.md §1): the store greys out the rest. */
    host: { platform: process.platform, arch: process.arch },
  },

  popout: {
    spawnWindow: (panelId: string) => ipcRenderer.invoke('popout:spawnWindow', panelId),
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

  onMenuCommand: (handler: (commandId: string) => void) => {
    const listener = (_event: unknown, commandId: string): void => handler(commandId);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },

  /**
   * The renderer's serialised menu model — main rebuilds the native menu from
   * it (see `electron/nativeMenu.ts`). Plain data only; main validates it.
   */
  setMenuTemplate: (template: unknown) => ipcRenderer.invoke('menu:setTemplate', template),

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
   * The C++ engine process (NATIVE_CORE_PLAN C3; electron/engineHost.ts). Bytes
   * in, bytes out: the page's ProcessEngineClient owns the codec, main relays.
   * The engine is the only one; `engine:unavailable` says it cannot run (main
   * also shows the dialog — electron/engineUnavailable.ts).
   */
  engine: {
    request: (bytes: Uint8Array) => ipcRenderer.invoke('engine:request', bytes),
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
