/**
 * The main thread's side of the CPU kernel path: find the module, build the
 * job, pick the lane, hand it to the pool.
 *
 * ── Where a kernel's bytes come from ────────────────────────────────────────
 *
 * The installed package, through {@link PackageReader} — the same store
 * `package.read` serves a plugin's own worker from. Coded against an interface
 * with a default implementation rather than against the store directly, for two
 * reasons that are both about not owning someone else's file: the install and
 * packaging work lands in parallel with this, and a test needs to hand over
 * bytes without installing a plugin.
 *
 * ── Why the result is a PROMISE and effects are synchronous ─────────────────
 *
 * They are, and that is the tension this path lives in. A GPU kernel runs
 * inside the frame; a CPU kernel cannot, because it runs in a worker. So this
 * is not called from the render — it is called from the BAKE, which is already
 * asynchronous and already shows the previous texture until the new one lands
 * (round B4). A kernel effect on a baked layer therefore behaves exactly like
 * every other baked effect: the preview catches up a frame later, and the
 * export awaits the exact frame before writing it.
 */

import type { EffectContribution } from '../effectSchema';
import { nativeReady, runNativeEffect } from '../native/nativeClient';
import { kernelScheduler, laneFor, type KernelOutcome } from './kernelPool';
import { runKernelJob } from './kernelWorkerCore';
import type { KernelJob, KernelModuleSource } from './kernelTypes';

/**
 * Reading one file out of an installed plugin package.
 *
 * Deliberately smaller than the host API's `package.read`: a path and bytes,
 * with no permission check, because this is the HOST reading a file the
 * manifest named rather than a plugin reading an arbitrary one.
 */
export interface PackageReader {
  read(pluginId: string, path: string): Promise<ArrayBuffer | string | null>;
}

let reader: PackageReader | null = null;

/**
 * Install the reader the kernel host loads modules through.
 *
 * Called by whatever owns package storage. Until it is, `loadKernelModule`
 * answers "no kernel" rather than throwing — a plugin whose kernel cannot be
 * read is an effect that falls back to its GPU path or reports itself
 * unsupported, which is a degradation; an exception here would be a frame that
 * does not happen.
 */
export function setPackageReader(next: PackageReader | null): void {
  reader = next;
}

/**
 * The default reader: the installed-plugin store.
 *
 * Imported lazily, inside the call, so this module can be unit-tested without
 * dragging the store (and its hydration) into the test. Returns null rather
 * than throwing for every "not there" case — an uninstalled plugin, a path the
 * package does not contain — because all of them mean the same thing to the
 * caller and none of them is worth a stack trace.
 */
async function defaultRead(pluginId: string, path: string): Promise<ArrayBuffer | string | null> {
  try {
    const { usePluginStore } = await import('@stores/pluginStore');
    const entry = usePluginStore.getState().get(pluginId);
    if (!entry) return null;
    const text = entry.files[path];
    if (text !== undefined) return text;
    const bytes = entry.binaries?.[path];
    // Copied, not handed over: the pool TRANSFERS what it posts, and
    // transferring the stored array would neuter the installed record — the
    // second read of the same kernel would come back empty, with nothing in
    // the message to say why. The same trap `readPackageFile` documents.
    return bytes ? (bytes.slice().buffer as ArrayBuffer) : null;
  } catch {
    return null;
  }
}

/** Modules already read out of a package, keyed by `<pluginId>/<path>`. */
const sources = new Map<string, KernelModuleSource | null>();

/**
 * The kernel module for an effect, or null when it has none the host can read.
 *
 * Cached including the NEGATIVE answer, because the miss is the expensive case:
 * an effect whose kernel is missing would otherwise hit the store once per
 * layer per frame forever. Cleared when a plugin is enabled, disabled or
 * updated (`forgetKernelModules`), which is the only moment the answer changes.
 */
export async function loadKernelModule(
  pluginId: string,
  effect: EffectContribution,
): Promise<KernelModuleSource | null> {
  const cpu = effect.cpu;
  if (!cpu) return null;
  const id = `${pluginId}/${cpu.module}`;
  const cached = sources.get(id);
  if (cached !== undefined) return cached;

  const code = await (reader ? reader.read(pluginId, cpu.module) : defaultRead(pluginId, cpu.module));
  const source: KernelModuleSource | null = code === null
    ? null
    : { id, format: cpu.format ?? 'js', entry: cpu.entry ?? 'render', code };
  sources.set(id, source);
  return source;
}

