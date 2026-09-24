/**
 * The preload bridge surface (`window.motionEditor`) — the single, shared
 * contract between the Electron main process and the renderer. Preload,
 * FileManager, and the menu wiring all reference THIS type, so the shape can
 * never drift between the two sides of the IPC boundary.
 *
 * Every member is optional: in a plain browser build `window.motionEditor` is
 * undefined and the app degrades to its web adapters.
 */

/**
 * What `premation render` asked this process to do.
 *
 * Mirrors `CliRenderJob` in electron/cliArgs.ts. The two halves live in
 * separate TypeScript projects that cannot import one another (see
 * electron/tsconfig.json), so this file is the shared contract for the CLI
 * exactly as it already is for the rest of the bridge.
 */
export type CliTaskRequest =
  | { kind: 'render'; job: CliRenderRequest }
  | { kind: 'comps'; projectPath: string }
  | { kind: 'captions'; projectPath: string; outPath: string; comp?: string; language?: string };

export interface CliRenderRequest {
  projectPath: string;
  comp?: string;
  outPath: string;
  format: string;
  startFrame?: number;
  endFrame?: number;
  fps?: number;
  scale?: number;
  width?: number;
  height?: number;
  quality?: 'high' | 'medium' | 'draft';
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
  transparent?: boolean;
  /**
   * A data table, already READ by the main process (the renderer never sees a
   * `--data` path). Present turns the run into one render per row, with
   * `outPath` as a `{token}` pattern.
   */
  data?: { text: string; filename: string };
  /** Start a --data batch at this row (0-based) — resuming an interrupted run. */
  startRow?: number;
  /** Retarget to this aspect before rendering (the `reframe` command). */
  aspect?: string;
  /** A caption file's text, imported before the render (burn-in). */
  captions?: { text: string; filename: string };
  /** A recorded engine command log (JSON lines) replayed before the render (B5). */
  commands?: { text: string; filename: string };
  /**
   * mp4 only — the H.264/HEVC encoder. Set by the export supervisor from the
   * preference captured when the job was queued; the CLI leaves it unset.
   */
  videoEncoder?: string;
  /** Chapter marks captured at queue time (see `RenderJobSpec.chapters`). */
  chapters?: unknown;
}

/*
  ★ The export queue's three shapes are DUPLICATED in electron/exportProcess.ts
  — the two sides cannot import one another (see the header). Keep in step.
*/

export type ExportJobStatus =
  | 'queued'
  | 'preparing'
  | 'rendering'
  | 'encoding'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** One queued export: the CLI's render request plus what the queue shows. */
export interface ExportJobSpec {
  projectPath: string;
  comp?: string;
  outPath: string;
  format: string;
  startFrame?: number;
  endFrame?: number;
  fps?: number;
  width?: number;
  height?: number;
  quality?: 'high' | 'medium' | 'draft';
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
  transparent?: boolean;
  videoEncoder?: string;
  chapters?: unknown;
  label: string;
  totalFrames: number;
}

export interface ExportJobProgress {
  fraction: number;
  frame: number;
  totalFrames: number;
  fps: number | null;
  etaSec: number | null;
}

export interface ExportJobRecord {
  id: string;
  spec: ExportJobSpec;
  status: ExportJobStatus;
  priority: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  progress: ExportJobProgress;
  error?: string;
  warnings?: string[];
  attempts: number;
}

export type ExportQueueEvent =
  | { type: 'snapshot'; jobs: ExportJobRecord[] }
  | { type: 'job'; job: ExportJobRecord };

/** The single report that ends a CLI run, and decides its exit code. */
export type CliDoneReport =
  | {
      ok: true;
      outPath: string;
      compositionName: string;
      frames: number;
      width: number;
      height: number;
      fps: number;
      warnings: string[];
    }
  | { ok: true; comps: string[] }
  | { ok: true; captions: { text: string; cues: number; compositionName: string }; warnings: string[] }
  | {
      ok: true;
      batch: {
        rendered: number;
        failed: number;
        rows: Array<{ outputPath: string; error?: string }>;
      };
      warnings: string[];
    }
  | { ok: false; message: string };

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

