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
    beginJob: () => ipcRenderer.invoke('render:beginJob'),
    stageFrame: (jobId: string, index: number, bytes: Uint8Array, ext?: 'jpg' | 'png') =>
      ipcRenderer.invoke('render:stageFrame', jobId, index, bytes, ext),
    stageAudio: (jobId: string, bytes: Uint8Array) => ipcRenderer.invoke('render:stageAudio', jobId, bytes),
    encode: (jobId: string, opts: unknown) => ipcRenderer.invoke('render:encode', jobId, opts),
    cancel: (jobId: string) => ipcRenderer.invoke('render:cancel', jobId),
    save: (jobId: string, defaultName: string) => ipcRenderer.invoke('render:save', jobId, defaultName),
    saveTo: (jobId: string, dir: string, filename: string) =>
      ipcRenderer.invoke('render:saveTo', jobId, dir, filename),
    chooseOutputDir: () => ipcRenderer.invoke('render:chooseOutputDir'),
    cleanJob: (jobId: string) => ipcRenderer.invoke('render:cleanJob', jobId),
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

  popout: {
    spawnWindow: (panelId: string) => ipcRenderer.invoke('popout:spawnWindow', panelId),
  },

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
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
   * `premation://plugin/<id>` — open a plugin's page.
   *
   * The id was validated in the main process before it was sent, and the
   * renderer validates it AGAIN before using it. That is not belt-and-braces
   * for its own sake: IPC is its own boundary, and the receiving side is about
   * to put the value into a fetch and a store lookup.
   */
  onPluginDeepLink: (handler: (payload: { id: string }) => void) => {
    const listener = (_event: unknown, payload: { id: string }): void => handler(payload);
    ipcRenderer.on('deeplink:plugin', listener);
    return () => ipcRenderer.removeListener('deeplink:plugin', listener);
  },

  onMenuCommand: (handler: (commandId: string) => void) => {
    const listener = (_event: unknown, commandId: string): void => handler(commandId);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
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
};

contextBridge.exposeInMainWorld('motionEditor', bridge);
contextBridge.exposeInMainWorld('electronAPI', bridge);
