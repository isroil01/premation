/**
 * The preload bridge surface (`window.motionEditor`) — the single, shared
 * contract between the Electron main process and the renderer. Preload,
 * FileManager, and the menu wiring all reference THIS type, so the shape can
 * never drift between the two sides of the IPC boundary.
 *
 * Every member is optional: in a plain browser build `window.motionEditor` is
 * undefined and the app degrades to its web adapters.
 */

export interface MotionEditorFile {
  path: string;
  name: string;
  contents: string;
}

/** What the desktop shell persists for a signed-in user. Never the password. */
/** What an ffprobe pass can tell us about an imported file. Every field is
 *  nullable: a probe that ran but could not determine a value must say so
 *  rather than guess, because the whole point is to stop guessing. */
export interface MediaProbeResult {
  container: string | null;
  durationSec: number | null;
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    par: number | null;
    /** Source carries an alpha channel (pix_fmt or the container alpha_mode tag). */
    hasAlpha: boolean;
  } | null;
  audio: {
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
  } | null;
}

/** Providers the desktop key vault will hold a key for. */
export type AiVaultProvider = 'openai' | 'anthropic' | 'gemini';

export interface AiKeyStatus {
  present: boolean;
  /** e.g. "sk-…4f2a". Enough to tell two keys apart, useless as a credential. */
  hint: string;
}

export interface AiStreamRequest {
  provider: AiVaultProvider;
  model?: string;
  /** The provider's own request body, passed through untouched. */
  body: unknown;
}

export type AiStreamStart =
  | { ok: true; requestId: string }
  | { ok: false; code: string; message: string };

export type AiStreamEvent =
  | { requestId: string; type: 'chunk'; text: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; code: string; message: string };

export interface ApiProxyRequest {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  /** Text, or bytes for a body the renderer already encoded (multipart). */
  body?: string | Uint8Array;
}

export interface ApiProxyResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A request that never reached the network: a refused path, or a dead socket. */
export interface ApiProxyFailure {
  ok: false;
  status: 0;
  error: string;
  reason?: string;
}

export type ApiStreamStart =
  | { ok: true; requestId: string; status: number; headers: Record<string, string> }
  | { ok: false; status: number; error: string; body?: string };

export type ApiStreamEvent =
  | { requestId: string; type: 'chunk'; text: string }
  | { requestId: string; type: 'done' }
  | { requestId: string; type: 'error'; message: string };

/** What the UI may know about the session. Never any part of a credential. */
export interface AuthStatus {
  signedIn: boolean;
  userId?: string;
  email?: string;
  /** Epoch ms. Lets the UI show an expiry without holding a token. */
  accessExpiresAt?: number;
  plan?: string | null;
  /** False when the OS has no keystore: the session dies with the app. */
  persisted: boolean;
}

