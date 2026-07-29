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
  } | null;
  audio: {
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
  } | null;
}

export interface StoredCredentials {
  /** The long-lived, single-use refresh token. Rotated on every exchange. */
  refreshToken: string;
  refreshExpiresAt?: string;
  /** For "continue as …" on the sign-in screen. Not a secret. */
  email?: string;
  userId?: string;
}

export interface MotionEditorApi {
  readonly platform: string;
  readonly version: string;
  /**
   * OS-keystore-backed session storage, held in the main process.
   *
   * The refresh token is a 90-day credential, so it does not belong in
   * renderer `localStorage` — a plaintext file the user (and anything running
   * as them) can read and edit from DevTools. Encrypted here with DPAPI /
   * Keychain / libsecret via Electron's `safeStorage`.
   */
  credentials?: {
    get?(): Promise<StoredCredentials | null>;
    set?(credentials: StoredCredentials): Promise<{ persisted: boolean }>;
    clear?(): Promise<void>;
    /** False when the OS has no keystore — sessions then last only as long as the app runs. */
    available?(): Promise<boolean>;
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
      },
    ): Promise<{ path: string; frames: number }>;
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
  /** Subscribe to native menu command ids. Returns an unsubscribe fn. */
  onMenuCommand?(handler: (commandId: string) => void): () => void;
  // NOTE: there is deliberately no `ai` surface any more. AI runs through the
  // backend gateway (POST /ai/stream) — keys are stored server-side, so the
  // desktop shell holds no AI privileges at all.
}

declare global {
  interface Window {
    motionEditor?: MotionEditorApi;
    electronAPI?: MotionEditorApi;
  }
}

export {};
