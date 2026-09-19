/**
 * The native plugin ABI, as TypeScript.
 *
 * The same contract as `include/motion_plugin_abi.h`, written as the shapes a
 * JavaScript caller sees — because that is what an N-API addon's exports ARE
 * once they cross into the host: five properties on a module object, taking and
 * returning plain values.
 *
 * Two kinds of author use this file. One writes the addon in C++ or Rust and
 * reads it to know what to build and return. The other writes a thin
 * JavaScript or TypeScript shim in front of a `.node` binary — a version check,
 * a parameter fixup, a fallback when the binary is missing — and imports the
 * types directly. Both are supported; neither is required to depend on this
 * package at build time.
 *
 * Nothing here executes. There is no runtime, no loader and no helper: a
 * package that the editor is going to load compiled code from is not also going
 * to bring its own copy of the logic that decides whether that is allowed.
 */

/** Breaking version. Mirrored in the header and in the editor. */
export const MOTION_PLUGIN_ABI_MAJOR = 1;

/** Additive version. A host refuses an addon whose minor is newer than its own. */
export const MOTION_PLUGIN_ABI_MINOR = 0;

/** `major * 1000 + minor` — what `motion_plugin_abi_version()` returns. */
export const MOTION_PLUGIN_ABI_VERSION = MOTION_PLUGIN_ABI_MAJOR * 1000 + MOTION_PLUGIN_ABI_MINOR;

/** Which of the three call shapes an addon answers. */
export type MotionNativeCallKind = 'effect' | 'generate' | 'invoke';

/** What the addon wants pixels in. See the header for why float is the default. */
/**
 * What an addon wants pixels in.
 *
 * ── The precision this does NOT change ──────────────────────────────────────
 *
 * `f32-premul` is a CONTAINER, not a promise about precision. Every route into
 * a CPU or native effect starts at an 8-bit source — the host's CPU bake reads
 * the bake through Canvas2D's `getImageData`, which has no wider form — so
 * asking for float gets 8-bit data widened to float, not high-precision data.
 *
 * It is still the right ask for an addon whose maths wants floats: the
 * conversion happens once, in the plugin's own process, instead of inside its
 * inner loop. What it is not is a way to get more bits than the host has.
 *
 * Where a plugin DOES get real precision is the GPU path: the renderer's
 * compositing targets are `rgba16float`, so a plugin's WGSL or GLSL effect
 * already reads and writes at half-float throughout. An effect that needs the
 * precision should ship a shader; the CPU kernel is the twin that keeps it
 * working when a layer is baked, not the place to do 16-bit work.
 */
export type MotionNativePixelFormat = 'f32-premul' | 'rgba8-premul' | 'rgba8-straight';

/** The same three words every other tier declares. */
export type MotionNativeThreadSafety = 'unsafe' | 'instance' | 'full';

/** What `motion_plugin_register` is handed, once, per process. */
export interface MotionNativeHostInfo {
  /** The host's own packed ABI version, for a log line in the addon. */
  abi: number;
  /** Always `"Premation"` today. Present so an addon can serve more than one host. */
  app: string;
  appVersion: string;
  pluginId: string;
  pluginVersion: string;
  /**
   * Absolute directory the package was loaded from.
   *
   * Where an addon's models, LUTs and lookup tables live. Handed over rather
   * than derived from `__dirname`, because a package installed from an archive
   * is staged somewhere the binary cannot guess.
   */
  pluginDir: string;
}

export interface MotionNativeRegisterResult {
  ok: boolean;
  /** Shown to the user when `ok` is false. Name what is missing. */
  error?: string;
}

/** One effect this addon can render, as it describes itself. */
export interface MotionNativeEffectInfo {
  /** Plugin-local id, matching the effect contributed in `plugin.json`. */
  id: string;
  /**
   * How far outside the layer box this effect writes, in px per side.
   *
   * The host allocates the buffer, so it has to know before the call. Declared
   * statically here rather than returned per frame for the reason AE's max
   * result rect is request-independent: a reach that varies with what was asked
   * for cannot be cached against.
   */
  expand?: { left: number; top: number; right: number; bottom: number };
}

/** What `motion_plugin_describe` returns. */
export interface MotionNativeDescribe {
  name: string;
  version: string;
  /** Which call shapes are implemented. An unlisted call is refused by the host. */
  calls: MotionNativeCallKind[];
  pixelFormat?: MotionNativePixelFormat;
  threadSafety?: MotionNativeThreadSafety;
  effects?: MotionNativeEffectInfo[];
  /** Generator layer kinds, plugin-local ids, when `calls` includes `generate`. */
  generators?: string[];
  /** Methods `invoke` answers. Advisory — used for a clearer "no such method". */
  methods?: string[];
}