export interface MotionEditorApi {
  readonly platform: string;
  readonly version: string;
  /**
   * Authenticated calls to our own backend, made from the main process.
   *
   * There is deliberately no way to read the session token — the same shape as
   * `ai.keys` below, and for the same reason. The renderer asks for a REQUEST
   * to be made; the `Authorization` header is attached in main and never
   * crosses back. `path` is a path, not a URL: main resolves the base itself,
   * so this cannot be turned into a general relay carrying the user's bearer.
   */
  api?: {
    request?(req: ApiProxyRequest): Promise<ApiProxyResponse | ApiProxyFailure>;
    stream?(req: ApiProxyRequest): Promise<ApiStreamStart>;
    cancel?(requestId: string): Promise<boolean>;
    /** Returns an unsubscribe function. Filter events by `requestId`. */
    onStreamEvent?(handler: (event: ApiStreamEvent) => void): () => void;
  };
  /**
   * Session state, and the two operations that change it.
   *
   * `status` returns claims and never a credential. There is no `getToken`, and
   * adding one would undo the whole arrangement above.
   */
  auth?: {
    status?(): Promise<AuthStatus>;
    signIn?(payload: { path: string; body?: unknown; clientName?: string }):
      Promise<{ ok: true; status: AuthStatus } | { ok: false; status: number; body?: unknown }>;
    signOut?(): Promise<AuthStatus>;
    /** One-way migration of a pre-Track-A `localStorage` refresh token. */
    adoptLegacy?(refreshToken: string): Promise<AuthStatus>;
  };
  /**
   * The assistant, for the local edition — the shell holds the provider keys and
   * makes the calls (electron/aiKeyVault.ts, electron/aiProxy.ts).
   *
   * There is deliberately no way to read a key back. `set` and `clear` write;
   * `status` returns presence and a masked tail. Nothing in the renderer needs a
   * provider key, because nothing in the renderer talks to a provider — and the
   * session token now has exactly the same shape, for exactly the same reason.
   */
  ai?: {
    keys?: {
      status?(): Promise<Record<AiVaultProvider, AiKeyStatus>>;
      set?(provider: AiVaultProvider, key: string): Promise<{ persisted: boolean; hint: string }>;
      /** Omit `provider` to forget every key at once. */
      clear?(provider?: AiVaultProvider): Promise<void>;
      /** False when the OS has no keystore — the app then never persists a key. */
      available?(): Promise<boolean>;
    };
    /** Begin a completion. Resolves once the provider's response headers are in. */
    stream?(request: AiStreamRequest): Promise<AiStreamStart>;
    cancel?(requestId: string): Promise<boolean>;
    /** Returns an unsubscribe function. Filter events by `requestId`. */
    onStreamEvent?(handler: (event: AiStreamEvent) => void): () => void;
  };
  project?: {
    /** Native open dialog → the chosen project file (or null if cancelled). */
    open?(): Promise<MotionEditorFile | null>;
    /** Native save dialog → the chosen path (or null if cancelled). */
    chooseSavePath?(defaultName: string): Promise<string | null>;
    /** Native directory dialog → a chosen `.motion` bundle dir (local-first). */
    openBundleDir?(): Promise<string | null>;
  };
  file?: {
    read?(path: string): Promise<string | null>;
    write?(path: string, contents: string): Promise<void>;
    /** Binary read for packed `.motion` zips. */
    readBytes?(path: string): Promise<Uint8Array | null>;
    writeBytes?(path: string, bytes: Uint8Array): Promise<void>;
  };
  /**
   * `.motion` directory-bundle access (local-first storage). `root` is the
   * bundle directory; `name` is a chunk file relative to it (e.g. 'scene.json').
   * The main process enforces atomic writes and path containment within `root`.
   */
  bundle?: {
    read?(root: string, name: string): Promise<string | null>;
    writeAtomic?(root: string, name: string, contents: string): Promise<void>;
    remove?(root: string, name: string): Promise<void>;
    list?(root: string): Promise<string[]>;
  };
  /**
   * Binary content-addressed blob storage within a bundle (asset bytes). Kept
   * separate from `bundle` because chunks are text and blobs are binary — base64
   * in the text channel would waste a third of the space.
   */
  blob?: {
    has?(root: string, hash: string): Promise<boolean>;
    read?(root: string, hash: string): Promise<Uint8Array | null>;
    write?(root: string, hash: string, bytes: Uint8Array): Promise<void>;
    remove?(root: string, hash: string): Promise<void>;
    list?(root: string): Promise<string[]>;
  };
  /**
   * Offline video encoding. The renderer stages locally-rasterized frames (and
   * optional audio) to a per-job temp dir one at a time, then ffmpeg encodes them
   * in a CHILD PROCESS — no network, no renderer-heap copy of the whole render,
   * and no competition with the editor's UI thread.
   *
   * @see electron/main.ts registerRenderIpc
   * @see src/core/export/videoSink.ts (the renderer-side consumer)
   */
  /**
   * Media probing. Desktop only, and best-effort even there: resolves null when
   * ffprobe/ffmpeg is not installed. See `@core/assets/mediaProbe`.
   */
  media?: {
    probe?(bytes: Uint8Array, ext: string): Promise<MediaProbeResult | null>;
    /**
     * Transcode a file into an editing proxy. `args` is the ffmpeg argument
     * list from `proxyEncodeArgs`, with `__IN__`/`__OUT__` placeholders the
     * main process substitutes with paths it owns. Resolves null when ffmpeg
     * is absent, the encode failed, or the job was cancelled — every one of
     * which leaves the asset at full resolution.
     */
    generateProxy?(
      assetId: string,
      bytes: Uint8Array,
      ext: string,
      args: string[],
      outExt: string,
    ): Promise<Uint8Array | null>;
    /** Kill a running proxy encode. True if one was actually running. */
    cancelProxy?(assetId: string): Promise<boolean>;
  };

