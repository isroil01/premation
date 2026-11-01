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

/** electron/mcp/bridge.ts McpToolResult — MCP's CallToolResult. */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
  isError?: boolean;
}

/** electron/mcp/ipc.ts ClaudeSetupStatus. */
export interface ClaudeSetupStatus {
  bridge: {
    enabled: boolean;
    listening: boolean;
    error: string | null;
    pageReady: boolean;
    clients: Array<{ id: number; name: string; version: string; since: number; lastCallAt: number | null }>;
  };
  claude: {
    installed: boolean;
    configs: Array<{ path: string; state: 'absent' | 'ok' | 'stale' | 'malformed' }>;
    extension: 'absent' | 'ok' | 'stale';
  };
  method: 'extension' | 'config' | null;
  configured: boolean;
  needsRepair: boolean;
  extensionFile: string | null;
  connectorInstalled: boolean;
  claudeCodeCommand: string;
  manualSnippet: string;
  serverName: string;
  devBuild: boolean;
  /** Cursor, Antigravity, ChatGPT desktop. Mirrors electron/mcp/appConfigs.ts. */
  apps: McpAppStatus[];
}

export type McpAppId = 'cursor' | 'antigravity' | 'chatgpt';

export interface McpAppStatus {
  id: McpAppId;
  name: string;
  present: boolean;
  state: 'absent' | 'ok' | 'stale' | 'malformed';
  configPath: string;
  restart: string;
  blurb: string;
  command: string;
  snippet: string;
}

/** electron/mcp/ipc.ts ConnectResult. */
export type ClaudeConnectResult =
  | { ok: true; status: ClaudeSetupStatus; changed: boolean; method: 'extension' | 'config'; extensionFile?: string; openError?: string }
  | { ok: false; code: 'not-installed' | 'malformed' | 'io' | 'unreadable' | 'no-connector'; message: string; status: ClaudeSetupStatus };

/** electron/mcp/selfTest.ts TestStep. */
export interface ClaudeTestStep {
  id: 'script' | 'start' | 'initialize' | 'tools' | 'app';
  label: string;
  ok: boolean;
  detail?: string;
}

/** One tool call main relays from the MCP pipe to the editor page. */
export interface McpRelayedCall {
  id: number;
  clientId: number;
  name: string;
  args: unknown;
}

/** `window.motionEditor.mcp` (electron/preload.ts). */
export interface McpBridgeApi {
  getStatus(): Promise<ClaudeSetupStatus>;
  connect(): Promise<ClaudeConnectResult>;
  connectConfig(): Promise<ClaudeConnectResult>;
  revealExtension(): Promise<void>;
  enable(): Promise<ClaudeSetupStatus>;
  disconnect(): Promise<{ status: ClaudeSetupStatus; problems: string[]; extensionInstalled: boolean }>;
  repair(): Promise<ClaudeConnectResult>;
  connectApp(id: McpAppId): Promise<ClaudeConnectResult>;
  disconnectApp(id: McpAppId): Promise<{ status: ClaudeSetupStatus; problems: string[] }>;
  test(): Promise<ClaudeTestStep[]>;
  getClaude(): Promise<void>;
  onStatus(handler: (status: ClaudeSetupStatus) => void): () => void;
  setPageReady(ready: boolean): void;
  onCall(handler: (call: McpRelayedCall) => void): () => void;
  onClients(handler: (clientIds: number[]) => void): () => void;
  respond(id: number, result: McpToolResult): Promise<void>;
}

/** electron/nativePluginStore.ts InstallOutcome. */
export type NativePluginInstallOutcome =
  | { ok: true; id: string; version: string; restartNeeded: boolean }
  | {
      ok: false;
      reason: string;
      code: 'size' | 'hash' | 'signature' | 'key-changed' | 'package' | 'io' | 'revoked' | 'unknown-publisher' | 'platform' | 'plan-required';
    };

