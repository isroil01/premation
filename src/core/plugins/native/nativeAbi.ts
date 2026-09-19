/**
 * The native ABI, as the editor knows it.
 *
 * ── Why a compiled tier exists at all ────────────────────────────────────────
 *
 * The Worker sandbox and the WASM kernel path cover almost everything, and
 * where they do not cover it the gap is not small: a hardware decoder, an
 * optical-flow tracker, a mesh solver, a pixel kernel with twenty years of
 * hand-written SIMD in it. Those arrive as compiled libraries or they do not
 * arrive. After Effects' whole plugin economy is that tier, and a plugin author
 * with one of those cannot port it to WebAssembly on request.
 *
 * ── Why it is out of process ─────────────────────────────────────────────────
 *
 * AE loads plugins into its own address space, and a bad one takes the
 * application down with the user's unsaved work. That trade made sense for a
 * tool whose plugins arrive as vendor installers a professional deliberately
 * bought. It is the wrong trade here, and it is also no longer necessary: an
 * Electron `utilityProcess` is a real OS process with its own address space, so
 * a segfault in a stranger's binary costs one process and one frame.
 *
 * So the rule this whole tier is built around: **a native plugin can fail in
 * every way a native plugin can fail, and the editor keeps rendering.** Crash,
 * hang, refuse to load, load and then produce nonsense — each one ends with the
 * layer unchanged, a line in that plugin's own log, and a frame that went out.
 *
 * ── Why the version check is a number and not a feature probe ────────────────
 *
 * Because the thing on the other side is machine code with a fixed idea of what
 * a struct looks like. A probe would have to CALL it to find out, and calling a
 * binary that disagrees about a stack frame is exactly the crash this refuses
 * to risk. `motion_plugin_abi_version` is the one function called before the
 * check, and its contract is "return a constant, allocate nothing, throw
 * nothing".
 *
 * These numbers are mirrored in four files the build cannot make import one
 * another — the C header, the SDK's types, this, and `electron/pluginNativeAbi.ts`
 * (the main process compiles alone; see `pluginLoader.ts` for the same rule).
 * `nativeAbiPinned.test.ts` reads all four and fails when they drift.
 */

/** Breaking version. A different one is refused without being called. */
export const NATIVE_ABI_MAJOR = 1;

/** Additive version. An addon may be older; it may not be newer. */
export const NATIVE_ABI_MINOR = 0;

/** What `motion_plugin_abi_version()` returns: `major * 1000 + minor`. */
export const NATIVE_ABI_VERSION = NATIVE_ABI_MAJOR * 1000 + NATIVE_ABI_MINOR;

export const nativeAbiMajor = (packed: number): number => Math.floor(packed / 1000);
export const nativeAbiMinor = (packed: number): number => packed % 1000;

/** The five exports, by the exact strings they are registered under. */
export const NATIVE_EXPORTS = [
  'motion_plugin_abi_version',
  'motion_plugin_register',
  'motion_plugin_describe',
  'motion_plugin_render',
  'motion_plugin_dispose',
] as const;

export type NativeCallKind = 'effect' | 'generate' | 'invoke';

/**
 * What an addon wants pixels in.
 *
 * ── The precision this does NOT change ──────────────────────────────────────
 *
 * `f32-premul` is a CONTAINER, not a promise about precision. Every route into
 * a CPU or native effect starts at an 8-bit source — `pluginCpuEffect` reads
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
export type NativePixelFormat = 'f32-premul' | 'rgba8-premul' | 'rgba8-straight';

/** What `describe()` came back with, after the host has checked its shape. */
export interface NativeDescribe {
  name: string;
  version: string;
  calls: NativeCallKind[];
  pixelFormat: NativePixelFormat;
  /** The same three words the CPU kernels declare. Default `instance`. */
  threadSafety: 'unsafe' | 'instance' | 'full';
  effects: Array<{
    id: string;
    expand?: { left: number; top: number; right: number; bottom: number };
  }>;
  generators: string[];
  methods: string[];
}

/**
 * Why a load was refused, as a code rather than a sentence.
 *
 * The sentence is for the user and changes; the code is what the UI switches on
 * — `unsupported-platform` is listed as "unavailable on this machine" beside a
 * healthy plugin, while `abi-mismatch` and `hash-changed` are errors the author
 * or the user has to act on. Collapsing them into one string would make every
 * one of them read as "this plugin is broken".
 */
export type NativeRefusal =
  | 'no-native-tier'
  | 'not-declared'
  | 'unsupported-platform'
  | 'missing-binary'
  | 'hash-mismatch'
  | 'not-signed'
  | 'no-consent'
  | 'revoked'
  | 'abi-mismatch'
  | 'register-failed'
  | 'outside-roots'
  | 'disabled'
  | 'crashed'
  | 'timeout'
  | 'no-such-call'
  | 'failed';

export interface NativeCheckResult {
  ok: boolean;
  code?: NativeRefusal;
  /** One sentence, for the plugin's log and the consent sheet. Always set when refused. */
  error?: string;
}