export interface AiImageRequest {
  provider: AiVaultProvider;
  prompt: string;
  width?: number;
  height?: number;
}

/**
 * Timed speech, as the shell returns it.
 *
 * Cues are relative to the START of the audio that was sent, not to the
 * composition — the caller supplied the window, so the caller re-bases them.
 * See `@core/captions/transcribe`.
 */
export type AiTranscribeResult =
  | {
      ok: true;
      cues: Array<{ start: number; end: number; text: string }>;
      /**
       * Per-WORD timings, when the model returned them.
       *
       * Same time base as `cues`. Absent when the model gave none, which the
       * caller treats as "estimate word times inside each segment" — the
       * behaviour that shipped before word granularity was requested.
       */
      words?: Array<{ start: number; end: number; text: string }>;
      language?: string;
    }
  | { ok: false; code: string; message: string };

export type AiImageResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; code: string; message: string };

export type AiMediaResult =
  | { ok: true; base64: string; mime: string; extension: string }
  | { ok: false; code: string; message: string };

/** Media providers the desktop media vault holds keys for. */
export type MediaVaultProvider = 'fal' | 'elevenlabs' | 'tripo';

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

/**
 * What the updater is doing, mirrored from `electron/updaterPolicy.ts`.
 *
 * Duplicated rather than imported: the renderer must not reach into the
 * main-process sources, which import `electron` and do not resolve in a browser
 * build. `updaterStatusContract.test.ts` pins the two copies together.
 */
export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; downloading: boolean }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'error'; message: string };

/*
  ★ The two shapes below are DUPLICATED from electron/renderResume.ts, for the
  same reason `UpdateStatus` is duplicated from electron/updaterPolicy.ts: the
  renderer must not import main-process sources (they pull in `electron`, which
  does not resolve in a browser build) and main must not import from `src/`.
  `renderResumeContract.test.ts` compares the two copies as text.

  `spec` is `unknown` on both sides deliberately. It is the render queue's own
  `RenderJobSpec`, round-tripped through JSON on disk by a process that never
  reads a field of it — so main is in no position to promise its shape back, and
  `renderQueueStore` validates what it gets.
*/

/** A previous session's render that still has frames on disk. */
export interface ResumableRenderJob {
  jobId: string;
  spec: unknown;
  format: string;
  totalFrames: number;
  stagedFrames: number;
  createdAt: number;
}

/** A re-registered job: its dir is live again under the same id. */
export interface AdoptedRenderJob {
  jobId: string;
  spec: unknown;
  format: string;
  totalFrames: number;
  stagedFrames: number;
  nextFrame: number;
  frameExt: 'jpg' | 'png';
}

/** Where one plugins folder came from. Shown beside the plugin, so not a boolean. */
export type PluginPathKind = 'user' | 'machine' | 'env';

export interface PluginSearchPathInfo {
  kind: PluginPathKind;
  dir: string;
}

/**
 * One candidate a folder scan found, before anything has been validated.
 *
 * `manifestText` is RAW, and deliberately: the manifest grammar lives in the
 * renderer (`parseManifest`), and a main process that pre-parsed it would be a
 * second definition of the format, free to drift from the one that gates an
 * install.
 */
export interface DiscoveredLocalPlugin {
  path: string;
  kind: 'folder' | 'archive';
  source: PluginPathKind;
  /** The search root it was found under, for grouping. */
  root: string;
  /** `plugin.json` for a folder; null for an archive — that lives inside the zip. */
  manifestText: string | null;
  /** `<archive>.sig` beside the package, when there is one. */
  signatureText?: string;
  modifiedAt: number;
  error?: string;
}