/** electron/pluginFileInstall.ts PackagePreview: what the install-from-file dialog shows. */
export interface NativePluginPackagePreview {
  token: string;
  fileName: string;
  id: string;
  name: string;
  version: string;
  vendor: string;
  sdk: string;
  effects: Array<{ matchName: string; name: string; category: string }>;
  /** P7: commands, footage importers, export formats and panels the package adds (display names). */
  contributes?: { commands: string[]; importers: string[]; outputModules: string[]; panels: string[] };
  platforms: string[];
  runsHere: boolean;
  trust: 'store-verified' | 'store' | 'pinned' | 'unknown' | 'unsigned';
  publisher: string;
  entitlement: string | null;
  installedVersion: string | null;
  problem: string | null;
  storeUnreachable: boolean;
}

/** electron/pluginFileInstall.ts InspectResult. */
export type NativePluginPackageInspect =
  | { ok: true; preview: NativePluginPackagePreview }
  | { ok: false; fileName: string; reason: string };

/** electron/nativePluginStore.ts PluginStoreState. */
export interface NativePluginStoreState {
  plugins: Record<string, { version: string; publisherKey: string; enabled: boolean; installedAt: number; pending?: boolean }>;
  uninstall: string[];
}

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
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444' | 'dnxhr-lb' | 'dnxhr-sq' | 'dnxhr-hq' | 'dnxhr-hqx' | 'dnxhr-444';
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
  proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444' | 'dnxhr-lb' | 'dnxhr-sq' | 'dnxhr-hq' | 'dnxhr-hqx' | 'dnxhr-444';
  transparent?: boolean;
  videoEncoder?: string;
  chapters?: unknown;
  /** Bits per channel handed to the encoder: 16 = the engine's rgba64le path (F1; mov only). */
  bitDepth?: 8 | 16;
  /** P7c: a plugin output module's option values (JSON), for `plugin:<id>/<module>` formats. */
  pluginOptions?: string;
  /**
   * More files from the SAME render — AE's extra output modules on one render
   * item. Streamed formats only (mp4 / mov / webm / gif); the engine feeds every
   * encoder the same frames, so the comp is rendered once however many files.
   */
  extraOutputs?: Array<{ format: 'mp4' | 'mov' | 'webm' | 'gif'; outPath: string; quality?: 'high' | 'medium' | 'draft'; proresProfile?: 'proxy' | 'lt' | '422' | 'hq' | '4444' | 'dnxhr-lb' | 'dnxhr-sq' | 'dnxhr-hq' | 'dnxhr-hqx' | 'dnxhr-444'; videoEncoder?: string }>;
  /** What the editor does with the finished file(s): import them, or import and replace the comp's usage. */
  postRender?: 'import' | 'importReplace';
  /** Which project the job belongs to (`core/export/renderProject.ts`); absent on older jobs. */
  projectKey?: string;
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

export type ExportErrorCode = 'ffmpeg-unavailable' | 'disk-full' | 'output-unwritable' | 'output-busy';

/** The models in electron/models.json, by folder name. */
export type ModelId = 'object-matte' | 'face-landmarks' | 'depth-anything' | 'hand-landmarks';

/** One row of Settings ▸ Models (electron/modelInstaller.ts listModels). */
export interface ModelListing {
  id: ModelId;
  name: string;
  description: string;
  licence: string;
  /** Shipped in the installer. */
  bundled: boolean;
  /** `pinned`: one accepted source + checksum. `user`: the person supplies the URL. */
  source: 'pinned' | 'user';
  /** The download's size, when the manifest knows every file's. */
  bytes: number | null;
  state: 'installed' | 'bundled' | 'absent';
  installedBytes: number;
  installedAt: number;
  urls: string[];
}

/** electron/ffmpegHealth.ts FfmpegProblemCode. */
export type FfmpegProblemCode = 'missing' | 'blocked' | 'wrong-arch' | 'damaged' | 'timeout' | 'incomplete';
export type FfmpegSource = 'override' | 'chosen' | 'bundled' | 'repaired' | 'system';