  render?: {
    beginJob?(): Promise<string>;
    stageFrame?(jobId: string, index: number, bytes: Uint8Array, ext?: 'jpg' | 'png'): Promise<void>;
    stageAudio?(jobId: string, bytes: Uint8Array): Promise<void>;
    encode?(
      jobId: string,
      opts: {
        format: 'mp4' | 'webm' | 'gif' | 'mov';
        fps: number;
        hasAudio?: boolean;
        quality?: 'high' | 'medium' | 'draft';
        /** ST.2084 PQ or HLG — HEVC 10-bit with BT.2020 tags when ffmpeg has libx265. */
        hdr?: 'pq' | 'hlg';
        /** Measured MaxCLL / MaxFALL + mastering display (HDR10 SEI foothold). */
        hdrMastering?: {
          maxCll: number;
          maxFall: number;
          displayMaxNits: number;
          displayMinNits: number;
        };
      },
    ): Promise<{ path: string; frames: number; videoCodec?: string }>;
    /** Kill an in-flight encode (Cancel / queue Pause). */
    cancel?(jobId: string): Promise<void>;
    /** Native save dialog, then move the encoded file there. Null if cancelled. */
    save?(jobId: string, defaultName: string): Promise<{ path: string } | null>;
    /** Move the encoded file into an already-chosen folder, no dialog. Never
     *  overwrites — a clashing name is suffixed ` (2)`. */
    saveTo?(jobId: string, dir: string, filename: string): Promise<{ path: string }>;
    /** Directory picker for the render queue's output folder. */
    chooseOutputDir?(): Promise<string | null>;
    cleanJob?(jobId: string): Promise<void>;
  };

  /** Diagnostics forwarded to the main-process log (DevTools-less builds). */
  diag?: {
    /** Fire-and-forget GPU/WebGPU probe report → <userData>/gpu-diagnostics.log. */
    gpuReport?(report: unknown): void;
  };
  /**
   * Local project index (SQLite in the main process). Every method mirrors the
   * `LocalIndex` port; `available` is false when the native driver is not
   * installed, so the renderer can fall back to the in-memory index.
   */
  index?: {
    available?(): Promise<boolean>;
    upsertProject?(row: unknown): Promise<void>;
    getProject?(id: string): Promise<unknown | null>;
    listProjects?(opts?: unknown): Promise<unknown[]>;
    removeProject?(id: string): Promise<void>;
    markMissing?(id: string, missing: boolean): Promise<void>;
    addRecovery?(row: unknown): Promise<void>;
    listRecovery?(projectId: string): Promise<unknown[]>;
    clearRecovery?(projectId: string): Promise<void>;
  };
  /**
   * Content-addressed thumbnail cache in <userData>/thumbs — the disk sink
   * behind `ProjectIndexRow.thumbHash`. Derived data only; absent in the
   * browser, where cards render facts without an image.
   */
  thumbs?: {
    write?(hash: string, bytes: Uint8Array): Promise<boolean>;
    read?(hash: string): Promise<Uint8Array | null>;
  };
  window?: {
    minimize?(): Promise<void>;
    maximize?(): Promise<void>;
    close?(): Promise<void>;
  };
  popout?: {
    spawnWindow?(panelId: string): void;
    sendStateUpdate?(data: unknown): void;
    onStateSync?(handler: (data: unknown) => void): () => void;
  };
  app?: {
    quit?(): Promise<void>;
    version?(): Promise<string>;
  };
  /**
   * Provider sign-in for the desktop app. `openExternal` opens the backend OAuth
   * start URL in the system browser (Google refuses embedded webviews);
   * `onResult` delivers the one-time code / error from the premation:// deep link.
   */
  oauth?: {
    openExternal(url: string): Promise<void>;
    onResult(handler: (result: { code?: string; error?: string }) => void): () => void;
  };
  /** Subscribe to native menu command ids. Returns an unsubscribe fn. */
  onMenuCommand?(handler: (commandId: string) => void): () => void;
  /** `premation://plugin/<id>` — validated in main, re-validated by the renderer. */
  onPluginDeepLink?(handler: (payload: { id: string }) => void): () => void;
  /**
   * Report the RENDERER's edition to the shell, which resolved its own from a
   * different build input. Diagnostic only — main compares and logs, and never
   * takes its edition from this. See electron/edition.ts.
   *
   * Optional like every other member here: there is no bridge in a browser build.
   */
  reportEdition?(edition: string): Promise<{ ok: boolean; message?: string }>;
  // The NOTE that used to sit here claimed "there is deliberately no `ai` surface
  // any more — keys are stored server-side, so the desktop shell holds no AI
  // privileges at all". That stopped being true when the local edition grew its
  // own key path, and the `ai?:` member above (line ~103) had already contradicted
  // it. The shell does hold AI privileges, in the server edition; in the local
  // edition main does not register the channels at all, which is a stronger
  // guarantee than the comment was claiming and an actually true one.
}

declare global {
  interface Window {
    motionEditor?: MotionEditorApi;
    electronAPI?: MotionEditorApi;
  }
}

export {};
