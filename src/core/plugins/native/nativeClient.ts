/**
 * The renderer's side of the native tier.
 *
 * Everything above this file speaks in effects, generator frames and methods;
 * everything below it speaks in processes and file paths. This is the seam, and
 * it has three jobs:
 *
 *   1. **Decide.** Run the trust gate before anything launches — signature or
 *      Developer Mode, plus consent pinned to the binary's hash. The main
 *      process re-checks the hash against the bytes it is about to load, so
 *      this is not the only gate; it is the one that knows the manifest, the
 *      revocation list and what the user was asked.
 *   2. **Shape.** Turn a call the rest of the app makes into the ABI's request,
 *      and the ABI's answer back. The three shapes deliberately mirror the JS
 *      tiers' — C2's kernel signature, C3's `generate` — so a plugin can offer
 *      a native fast path and a JavaScript fallback for the SAME effect and the
 *      caller does not branch on which one ran.
 *   3. **Degrade.** Every failure resolves to `null`, which every caller
 *      already treats as "leave the layer alone and use the other path". A
 *      plugin that is absent, refused, crashed, benched or built for another
 *      platform is indistinguishable from one that simply has no native
 *      module — on purpose, because there is nothing a render can do
 *      differently about any of them.
 *
 * ── Zero cost when there is nothing native ───────────────────────────────────
 *
 * No process is started until something calls a native plugin. No scheduler is
 * created until the first call. `nativeBridge()` is a property read. A project
 * without a native plugin never reaches past the first line of any function
 * here.
 */

import type { PluginManifest } from '../manifest';
import { selectNativeBinary, type NativeSelection } from './nativePlatforms';
import {
  getNativeConsent,
  killNativeConsent,
  nativeTrustVerdict,
  type NativeTrustVerdict,
} from './nativeTrust';
import { collectTransfers, reclaimAll } from './nativeBuffers';
import {
  dropPluginSequenceData,
  readSequenceData,
  sequenceSignature,
  writeSequenceData,
} from './nativeSequenceData';
import {
  NativeScheduler,
  nativeScheduler,
  type NativeJob,
} from './nativeScheduler';
import type {
  NativeCallOutcome,
  NativeDescribe,
  NativeEffectRequest,
  NativeFrameInfo,
  NativeGenerateRequest,
  NativeGenerateResult,
  NativeRefusal,
  NativeRequest,
} from './nativeAbi';
import type { ThreadSafety } from '../effectSchema';

/** What the preload exposes. Null in the browser build, which has no processes. */
function bridge(): NonNullable<Window['motionEditor']>['pluginNative'] | null {
  return (typeof window === 'undefined' ? null : window.motionEditor?.pluginNative) ?? null;
}

export function nativeTierAvailable(): boolean {
  return bridge() !== null;
}

/** One plugin's native state, as the UI and the render path see it. */
export interface NativeStatus {
  pluginId: string;
  loaded: boolean;
  /** Present once the process answered `describe()`. */
  describe?: NativeDescribe;
  /** Why it is not loaded. Absent while it is. */
  code?: NativeRefusal;
  error?: string;
  /** True for `unsupported-platform` — a state to list, not a fault to report. */
  unavailableHere?: boolean;
  /** The platform keys the package DOES ship, for the message. */
  availablePlatforms?: string[];
  /** The consent sheet may be offered for this one. */
  askable?: boolean;
  restarts?: number;
  /** The process is off for the rest of the session after repeated crashes. */
  disabled?: boolean;
}

const statuses = new Map<string, NativeStatus>();

export function nativeStatus(pluginId: string): NativeStatus | null {
  return statuses.get(pluginId) ?? null;
}

export function allNativeStatuses(): NativeStatus[] {
  return [...statuses.values()];
}

const statusListeners = new Set<() => void>();

export function subscribeNativeStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

function setStatus(pluginId: string, next: Partial<NativeStatus>): NativeStatus {
  const merged: NativeStatus = { pluginId, loaded: false, ...statuses.get(pluginId), ...next };
  statuses.set(pluginId, merged);
  for (const fn of [...statusListeners]) fn();
  return merged;
}

// ── Loading ───────────────────────────────────────────────────────────────────

export interface NativeLoadInput {
  manifest: PluginManifest;
  /** Absolute directory the package lives in — a folder install, or a staged one. */
  dir: string;
  /** SHA-256 of each declared binary, as the main process measured it on disk. */
  hashes: Record<string, string>;
  signature: { ok: boolean; publisherKey?: string; reason?: string } | null;
  developerMode: boolean;
  platform?: string;
  arch?: string;
}

/**
 * Bring a plugin's native module up, if it is allowed and there is one.
 *
 * Resolves a status rather than throwing, and the status is the answer to
 * "what should the UI say about this plugin" as much as it is the answer to
 * "may I call it". The two are the same question asked at different moments,
 * and splitting them was how the folder tier ended up with plugins that looked
 * healthy and did not run.
 */