/** electron/ffmpegService.ts FfmpegStatusView. */
export interface FfmpegStatus {
  ok: boolean;
  active?: { source: FfmpegSource; path: string; encoders: string[]; missingEncoders: string[] };
  problem?: { code: FfmpegProblemCode; source: FfmpegSource; detail: string };
  canRepair: boolean;
  repairBytes?: number;
  checkedAt: number;
  repairing: boolean;
  /** Where the pinned archive downloads from — for "download it on another device". */
  downloadUrl?: string;
}

/** electron/ffmpegRepair.ts RepairErrorCode, plus the chooser's 'not-ffmpeg'. */
export type FfmpegRepairErrorCode =
  | 'offline' | 'network-blocked' | 'unavailable' | 'stalled' | 'disk-full' | 'no-permission'
  | 'corrupted' | 'blocked-after-install' | 'cancelled' | 'unsupported' | 'not-ffmpeg';

export type FfmpegRepairResult =
  | { ok: true; status: FfmpegStatus }
  | { ok: false; code: FfmpegRepairErrorCode; detail: string; neededBytes?: number; status: FfmpegStatus };

export interface FfmpegRepairProgress {
  phase: 'checking-space' | 'downloading' | 'verifying' | 'installing' | 'testing';
  receivedBytes: number;
  totalBytes: number;
  attempt: number;
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
  /** What kind of failure `error` is, so the UI offers the fix (electron/exportFailure.ts). */
  errorCode?: ExportErrorCode;
  /** The engine's / ffmpeg's own words when `error` was rewritten for people. */
  errorDetail?: string;
  warnings?: string[];
  attempts: number;
  /** Which renderer runs the current attempt: premation-engine (F1) or a hidden window. */
  renderer?: 'engine' | 'chromium';
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

/** A script file read for File ▸ Scripts / the Script Editor (electron/ipc/scripts.ts). */
export interface ScriptFileInfo {
  name: string;
  path: string;
  source: string;
  /** In the user Scripts folder (Save writes it by name). */
  inScriptsFolder: boolean;
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
    /** F2: the native Open dialog for a project FILE, path only (the engine reads it). */
    chooseOpenPath?(): Promise<string | null>;
    /** Native directory dialog → a chosen `.motion` bundle dir (local-first). */
    openBundleDir?(): Promise<string | null>;
  };
  /**
   * The ML models (electron/models.json), installed by MAIN into
   * <userData>/models/<id> where the engine reads them (electron/modelInstaller.ts):
   * https-only, size-capped, no credentials, checksum-verified when pinned.
   * Progress arrives on `onDownloadProgress`, correlated by the caller-minted
   * `requestId`. `models` is the whole list (Settings ▸ Models); the per-model
   * bridges below answer `bundled: true` for the copy shipped with the app.
   */
  models?: {
    list(): Promise<ModelListing[]>;
    install(request: { id: ModelId; requestId: string; urls?: string[] }): Promise<{ ok: true; model: { bytes: number; installedAt: number } } | { ok: false; message: string }>;
    remove(id: ModelId): Promise<boolean>;
    cancelDownload(requestId: string): Promise<boolean>;
    /** `{ id, requestId, receivedBytes, totalBytes }` for every `models:install` in flight. */
    onDownloadProgress(handler: (event: unknown) => void): () => void;
  };
  /** Face Tracking's landmark model in <userData>/models/face-landmarks (electron/faceModel.ts). */
  faceModel?: {
    status(): Promise<{ url: string; bytes: number; installedAt: number; bundled?: boolean } | null>;
    /** Pinned (models.json): the URL is the manifest's; a request's own `url` is refused unless it is that one. */
    install(request: { url?: string; requestId: string }): Promise<{ ok: true; model: { url: string; bytes: number; installedAt: number } } | { ok: false; message: string }>;
    remove(): Promise<boolean>;
    cancelDownload(requestId: string): Promise<boolean>;
    onDownloadProgress(handler: (event: unknown) => void): () => void;
  };
  /** Make 3D from Photo's depth model in <userData>/models/depth-anything (electron/depthModel.ts) — camera program D3. */
  depthModel?: {
    status(): Promise<{ url: string; sha256: string; bytes: number; installedAt: number; bundled?: boolean } | null>;
    install(request: { requestId: string }): Promise<{ ok: true; model: { url: string; sha256: string; bytes: number; installedAt: number } } | { ok: false; message: string }>;
    remove(): Promise<boolean>;
    cancelDownload(requestId: string): Promise<boolean>;
    onDownloadProgress(handler: (event: unknown) => void): () => void;
  };
  /** Live performance input's hand models in <userData>/models/hand-landmarks (electron/handModel.ts): pinned download. */
  handModel?: {
    status(): Promise<{ urls: string[]; bytes: number; installedAt: number; bundled?: boolean } | null>;
    install(request: { requestId: string }): Promise<{ ok: true; model: { urls: string[]; bytes: number; installedAt: number } } | { ok: false; message: string }>;
    remove(): Promise<boolean>;
    cancelDownload(requestId: string): Promise<boolean>;
    onDownloadProgress(handler: (event: unknown) => void): () => void;
  };
  /** Object Matte walks' SAM 2.1 video model in <userData>/models/sam2-video (models.json `sam2-video`, electron/modelInstaller.ts): pinned download. */
  sam2Model?: {
    status(): Promise<{ urls: string[]; bytes: number; installedAt: number } | null>;
    install(request: { requestId: string }): Promise<{ ok: true; model: { urls: string[]; bytes: number; installedAt: number } } | { ok: false; message: string }>;
    remove(): Promise<boolean>;
    cancelDownload(requestId: string): Promise<boolean>;
    onDownloadProgress(handler: (event: unknown) => void): () => void;
  };
  /** Refine Edge's learned matting model in <userData>/models/vitmatte (models.json `vitmatte`): pinned download. */
  vitmatteModel?: {
    status(): Promise<{ urls: string[]; bytes: number; installedAt: number } | null>;
    install(request: { requestId: string }): Promise<{ ok: true; model: { urls: string[]; bytes: number; installedAt: number } } | { ok: false; message: string }>;
    remove(): Promise<boolean>;
    cancelDownload(requestId: string): Promise<boolean>;
    onDownloadProgress(handler: (event: unknown) => void): () => void;
  };
  /** Export's ffmpeg: health check, one-click repair, "choose file" (electron/ffmpegService.ts). */
  ffmpeg?: {
    status(force?: boolean): Promise<FfmpegStatus>;
    repair(): Promise<FfmpegRepairResult>;
    cancelRepair(): Promise<boolean>;
    /** null when the person closed the file dialog. */
    chooseFile(): Promise<FfmpegRepairResult | null>;
    clearChoice(): Promise<FfmpegStatus>;
    onStatus(handler: (status: FfmpegStatus) => void): () => void;
    onRepairProgress(handler: (progress: FfmpegRepairProgress) => void): () => void;
  };
  objectMatte?: {
    status?(): Promise<{ encoderUrl: string; decoderUrl: string; bytes: number; installedAt: number } | null>;
    install?(request: { encoderUrl: string; decoderUrl: string; requestId: string }): Promise<
      | { ok: true; model: { encoderUrl: string; decoderUrl: string; bytes: number; installedAt: number } }
      | { ok: false; message: string }
    >;
    remove?(): Promise<boolean>;
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
    /** `<userData>/session-footage`, created if missing. Cache for session blob footage. */
    sessionFootageDir?(): Promise<string>;
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
    /**
     * The OS microphone switch (electron/ipc/mediaAccess.ts), without a prompt:
     * macOS / Windows privacy settings; 'granted' where the OS has none.
     */
    microphoneStatus?(): Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>;
    /** Ask the OS for the microphone (macOS prompts once); resolves to the status after. */
    requestMicrophone?(): Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>;
  };