/** Forget cached module bytes. Called when the set of installed plugins changes. */
export function forgetKernelModules(pluginId?: string): void {
  if (!pluginId) {
    sources.clear();
    return;
  }
  for (const key of [...sources.keys()]) {
    if (key.startsWith(`${pluginId}/`)) sources.delete(key);
  }
}

export interface KernelRunRequest {
  pluginId: string;
  effect: EffectContribution;
  /** `<pluginId>.<effectId>`, for attribution. */
  effectId: string;
  /** The effect INSTANCE — the compute cache and the lane are scoped to it. */
  instanceId: string;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  params: Record<string, unknown>;
  host: KernelJob['host'];
  neighbours?: KernelJob['neighbours'];
}

/**
 * Run an effect's CPU kernel over a buffer.
 *
 * Resolves `null` for every "this did not happen" case — no kernel, no module,
 * a newer job superseded this one — and rejects only when the kernel itself
 * failed, which the caller reports against the plugin by name. Both are
 * degradations to "the layer, unchanged"; they are distinguished because one of
 * them is worth telling the author about.
 */
export async function runEffectKernel(request: KernelRunRequest): Promise<Uint8ClampedArray | null> {
  /*
    The compiled addon first, when this plugin has one loaded.

    Before the module read, not after it: a native effect need not ship a CPU
    kernel at all, and `loadKernelModule` would answer null for it and return
    from here before the addon was ever asked. `nativeReady` is a miss on an
    empty map for every plugin without a running process — which is all of them
    in a project with no native plugins — so the branch costs a lookup and
    builds no request.

    A native call that is refused, superseded, benched or crashed resolves
    `null`, and the JavaScript or WebAssembly path below runs instead. That is
    the same degradation this function already promises its own caller, so a
    failing addon costs the layer nothing but its fast path.
  */
  if (nativeReady(request.pluginId, 'effect')) {
    const native = await runNativeEffect({
      pluginId: request.pluginId,
      effectId: request.effect.id,
      instanceId: request.instanceId,
      pixels: request.pixels,
      width: request.width,
      height: request.height,
      params: request.params,
      host: request.host,
      ...(request.neighbours && request.neighbours.length > 0 ? { neighbours: request.neighbours } : {}),
      ...(request.effect.threadSafety ? { threadSafety: request.effect.threadSafety } : {}),
      // The effect's own declaration of what busts the state it keeps between
      // frames. Passed from the manifest rather than inferred: only the author
      // knows whether their cached flow field depends on a slider.
      ...(request.effect.invalidateOn ? { invalidateOn: request.effect.invalidateOn } : {}),
    });
    if (native) return native;
  }

  const module = await loadKernelModule(request.pluginId, request.effect);
  if (!module) return null;

  const job: KernelJob = {
    effectId: request.effectId,
    module,
    pixels: request.pixels,
    width: request.width,
    height: request.height,
    params: request.params,
    host: request.host,
    instanceId: request.instanceId,
    ...(request.neighbours && request.neighbours.length > 0 ? { neighbours: request.neighbours } : {}),
  };

  const pool = kernelScheduler();
  if (!pool) {
    // No workers here (jsdom, a browser without them). The SAME function the
    // worker runs, on this thread — slower, and never a different picture.
    return runKernelJob(job);
  }

  const safety = request.effect.threadSafety;
  const lane = laneFor(safety, request.pluginId, request.instanceId, nextJobSeq());
  const outcome: KernelOutcome | null = await pool.submit(lane, job, {
    // A `full` effect's lane is unique per job, so there is nothing to coalesce
    // against — see the note in `kernelPool`.
    coalesce: safety !== 'full',
  });
  return outcome ? outcome.pixels : null;
}

let jobSeq = 0;
const nextJobSeq = (): number => ++jobSeq;

/** Test seam: forget module bytes AND the job counter, so lanes are comparable. */
export function resetKernelHostForTests(): void {
  sources.clear();
  reader = null;
  jobSeq = 0;
}