export async function loadNativePlugin(input: NativeLoadInput): Promise<NativeStatus> {
  const { manifest } = input;
  const api = bridge();
  if (!api) {
    return setStatus(manifest.id, {
      loaded: false,
      code: 'no-native-tier',
      error: 'This build cannot run native plugin modules.',
    });
  }
  if (!manifest.native) {
    return setStatus(manifest.id, { loaded: false, code: 'not-declared' });
  }

  // `process.platform` and `process.arch` as the PRELOAD sees them, which is
  // the process that will load the binary. Derived in the renderer they would
  // be a user-agent guess, and "arm64 Mac reported as x64" is a binary that
  // loads and then crashes rather than one that is refused.
  const selection: NativeSelection = selectNativeBinary(
    manifest.native,
    input.platform ?? api.platform,
    input.arch ?? api.arch,
  );
  if (!selection.ok) {
    return setStatus(manifest.id, {
      loaded: false,
      code: selection.code,
      error: selection.error,
      unavailableHere: selection.code === 'unsupported-platform',
      availablePlatforms: selection.available,
    });
  }

  const sha256 = input.hashes[selection.path];
  const verdict: NativeTrustVerdict = nativeTrustVerdict({
    pluginId: manifest.id,
    pluginName: manifest.name,
    version: manifest.version,
    selection,
    ...(sha256 ? { sha256 } : {}),
    signature: input.signature,
    developerMode: input.developerMode,
  });
  if (!verdict.allowed) {
    return setStatus(manifest.id, {
      loaded: false,
      code: verdict.code,
      error: verdict.error,
      askable: verdict.askable,
    });
  }

  const result = await api.load({
    pluginId: manifest.id,
    pluginName: manifest.name,
    version: manifest.version,
    dir: input.dir,
    binaryPath: selection.path,
    sha256: sha256 ?? '',
    abi: manifest.native.abi,
    ...(manifest.native.threadSafety ? { threadSafety: manifest.native.threadSafety } : {}),
    ...(manifest.native.timeoutMs !== undefined ? { timeoutMs: manifest.native.timeoutMs } : {}),
    ...(manifest.native.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: manifest.native.idleTimeoutMs }
      : {}),
  });

  if (!result.ok) {
    return setStatus(manifest.id, {
      loaded: false,
      code: (result.code ?? 'failed') as NativeRefusal,
      error: result.error ?? 'The native module did not load.',
    });
  }

  return setStatus(manifest.id, {
    loaded: true,
    describe: result.describe as NativeDescribe,
    code: undefined,
    error: undefined,
    askable: false,
  });
}

/**
 * Stop a plugin's process.
 *
 * Used by uninstall, by revocation, and by the author's reload loop. Queued
 * work for that plugin is dropped first, so nothing is left waiting on a
 * process that is going away.
 */
export async function unloadNativePlugin(pluginId: string, reason = 'unload'): Promise<void> {
  nativeScheduler()?.forget(pluginId);
  // Everything this plugin remembered between frames. The next process never
  // saw it and may not even be the same build of the same addon, so handing it
  // back would be handing a stranger's data to code that trusts it. Covers
  // unload, reload (which is an unload then a load) and revocation.
  dropPluginSequenceData(pluginId);
  statuses.delete(pluginId);
  for (const fn of [...statusListeners]) fn();
  await bridge()?.unload(pluginId, reason);
}

/**
 * The author's loop: terminate and relaunch without restarting the app.
 *
 * A native module cannot be unloaded from a process — `require` caches it, and
 * the OS keeps the library mapped — so "reload" is the process dying and a new
 * one starting. That is the whole reason one process per plugin was worth the
 * memory: it makes this a 200 ms operation instead of a restart.
 *
 * The consent is re-checked by `loadNativePlugin`, which is the point at which
 * a rebuilt binary's changed hash re-asks.
 */
export async function reloadNativePlugin(input: NativeLoadInput): Promise<NativeStatus> {
  await unloadNativePlugin(input.manifest.id, 'reload');
  return loadNativePlugin(input);
}

/** Revocation's hook: drop consent and kill the process, in that order. */
export async function killNativePlugin(pluginId: string): Promise<void> {
  killNativeConsent(pluginId);
  await unloadNativePlugin(pluginId, 'revoked');
}

// ── Calling ───────────────────────────────────────────────────────────────────

/**
 * The dispatch the scheduler runs. One place where a request crosses the bridge.
 *
 * The transfer bookkeeping is here rather than at each call site for the reason
 * `collectTransfers` documents: a shape that grows a buffer must not be able to
 * grow one nobody marked.
 */