  /** What is left of the render IPC: the files are rendered by the engine (exportSupervisor). */
  render?: {
    /** Hardware encoders that pass a smoke encode on this machine. Cached per session. */
    probeEncoders?(): Promise<{ hardware: Array<'h264_nvenc' | 'hevc_nvenc' | 'h264_qsv' | 'h264_videotoolbox'> }>;
    /** Directory picker for the render queue's output folder. */
    chooseOutputDir?(): Promise<string | null>;
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
    /** F1: what a job may ask for (`bitDepth16` with the engine export flag on). */
    capabilities?(): Promise<{ engineExport: boolean; bitDepth16: boolean }>;
    subscribe?(): Promise<ExportJobRecord[]>;
    chooseOutputPath?(defaultName: string): Promise<string | null>;
    onEvent?(handler: (event: ExportQueueEvent) => void): () => void;
  };


  /** Diagnostics forwarded to the main-process log (DevTools-less builds). */
  diag?: {
    /** Fire-and-forget GPU/WebGPU probe report → <userData>/gpu-diagnostics.log. */
    gpuReport?(report: unknown): void;
    /** Help ▸ Open Logs Folder: reveals the engine log in the OS file manager. */
    openLogs?(): Promise<boolean>;
    /** Help ▸ Copy Diagnostics Report: machine, GPU and log tails onto the clipboard; main confirms. */
    copyReport?(): Promise<boolean>;
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
    /** Paths of the files copied in the OS file manager ([] for none) — Edit ▸ Paste of footage. */
    readClipboardFiles?(): Promise<string[]>;
    /** Hidden entries removed; null if the directory cannot be read. */
    listDir?(dir: string): Promise<Array<{ name: string; path: string; kind: 'dir' | 'file'; size?: number; mtimeMs?: number }> | null>;
    /**
     * Edit ▸ Edit Original: open the file in the OS default application for its
     * type. A numbered-sequence pattern opens its first frame; executables are
     * refused. Never rejects for a missing file — `reason` says what happened.
     */
    openFile?(filePath: string): Promise<
      | { ok: true; path: string }
      | { ok: false; reason: 'missing' | 'refused' | 'failed'; path: string; error?: string }
    >;
  };
  /**
   * Footage file watching (electron/ipc/footageFiles.ts): the project's footage
   * paths are watched (directory watches, debounced, atomic-save aware) and a
   * change is pushed as `onChanged` with the paths as passed to `watch`. An
   * empty `paths` stops every watch of this window. `check` re-stats the whole
   * set now (window focus) and answers what moved. Absent in the browser build.
   */
  footage?: {
    watch?(req: { paths: string[]; priority: string[] }): Promise<void>;
    check?(): Promise<string[]>;
    onChanged?(handler: (paths: string[]) => void): () => void;
  };
  /**
   * The preview disk cache (electron/ipc/diskCache.ts): the folder the engine
   * writes frames to when the user chose none. Absent in the browser build.
   */
  diskCache?: {
    defaultFolder?(): Promise<string>;
    /** Volumes with their free and total space, bytes (electron/ipc/diskCache.ts listCacheDrives). */
    drives?(): Promise<Array<{ root: string; freeBytes: number; totalBytes: number }>>;
  };
  /**
   * File ▸ Scripts and the Script Editor (electron/ipc/scripts.ts): the user
   * Scripts folder (`<userData>/Scripts`, created on demand), a script the
   * user picks, and saving. Absent in the browser build.
   */
  scripts?: {
    folderPath?(): Promise<string>;
    list?(): Promise<{ folder: string; scripts: Array<{ name: string; path: string }> }>;
    openFolder?(): Promise<{ ok: boolean; path: string; error?: string }>;
    /** A script in the Scripts folder by file name; null when it cannot be read. */
    read?(name: string): Promise<ScriptFileInfo | null>;
    /** A native open dialog; null when cancelled. */
    pick?(): Promise<ScriptFileInfo | null>;
    /** By `name` in the Scripts folder, or back to a `path` the user picked this session. */
    save?(req: { name?: string; path?: string; source: string }): Promise<{ ok: boolean; name?: string; path?: string; error?: string }>;
    /** A native save dialog; null when cancelled. */
    saveAs?(req: { name?: string; source: string }): Promise<{ ok: boolean; name?: string; path?: string; error?: string } | null>;
  };
  /**
   * The native SDK plugins folder (electron/ipc/nativePlugins.ts). Plugins are
   * installed in 0.9 by copying a bundle into it; the engine loads them at
   * start. Absent in the browser build.
   */
  plugins?: {
    /** Open the folder in Explorer / Finder (created if missing). */
    openNativeFolder?(): Promise<{ ok: boolean; path: string; error?: string }>;
    /** The folder's path, for the install steps. */
    nativeFolderPath?(): Promise<string>;
    /** Download, verify and install from the plugin store (main does all of it). */
    install?(req: { id: string; version: string; owner?: boolean }): Promise<NativePluginInstallOutcome>;
    /** Queue an uninstall: disabled now, removed at the next start. */
    uninstall?(id: string): Promise<NativePluginStoreState | null>;
    /** Persist enabled / disabled across launches. */
    setEnabled?(req: { id: string; enabled: boolean }): Promise<NativePluginStoreState | null>;
    installed?(): Promise<NativePluginStoreState>;
    /** Pick a `.pplugin` and have main inspect it; null when cancelled. */
    pickPackageFile?(): Promise<NativePluginPackageInspect | null>;
    /** Install an inspected package; `allowUnknown` is the user's "Install anyway". */
    installPackageFile?(req: { token: string; allowUnknown?: boolean }): Promise<NativePluginInstallOutcome>;
    /** Packages opened by double-click since the last call. */
    takeOpenedPackages?(): Promise<NativePluginPackageInspect[]>;
    /** Premation Cloud entitlement (electron/ipc/nativePlugins.ts): refresh now / the kept token's status. */
    refreshEntitlement?(): Promise<{ plan: 'pro' | 'free' | 'unknown'; validUntil: number | null }>;
    entitlement?(): Promise<{ plan: 'pro' | 'free' | 'unknown'; validUntil: number | null }>;
    /** Main opened a package (call `takeOpenedPackages`). Returns the unsubscribe. */
    onPackageOpened?(handler: () => void): () => void;
    host?: { platform: string; arch: string };
  };
  /** Premium library payloads (electron/ipc/libraryCache.ts). */
  library?: {
    payload?(req: { id: string; version: number; tier: 'free' | 'cloud' }): Promise<
      | { ok: true; bytes: Uint8Array; cached: boolean }
      | { ok: false; code: 'plan-required' | 'signed-out' | 'offline' | 'io' | 'bad'; reason: string }
    >;
    /** Development only: built packs from the dev folder. */
    devCatalog?(): Promise<Array<{ meta: unknown; poster?: Uint8Array; preview?: Uint8Array; audio?: Uint8Array }>>;
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
   * premation:// links the page acts on, other than `oauth`. Main has already
   * brought the window forward; the page chooses the screen. A link that came
   * before anything subscribed (a cold start) reaches the first subscriber.
   */
  deepLink?: {
    /** `premation://connections`. Returns an unsubscribe fn. */
    onOpenConnections(handler: () => void): () => void;
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
  setMenuTemplate?(template: unknown, strings?: { checkForUpdates: string; settings: string; version: string }): Promise<{ ok: boolean }>;
  /**
   * Report the RENDERER's edition to the shell, which resolved its own from a
   * different build input. Diagnostic only — main compares and logs, and never
   * takes its edition from this. See electron/edition.ts.
   *
   * Optional like every other member here: there is no bridge in a browser build.
   */
  reportEdition?(edition: string): Promise<{ ok: boolean; message?: string }>;
  /** Claude for Premation (docs/MCP_PLAN.md, electron/mcp/ipc.ts). */
  mcp?: McpBridgeApi;
  /**
   * The C++ engine process (NATIVE_CORE_PLAN C3, electron/engineHost.ts):
   * encoded EngineMessages in and out, plus the supervisor's lifecycle and the
   * shared-texture frame receiver. The engine is the only one; it always runs
   * and owns the document (`engine:unavailable` when it cannot). The page's `ProcessEngineClient`
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