/** Everything the host fills in for a pixel call. The CPU kernel's `host`, on the wire. */
export interface MotionNativeFrameInfo {
  compWidth: number;
  compHeight: number;
  layerWidth: number;
  layerHeight: number;
  /** The LAYER's own time in seconds — a retimed layer does not share the comp's. */
  time: number;
  compTime: number;
  frame: number;
  fps: number;
  pixelScale: number;
  /** 1 at full quality, 2 at half, 4 at quarter. */
  downsample: number;
  /** Stable per effect instance, across frames and machines. */
  seed: number;
}

export interface MotionNativeEffectRequest {
  call: 'effect';
  /** Plugin-local effect id. */
  effectId: string;
  /** The effect INSTANCE — what a per-instance cache should be keyed on. */
  instanceId: string;
  width: number;
  height: number;
  /** RGBA in `describe().pixelFormat`, row-major, no padding. */
  input: Uint8ClampedArray | Float32Array;
  /** A buffer of the same size to write into. Return it, or `identity: true`. */
  output: Uint8ClampedArray | Float32Array;
  params: Record<string, unknown>;
  host: MotionNativeFrameInfo;
  /**
   * What this instance returned last frame — the host's sequence data.
   *
   * Absent on the first call, after a param you named in `invalidateOn`
   * changes, and after anything that restarts this process. Treat it as a
   * CACHE and nothing more: an addon that cannot rebuild from nothing will
   * fail on the second frame of somebody's render.
   */
  state?: unknown;
  /** Neighbouring frames of the layer's own source, keyed by offset (−1 = previous). */
  neighbours?: Array<{ offset: number; pixels: Uint8ClampedArray | Float32Array }>;
}

export interface MotionNativeGenerateRequest {
  call: 'generate';
  /** Plugin-local layer-kind id. */
  generatorId: string;
  instanceId: string;
  layerTime: number;
  compTime: number;
  frame: number;
  fps: number;
  compSize: { width: number; height: number };
  layerSize: { width: number; height: number };
  params: Record<string, unknown>;
  seed: number;
  /** What this generator returned for the previous frame, if it is stateful. */
  state?: unknown;
}

export interface MotionNativeInvokeRequest {
  call: 'invoke';
  method: string;
  payload: unknown;
  /** Bytes the caller handed over, for a method that works on a blob. */
  buffers?: ArrayBuffer[];
}

export type MotionNativeRequest =
  | MotionNativeEffectRequest
  | MotionNativeGenerateRequest
  | MotionNativeInvokeRequest;

export interface MotionNativeEffectResponse {
  ok: true;
  /** Absent when `identity` is true. */
  output?: Uint8ClampedArray | Float32Array;
  /** "I changed nothing" — the host reuses the input and skips the copy back. */
  identity?: boolean;
  /**
   * What to hand this instance next frame — the host's sequence data.
   *
   * OMIT to keep what the host already holds. That is the case you want on
   * almost every frame: build the expensive thing once, return it once, and
   * say nothing thereafter. Returning it again each frame is also correct and
   * costs a structured clone of the whole cache per frame, which is the cost
   * the field exists to avoid.
   *
   * Return `null` to clear it.
   */
  state?: unknown;
}

export interface MotionNativeGenerateResponse {
  ok: true;
  /** `stride` floats per instance — 9, or 11 with UVs. */
  instances: Float32Array;
  count: number;
  primitive: 'point' | 'sprite' | 'quad' | 'mesh';
  stride?: number;
  mesh?: { vertices: Float32Array; indices: Uint16Array | Uint32Array };
  textureAssetKey?: string;
  cellSize?: [number, number];
  blend?: 'normal' | 'add';
  maxBounds?: { x: number; y: number; width: number; height: number };
  /** Carried to the next sequential frame, and checkpointed by the host. */
  state?: unknown;
}

export interface MotionNativeInvokeResponse {
  ok: true;
  result: unknown;
  /** Bytes handed back. Transferred, so the addon must not keep a reference. */
  buffers?: ArrayBuffer[];
}

export interface MotionNativeFailure {
  ok: false;
  /** One sentence, shown against the plugin's name in its log. */
  error: string;
}

export type MotionNativeResponse =
  | MotionNativeEffectResponse
  | MotionNativeGenerateResponse
  | MotionNativeInvokeResponse
  | MotionNativeFailure;

/**
 * The five exports, as the host sees them after `require()`.
 *
 * A shim written in TypeScript can assert against this directly:
 * `const addon: MotionNativeAddon = require('./build/Release/my_addon.node');`
 */
export interface MotionNativeAddon {
  motion_plugin_abi_version(): number;
  motion_plugin_register(host: MotionNativeHostInfo): MotionNativeRegisterResult;
  motion_plugin_describe(): MotionNativeDescribe;
  motion_plugin_render(request: MotionNativeRequest): MotionNativeResponse;
  motion_plugin_dispose(): void;
}