/**
 * Is this addon's ABI one this build can call?
 *
 * Both directions are refused and both messages name both numbers, because the
 * two failures need different actions from different people: a newer addon
 * means the USER updates the app, an older one means the AUTHOR rebuilds. A
 * message saying only "incompatible" leaves each of them guessing which.
 *
 * The MINOR rule is the less obvious half. A newer minor is additive from the
 * host's side — but the addon was built expecting request fields this host does
 * not send, and handing it a struct full of absent keys is how a plugin
 * silently renders the wrong thing rather than failing.
 */
export function checkNativeAbi(
  addonVersion: unknown,
  host: { major: number; minor: number } = { major: NATIVE_ABI_MAJOR, minor: NATIVE_ABI_MINOR },
): NativeCheckResult {
  if (typeof addonVersion !== 'number' || !Number.isInteger(addonVersion) || addonVersion < 0) {
    return {
      ok: false,
      code: 'abi-mismatch',
      error:
        'motion_plugin_abi_version() did not return a whole number. This file is not a Premation '
        + `native plugin, or it was built against a different SDK. This app speaks ABI ${host.major}.${host.minor}.`,
    };
  }
  const major = nativeAbiMajor(addonVersion);
  const minor = nativeAbiMinor(addonVersion);
  if (major !== host.major) {
    return {
      ok: false,
      code: 'abi-mismatch',
      error:
        `This plugin's native module was built for ABI ${major}.${minor}; this app speaks `
        + `${host.major}.${host.minor}. `
        + (major > host.major
          ? 'Update the app, or ask the author for a build against the older ABI.'
          : 'Ask the author for a build against the current ABI.'),
    };
  }
  if (minor > host.minor) {
    return {
      ok: false,
      code: 'abi-mismatch',
      error:
        `This plugin's native module was built for ABI ${major}.${minor} and this app speaks `
        + `${host.major}.${host.minor}. It expects to be handed fields this version does not send. `
        + 'Update the app.',
    };
  }
  return { ok: true };
}

/** Everything the host tells a native effect about the frame it is rendering. */
export interface NativeFrameInfo {
  compWidth: number;
  compHeight: number;
  layerWidth: number;
  layerHeight: number;
  time: number;
  compTime: number;
  frame: number;
  fps: number;
  pixelScale: number;
  downsample: number;
  seed: number;
}

export interface NativeEffectRequest {
  call: 'effect';
  effectId: string;
  instanceId: string;
  width: number;
  height: number;
  /**
   * The layer's pixels, 8-bit RGBA with STRAIGHT alpha — an `ImageData` buffer.
   *
   * The same thing C2's `KernelJob.pixels` carries, for the same reason: bytes
   * are a quarter of the copy, and the conversion to premultiplied float is a
   * linear scan whoever needs it was going to make anyway. Here it is made in
   * the PLUGIN'S OWN PROCESS, so an addon that wants floats costs the editor
   * nothing and an addon that wants bytes costs it nothing either.
   */
  pixels: Uint8ClampedArray;
  params: Record<string, unknown>;
  host: NativeFrameInfo;
  neighbours?: Array<{ offset: number; pixels: Uint8ClampedArray }>;
  /**
   * What this instance returned from the previous frame — AE's sequence data.
   *
   * Absent on the first call, after a param the effect declared in
   * `invalidateOn` changes, and after anything that restarts the addon. The
   * host guarantees only that it is either the last value THIS instance
   * returned or nothing at all; a plugin that cannot rebuild from nothing is a
   * plugin that will fail on the second frame of a render.
   *
   * See `nativeSequenceData.ts` for what is dropped when, and why none of it
   * is saved with the document.
   */
  state?: unknown;
}

export interface NativeGenerateRequest {
  call: 'generate';
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
  state?: unknown;
}

export interface NativeInvokeRequest {
  call: 'invoke';
  method: string;
  payload: unknown;
  buffers?: ArrayBuffer[];
}

export type NativeRequest = NativeEffectRequest | NativeGenerateRequest | NativeInvokeRequest;

export interface NativeEffectResult {
  call: 'effect';
  /** Absent when `identity` — the caller keeps the buffer it already had. */
  pixels?: Uint8ClampedArray;
  identity?: boolean;
  /**
   * What to hand this instance on the next frame.
   *
   * Omit to keep whatever the host is already holding — the common case, since
   * an effect that built its cache on frame one has nothing new to say on frame
   * two. Return `null` to clear it. Returning it unchanged every frame is also
   * correct and costs a structured clone per frame, which is exactly the cost
   * this field exists to avoid, so omitting is the documented default.
   */
  state?: unknown;
}

export interface NativeGenerateResult {
  call: 'generate';
  instances: Float32Array;
  count: number;
  primitive: 'point' | 'sprite' | 'quad' | 'mesh';
  stride?: number;
  mesh?: { vertices: Float32Array; indices: Uint16Array | Uint32Array };
  textureAssetKey?: string;
  cellSize?: [number, number];
  blend?: 'normal' | 'add';
  maxBounds?: { x: number; y: number; width: number; height: number };
  state?: unknown;
}

export interface NativeInvokeResult {
  call: 'invoke';
  result: unknown;
  buffers?: ArrayBuffer[];
}

export type NativeResult = NativeEffectResult | NativeGenerateResult | NativeInvokeResult;

/** What a call comes back as. A refusal is a value, never a rejection. */
export type NativeCallOutcome =
  | { ok: true; result: NativeResult; elapsedMs: number }
  | { ok: false; code: NativeRefusal; error: string };