const dispatch = async (job: NativeJob): Promise<NativeCallOutcome> => {
  const api = bridge();
  if (!api) return { ok: false, code: 'no-native-tier', error: 'No native tier in this build.' };

  collectTransfers(job.request);
  try {
    const outcome = await api.call({ pluginId: job.pluginId, request: job.request });
    // What comes back is OURS again. The request's buffers stay marked: they
    // were spent crossing the channel, and the copy that came back is the live
    // one — so a caller that reads the old array fails loudly rather than
    // compositing the frame before.
    if (outcome.ok) reclaimAll(outcome.result);
    return outcome as NativeCallOutcome;
  } catch (err) {
    return { ok: false, code: 'failed', error: (err as Error).message };
  }
};

/** The scheduler, created on the first native call and never before. */
function scheduler(): NativeScheduler | null {
  return nativeScheduler(dispatch);
}

/**
 * Is a native path worth trying for this plugin right now?
 *
 * The one call the render path makes before building a request. False for every
 * plugin without a loaded process, which is all of them in a project with no
 * native plugins.
 */
export function nativeReady(pluginId: string, call: 'effect' | 'generate' | 'invoke'): boolean {
  const status = statuses.get(pluginId);
  if (!status?.loaded || !status.describe) return false;
  if (!status.describe.calls.includes(call)) return false;
  return !scheduler()?.benched(pluginId);
}

function threadSafetyOf(pluginId: string, declared?: ThreadSafety): ThreadSafety | undefined {
  // The addon's own `describe()` wins over the manifest: the manifest is a file
  // the author edits and the describe is the build talking. Where only one
  // exists, that one is used; where neither does, the caller's default applies.
  const described = statuses.get(pluginId)?.describe?.threadSafety;
  return (described as ThreadSafety | undefined) ?? declared;
}

/**
 * Run one effect's pixels through a native addon.
 *
 * The request mirrors C2's `KernelRunRequest` field for field on purpose: a
 * caller already building one of those builds this by renaming the call. The
 * INTEGRATION is one branch in `runEffectKernel` — try this, fall through to
 * the worker pool on `null` — and it is deliberately not made here, because
 * that file belongs to the CPU kernel tier.
 */
export async function runNativeEffect(request: {
  pluginId: string;
  effectId: string;
  instanceId: string;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  params: Record<string, unknown>;
  host: NativeFrameInfo;
  neighbours?: Array<{ offset: number; pixels: Uint8ClampedArray }>;
  threadSafety?: ThreadSafety;
  /** Params whose change invalidates this effect's cached state — the
   *  effect's own declaration, from its manifest. */
  invalidateOn?: ReadonlyArray<string>;
}): Promise<Uint8ClampedArray | null> {
  if (!nativeReady(request.pluginId, 'effect')) return null;
  const pool = scheduler();
  if (!pool) return null;

  /*
    Sequence data: what this instance remembered from the last frame. The
    signature is computed here rather than in the store so the store never has
    to know what a param is — see `nativeSequenceData.ts` for why none of this
    is saved, and why dropping all of it must only ever cost speed.
  */
  const signature = sequenceSignature(request.params, request.invalidateOn);
  const state = readSequenceData(request.pluginId, request.instanceId, signature);

  const native: NativeEffectRequest = {
    call: 'effect',
    effectId: request.effectId,
    instanceId: request.instanceId,
    width: request.width,
    height: request.height,
    pixels: request.pixels,
    params: request.params,
    host: request.host,
    ...(request.neighbours && request.neighbours.length > 0
      ? { neighbours: request.neighbours }
      : {}),
    ...(state !== undefined ? { state } : {}),
  };

  const outcome = await pool.submit({
    pluginId: request.pluginId,
    instanceId: request.instanceId,
    ...(threadSafetyOf(request.pluginId, request.threadSafety)
      ? { threadSafety: threadSafetyOf(request.pluginId, request.threadSafety) }
      : {}),
    request: native,
  });
  if (!outcome || !outcome.ok || outcome.result.call !== 'effect') return null;

  /*
    An OMITTED `state` keeps what the host already holds; `null` clears it.
    The distinction is the whole ergonomics of the field: an effect that built
    its cache on frame one says nothing on frame two, and saying nothing has to
    be free rather than meaning "forget everything".
  */
  if ('state' in outcome.result) {
    const next = outcome.result.state;
    const kept = writeSequenceData(
      request.pluginId,
      request.instanceId,
      signature,
      next === null ? undefined : next,
    );
    if (!kept) {
      pool.note(
        request.pluginId,
        request.instanceId,
        'returned more cached state than the host will hold; it will be rebuilt every frame',
      );
    }
  }

  // `identity` means the addon changed nothing. The caller's own buffer is
  // already the answer, and handing it back saves a copy of the whole frame.
  if (outcome.result.identity) return request.pixels;
  return outcome.result.pixels ?? null;
}