/** One package read off disk: the same shape for a folder and for an archive. */
export interface LocalPackageRead {
  ok: boolean;
  error?: string;
  kind?: 'folder' | 'archive';
  /** Archive only — the renderer opens the zip and checks the signature. */
  bytes?: Uint8Array;
  files?: Record<string, string>;
  binaries?: Record<string, Uint8Array>;
  /** Files the tier does not carry (native modules, unknown extensions). */
  skipped?: string[];
  /**
   * Compiled modules the manifest DECLARED, described instead of read.
   *
   * Folder installs only. The bytes never cross — a path, a size and the
   * SHA-256 the consent step names and the loader pins to. A compiled file the
   * manifest did not declare is in `skipped`, exactly as before.
   */
  native?: Array<{ path: string; size: number; sha256: string }>;
}

/**
 * Bringing one plugin's compiled module up.
 *
 * `sha256` is what the renderer BELIEVES the binary hashes to — the value the
 * user's consent is pinned to. Main hashes the file itself and refuses a
 * mismatch; sending it is how a stale consent record is caught rather than
 * how trust is established.
 */
export interface NativeLoadRequest {
  pluginId: string;
  pluginName: string;
  version: string;
  /** Absolute directory the package lives in. Must be inside a plugins root. */
  dir: string;
  /** Package-relative path to the binary, from the manifest. */
  binaryPath: string;
  sha256: string;
  /** The MAJOR ABI the manifest declares. Checked against the binary's own answer. */
  abi: number;
  threadSafety?: 'unsafe' | 'instance' | 'full';
  timeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface NativeLoadResult {
  ok: boolean;
  /** A `NativeRefusal` code — the UI switches on it, the message is for people. */
  code?: string;
  error?: string;
  /** What `motion_plugin_describe()` returned, once the ABI check passed. */
  describe?: unknown;
}

export interface NativeCallRequest {
  pluginId: string;
  /** A `NativeRequest` — effect, generate or invoke. */
  request: unknown;
}

export type NativeCallReply =
  | { ok: true; result: unknown; elapsedMs: number }
  | { ok: false; code: string; error: string };

export interface NativeStageRequest {
  pluginId: string;
  version: string;
  /** Package-relative path, used for the staged file's name. */
  relPath: string;
  bytes: Uint8Array;
  /** Re-computed in main; a mismatch refuses the write. */
  sha256: string;
}

export interface NativeProcessStatus {
  pluginId: string;
  running: boolean;
  restarts: number;
  /** Off for the rest of the session after repeated crashes. */
  disabled: boolean;
  lastError?: string;
  startedAt?: number;
  calls: number;
}

export interface NativeProcessEvent {
  type: 'ready' | 'crashed' | 'disabled' | 'stopped';
  pluginId: string;
  message?: string;
  restarts?: number;
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
    /**
     * Generate one image. Resolves with base64 bytes — never a provider URL.
     * Same custody as `stream`: the shell holds the key; the renderer never sees it.
     */
    /**
     * Speech → timed segments, for captions.
     *
     * OpenAI only: Anthropic has no audio API, and Gemini returns prose
     * without timings, which cannot become captions. A request naming either
     * resolves `ok: false` explaining that rather than failing obscurely.
     */
    transcribe?(request: {
      provider: AiVaultProvider;
      /** Audio file bytes. 16 kHz mono WAV is what the app sends; 25 MB cap. */
      bytes: Uint8Array;
      filename?: string;
      /** BCP-47-ish hint. Absent: the model detects the language. */
      language?: string;
    }): Promise<AiTranscribeResult>;
    image?(request: AiImageRequest): Promise<AiImageResult>;
    /** Text-to-video via fal.ai. Returns base64 mp4 bytes. */
    video?(request: { prompt: string; durationSec?: number }): Promise<AiMediaResult>;
    /** Text-to-speech via ElevenLabs. Returns base64 mp3 bytes. */
    speech?(request: { text: string; voiceId?: string }): Promise<AiMediaResult>;
    /** Text-to-3D via Tripo. Returns base64 glb bytes. */
    model3d?(request: { prompt: string }): Promise<AiMediaResult>;
    /** Media provider keys — separate from chat LLM keys. */
    mediaKeys?: {
      status?(): Promise<Record<MediaVaultProvider, AiKeyStatus>>;
      set?(provider: MediaVaultProvider, key: string): Promise<{ persisted: boolean; hint: string }>;
      clear?(provider?: MediaVaultProvider): Promise<void>;
      available?(): Promise<boolean>;
    };
  };
  project?: {
    /** Native open dialog → the chosen project file (or null if cancelled). */
    open?(): Promise<MotionEditorFile | null>;
    /** Native save dialog → the chosen path (or null if cancelled). */
    chooseSavePath?(defaultName: string): Promise<string | null>;
    /** Native directory dialog → a chosen `.motion` bundle dir (local-first). */
    openBundleDir?(): Promise<string | null>;
  };
  /**
   * Bundled Object Matte model files. Allowlisted names only — the main
   * process maps a known filename to a path inside its own dist/, and answers
   * null for anything else or for a build that shipped without the files.
   */
  objectMatte?: {
    read?(name: string): Promise<Uint8Array | null>;
    /** file:// URL of an allowlisted asset the renderer must import() (the
     *  ORT glue module) — null when the build shipped without it. */
    url?(name: string): Promise<string | null>;
    /**
     * Fetch a user-chosen model URL from the MAIN process, where the page CSP
     * does not apply. https-only, size-capped, no credentials attached; runs
     * only when the user presses Install. Progress arrives on
     * `onDownloadProgress` correlated by the caller-minted `requestId`.
     */
    download?(request: { url: string; requestId: string }): Promise<
      { ok: true; bytes: Uint8Array } | { ok: false; message: string }
    >;
    cancelDownload?(requestId: string): Promise<boolean>;
    /** Progress pushes for every in-flight download; filter by requestId. */
    onDownloadProgress?(handler: (event: unknown) => void): () => void;
  };
  file?: {
    /** A picked / dropped `File`'s disk path ('' if none) — `webUtils.getPathForFile`. */
    pathOf?(file: File): string;
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
    /**
     * Open a staging dir. `info` is what makes the render RESUMABLE across a
     * restart: it is written to `resume.json` in the dir, so a later session can
     * find the frames and know what they were for. Omitted, the job stages
     * exactly as before and is never offered back — which is right for one-shot
     * exports and for the headless CLI.
     */
    beginJob?(info?: { spec?: unknown; format?: string; totalFrames?: number }): Promise<string>;
    /** Renders a previous session left half-staged on disk, newest first. */
    listResumableJobs?(): Promise<ResumableRenderJob[]>;
    /**
     * Re-register one of those dirs under its ORIGINAL id, so `stageFrame` and
     * `encode` reach it again, and report how many contiguous frames are really
     * there. Null when the id names nothing resumable.
     */
    adoptJob?(jobId: string): Promise<AdoptedRenderJob | null>;
    /** Delete a staging dir the queue decided not to finish. */
    discardJob?(jobId: string): Promise<void>;
    stageFrame?(jobId: string, index: number, bytes: Uint8Array, ext?: 'jpg' | 'png'): Promise<void>;
    stageAudio?(jobId: string, bytes: Uint8Array): Promise<void>;
    encode?(
      jobId: string,
      opts: {
        format: 'mp4' | 'webm' | 'gif' | 'mov';
        fps: number;
        hasAudio?: boolean;
        quality?: 'high' | 'medium' | 'draft';
        /** mov only — ProRes flavour ffmpeg encodes. Defaults to 4444. */
        proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
        /** ST.2084 PQ or HLG — HEVC 10-bit with BT.2020 tags when ffmpeg has libx265. */
        hdr?: 'pq' | 'hlg';
        /** Measured MaxCLL / MaxFALL + mastering display (HDR10 SEI foothold). */
        hdrMastering?: {
          maxCll: number;
          maxFall: number;
          displayMaxNits: number;
          displayMinNits: number;
        };
        /**
         * Chapter marks as FFMETADATA1 TEXT (see `@core/export/chapters`).
         *
         * Text rather than a chapter array because the main process cannot
         * import from `src/` — formatting there would duplicate the escaping
         * rules. Written to a file beside the staged frames and pulled in as an
         * extra ffmpeg INPUT, since ffmpeg can only read chapters from a
         * container. Honoured for MP4/MOV only; the WebM muxer has no Chapters
         * element at all.
         */
        chaptersFfmetadata?: string;
        /**
         * mp4 only — the encoder for the H.264/HEVC stream. `libx264` (the
         * default) is the software path every file has been encoded with; the
         * hardware names are opt-in and PROBED in main: an encoder the build
         * lacks or the machine cannot run falls back to libx264, and the
         * result's `warning` says so.
         */
        videoEncoder?: 'libx264' | 'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox';
      },
    ): Promise<{ path: string; frames: number; videoCodec?: string; warning?: string }>;
    /**
     * Streaming encode — the fast path `encode` is the fallback for.
     *
     * One ffmpeg child is opened on a job dir and fed raw 8-bit RGBA frames
     * (width × height × 4 bytes, strictly in order from 0) as they render; the
     * same command line as `encode` bar the video input, writing the same
     * `out.<ext>`, so `save`/`saveTo`/`cancel`/`cleanJob` apply unchanged.
     * `streamFrame` resolves once ffmpeg's stdin has drained — awaiting it is
     * the back-pressure. Not for HDR (mastering metadata needs every frame
     * first). `streamPreference` is 'staged' when MOTION_EXPORT_PIPELINE says so.
     */
    streamPreference?(): Promise<'stream' | 'staged'>;
    openStream?(
      jobId: string,
      opts: {
        format: 'mp4' | 'webm' | 'gif' | 'mov';
        fps: number;
        width: number;
        height: number;
        hasAudio?: boolean;
        quality?: 'high' | 'medium' | 'draft';
        proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444';
        /** The frames carry real alpha (webm keeps it). */
        alpha?: boolean;
        chaptersFfmetadata?: string;
        /** As for `encode`: mp4 only, opt-in, probed before the child opens. */
        videoEncoder?: 'libx264' | 'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox';
      },
    ): Promise<{ videoEncoder: string; warning?: string } | void>;
    /** A whole frame in one message. Superseded by `streamChunk`; kept for older mains. */
    streamFrame?(jobId: string, index: number, bytes: Uint8Array): Promise<void>;
    /**
     * One piece of frame `index` starting at byte `offset`; `last` completes
     * the frame. Resolves once the piece has drained into ffmpeg's stdin —
     * that resolution is the ACK the raw pipe's back-pressure is built on
     * (`@core/export/rawPipe`). Pieces are at most 4 MiB; main refuses larger.
     */
    streamChunk?(jobId: string, index: number, offset: number, bytes: Uint8Array, last: boolean): Promise<void>;
    finishStream?(jobId: string): Promise<{ path: string; frames: number }>;
    /** Hardware encoders that pass a smoke encode on this machine. Cached per session. */
    probeEncoders?(): Promise<{ hardware: Array<'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox'> }>;
    /**
     * Probe host ffmpeg for HEVC (libx265). Used by the Export dialog so HDR10/HLG
     * can warn before encode when MaxCLL/MaxFALL SEI will not be written.
     */
    probeHdr?(): Promise<{ libx265: boolean }>;
    /** Kill an in-flight encode (Cancel / queue Pause). */
    cancel?(jobId: string): Promise<void>;
    /** Native save dialog, then move the encoded file there. Null if cancelled. */
    save?(jobId: string, defaultName: string): Promise<{ path: string } | null>;
    /** Move the encoded file into an already-chosen folder, no dialog. A
     *  clashing name is suffixed ` (2)` unless `overwrite` says otherwise —
     *  the render queue never overwrites, the headless CLI always does. */
    saveTo?(jobId: string, dir: string, filename: string, overwrite?: boolean): Promise<{ path: string }>;
    /** Directory picker for the render queue's output folder. */
    chooseOutputDir?(): Promise<string | null>;
    cleanJob?(jobId: string): Promise<void>;
  };