/**
 * Ask a native addon for one generator frame.
 *
 * Shaped from C3's `GeneratorFrameRequest` so the scheduler that owns generator
 * layers can try this first and fall back to the plugin's Worker. What comes
 * back is the plugin's raw result — `validateGeneratorFrame` is what turns it
 * into something the renderer will draw, and running it here would be a second
 * validator free to disagree with the first.
 */
export async function runNativeGenerate(request: {
  pluginId: string;
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
  threadSafety?: ThreadSafety;
}): Promise<Omit<NativeGenerateResult, 'call'> | null> {
  if (!nativeReady(request.pluginId, 'generate')) return null;
  const pool = scheduler();
  if (!pool) return null;

  const native: NativeGenerateRequest = {
    call: 'generate',
    generatorId: request.generatorId,
    instanceId: request.instanceId,
    layerTime: request.layerTime,
    compTime: request.compTime,
    frame: request.frame,
    fps: request.fps,
    compSize: request.compSize,
    layerSize: request.layerSize,
    params: request.params,
    seed: request.seed,
    ...(request.state !== undefined ? { state: request.state } : {}),
  };

  const outcome = await pool.submit({
    pluginId: request.pluginId,
    instanceId: request.instanceId,
    ...(threadSafetyOf(request.pluginId, request.threadSafety)
      ? { threadSafety: threadSafetyOf(request.pluginId, request.threadSafety) }
      : {}),
    request: native,
  });
  if (!outcome || !outcome.ok || outcome.result.call !== 'generate') return null;
  const { call: _call, ...rest } = outcome.result;
  return rest;
}

/**
 * Anything that is not pixels: `invoke(method, payload)`.
 *
 * The escape hatch that keeps the other two shapes narrow. A decoder opening a
 * file, a tracker being fed a rectangle, a solver being asked for a rig — none
 * of those is a frame, and forcing them through the effect shape is how a
 * render contract stops meaning anything. Serialised per plugin by default,
 * because a method with no declared thread safety is one the author has said
 * nothing about.
 */
export async function invokeNative(
  pluginId: string,
  method: string,
  payload: unknown,
  opts: { instanceId?: string; buffers?: ArrayBuffer[]; threadSafety?: ThreadSafety } = {},
): Promise<NativeCallOutcome | null> {
  if (!nativeReady(pluginId, 'invoke')) return null;
  const pool = scheduler();
  if (!pool) return null;

  const request: NativeRequest = {
    call: 'invoke',
    method,
    payload,
    ...(opts.buffers && opts.buffers.length > 0 ? { buffers: opts.buffers } : {}),
  };
  return pool.submit({
    pluginId,
    instanceId: opts.instanceId ?? `${pluginId}:${method}`,
    threadSafety: threadSafetyOf(pluginId, opts.threadSafety) ?? 'unsafe',
    request,
  });
}

/**
 * Take what the host process has to say about a plugin.
 *
 * Crashes, restarts and the session disable arrive as events rather than as
 * call failures, because they happen to processes that are idle as often as to
 * ones mid-call. The status this maintains is what the plugin's row shows.
 *
 * `onEvent` is the second reader: a status is what the UI SHOWS and a log line
 * is what it KEEPS, and a crash the user was not looking at when it happened
 * needs the second. It is handed every event this sees, including the ones for
 * a plugin with no status yet, because "this plugin's process died before it
 * ever came up" is exactly the sentence the author is missing.
 */
export function watchNativeEvents(
  onEvent?: (event: { type: string; pluginId: string; message?: string; restarts?: number }) => void,
): () => void {
  const api = bridge();
  if (!api?.onEvent) return () => {};
  return api.onEvent((event) => {
    onEvent?.(event);
    const current = statuses.get(event.pluginId);
    if (!current) return;
    if (event.type === 'crashed') {
      setStatus(event.pluginId, {
        loaded: false,
        code: 'crashed',
        error: event.message ?? 'The plugin\'s process stopped unexpectedly.',
        restarts: event.restarts ?? current.restarts,
      });
    } else if (event.type === 'disabled') {
      setStatus(event.pluginId, {
        loaded: false,
        disabled: true,
        code: 'disabled',
        error: event.message
          ?? 'This plugin\'s native module crashed repeatedly and is off for this session.',
      });
      nativeScheduler()?.forget(event.pluginId);
    } else if (event.type === 'ready') {
      setStatus(event.pluginId, { loaded: true, code: undefined, error: undefined });
    } else if (event.type === 'stopped') {
      setStatus(event.pluginId, { loaded: false, code: undefined, error: undefined });
    }
  });
}

/** Test seam: forget every status, so one test's plugin is not another's. */
export function resetNativeClientForTests(): void {
  statuses.clear();
  statusListeners.clear();
}

/** Exported for the consent sheet, which needs the record it is replacing. */
export { getNativeConsent };