  /**
   * The headless CLI (`premation render`). Present only in a desktop build,
   * and only answering during a CLI launch — a normal editor session has no
   * `cli:job` handler registered, so `job()` rejects and the /render route
   * stands down. See electron/cliRender.ts.
   */
  cli?: {
    /** The job this process was launched to perform. Rejects if there is none. */
    job?(): Promise<CliTaskRequest>;
    /** Render progress 0–1. Fire-and-forget; it also resets the stall watchdog. */
    progress?(fraction: number): void;
    /** The one terminal report. The process exits on it. */
    done?(report: CliDoneReport): void;
  };

  /**
   * The main-owned export queue (electron/exportProcess.ts), as the editor
   * sees it. Desktop only. See `@core/export/exportSupervisorClient`.
   */
  exportSupervisor?: {
    reserve?(): Promise<{ id: string; projectPath: string }>;
    enqueue?(req: { id?: string; spec: ExportJobSpec; priority?: number }): Promise<ExportJobRecord>;
    cancel?(id: string): Promise<boolean>;
    retry?(id: string): Promise<ExportJobRecord | null>;
    setPriority?(id: string, priority: number): Promise<boolean>;
    remove?(id: string): Promise<boolean>;
    list?(): Promise<ExportJobRecord[]>;
    subscribe?(): Promise<ExportJobRecord[]>;
    chooseOutputPath?(defaultName: string): Promise<string | null>;
    onEvent?(handler: (event: ExportQueueEvent) => void): () => void;
  };

  /**
   * The same queue's worker side — answers only in a hidden export window,
   * with the CLI's request and report shapes. See `src/pages/RenderPage.tsx`.
   */
  exportWorker?: {
    job?(): Promise<CliTaskRequest>;
    progress?(fraction: number): void;
    done?(report: CliDoneReport): void;
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
  /**
   * Disk-facing verbs for the Assets panel (electron/ipc/reveal.ts): show a
   * file in Explorer / Finder, pick a folder for the media browser, and list
   * one level of a directory. Absent in the browser build, where the panel
   * hides every control that needs them.
   */
  shell?: {
    /** False when the path no longer exists. */
    revealInFolder?(filePath: string): Promise<boolean>;
    /** Native folder picker; null if cancelled. */
    pickFolder?(): Promise<string | null>;
    /** Native multi-file picker for media; null if cancelled. */
    pickFiles?(): Promise<string[] | null>;
    /** Hidden entries removed; null if the directory cannot be read. */
    listDir?(dir: string): Promise<Array<{ name: string; path: string; kind: 'dir' | 'file'; size?: number; mtimeMs?: number }> | null>;
  };
  window?: {
    minimize?(): Promise<void>;
    maximize?(): Promise<void>;
    close?(): Promise<void>;
    /** Recolour the OS caption buttons (Windows / Linux overlay). False when the window has none. */
    setTitleBarOverlay?(colors: { color: string; symbolColor: string }): Promise<boolean>;
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
  /**
   * Auto-update, as the renderer sees it.
   *
   * Absent in a browser build — there is nothing to update — which is why the
   * whole member is optional like the rest of this bridge. Callers must handle
   * its absence rather than assume a desktop shell.
   */
  updates?: {
    getStatus(): Promise<UpdateStatus>;
    /** Live status pushes. Returns an unsubscribe fn. */
    onStatus(handler: (status: UpdateStatus) => void): () => void;
    getSettings(): Promise<{ autoDownload: boolean }>;
    setAutoDownload(enabled: boolean): Promise<{ autoDownload: boolean }>;
    /** Check now — Settings' "Check for updates" button. */
    check(): Promise<UpdateStatus>;
    /** Fetch an update the user declined to auto-download. */
    downloadNow(): Promise<boolean>;
    /** Quit into the installer and come back. */
    restartAndInstall(): Promise<void>;
  };
  /** Subscribe to native menu command ids. Returns an unsubscribe fn. */
  onMenuCommand?(handler: (commandId: string) => void): () => void;
  /**
   * Hand main the menu model serialised by `layout/Menu/nativeMenuTemplate.ts`;
   * the native menu is rebuilt from it. Absent in a browser build.
   */
  setMenuTemplate?(template: unknown): Promise<{ ok: boolean }>;
  /**
   * Plugins that live in a folder on this machine (electron/pluginLoader.ts).
   *
   * Read-only, and the set of directories is main's: `read` takes a path and
   * refuses one that is not inside a configured plugins folder, so the renderer
   * names a package and never a file. Absent in the browser build, where the
   * only way in is a dropped package.
   */
  plugins?: {
    paths(): Promise<PluginSearchPathInfo[]>;
    scan(): Promise<DiscoveredLocalPlugin[]>;
    read(path: string): Promise<LocalPackageRead>;
    /** Opens the user's own plugins folder, creating it if it is not there. */
    openFolder(): Promise<{ ok: boolean; dir?: string; error?: string }>;
    /** Watch the folders for changes. Developer mode turns this on. */
    watch(enabled: boolean): Promise<{ ok: boolean; watching: boolean }>;
    onChanged(handler: () => void): () => void;
  };
  /**
   * A plugin's COMPILED module, running in a process of its own.
   *
   * Absent in the browser build, and absent from every project that does not
   * install a native plugin — nothing here starts anything until `load` is
   * called. `platform` and `arch` are the preload's own `process` values,
   * because the process that will load the binary is the only honest source
   * for which binary to pick.
   *
   * Note what the renderer does NOT get: no path it names is read, no binary's
   * bytes cross back, and `load` refuses anything outside a configured plugins
   * folder or the app's own staging directory. See electron/pluginNativeIpc.ts.
   */
  pluginNative?: {
    readonly platform: string;
    readonly arch: string;
    load(request: NativeLoadRequest): Promise<NativeLoadResult>;
    call(request: NativeCallRequest): Promise<NativeCallReply>;
    unload(pluginId: string, reason?: string): Promise<{ ok: boolean }>;
    status(): Promise<NativeProcessStatus[]>;
    /** Write an archive's binary to the app's staging dir, under its own hash. */
    stage(request: NativeStageRequest): Promise<{ ok: boolean; dir?: string; error?: string }>;
    /** Stop the process and delete everything staged for this plugin. */
    unstage(pluginId: string): Promise<{ ok: boolean }>;
    /**
     * Plugin ids that have a staging directory. Names, never paths.
     *
     * Only this process knows what is staged and only the renderer knows what
     * is installed, so collecting an orphan needs both halves — see
     * `sweepStagedNative`.
     */
    staged(): Promise<string[]>;
    /** Crash, restart, session-disable. Returns an unsubscribe. */
    onEvent(handler: (event: NativeProcessEvent) => void): () => void;
  };
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
  /**
   * The C++ engine process (NATIVE_CORE_PLAN C3, electron/engineHost.ts):
   * encoded EngineMessages in and out, plus the supervisor's lifecycle and the
   * shared-texture frame receiver. `status().enabled` is false unless the
   * process backend is switched on (PREMATION_ENGINE=process or
   * `<userData>/engine.json`). The page's `ProcessEngineClient`
   * (@motion/engine-api) is the only intended caller. Absent in a browser build.
   */
  engine?: import('@motion/engine-api').EngineBridge & {
    /** Engine frames as real VideoFrames (the consumer must call `release()` once). */
    onFrame(consumer: ((frame: VideoFrame, meta: import('@motion/engine-api').EngineFrameMeta, release: () => void) => void) | null): void;
  };
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
