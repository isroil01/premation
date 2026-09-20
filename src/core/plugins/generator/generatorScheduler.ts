/**
 * When a generator's plugin code runs, and what the frame shows while it does.
 *
 * ── The constraint everything here follows from ──────────────────────────────
 *
 * Plugin JS cannot run inside the render loop. It lives in a Worker behind
 * `postMessage`, so reaching it is asynchronous by construction; and even if it
 * were not, a per-frame callback that can take an arbitrary amount of time
 * cannot sit on the path between "the playhead moved" and "pixels". A generator
 * that took 40 ms would not slow playback down, it would stop it.
 *
 * So the render path never waits. `requestGeneratorFrame` is SYNCHRONOUS: it
 * returns whatever instance data is available right now — the exact frame if it
 * has been produced, otherwise the most recent one — and schedules the rest. The
 * consequences of that choice, all deliberate:
 *
 *   · **Preview never blanks.** Holding the previous frame's instances for a
 *     frame or two reads as a particle system that is a hair behind the
 *     playhead. Showing nothing reads as the plugin being broken, and users
 *     report it as one.
 *   · **Scrubbing is latest-wins.** A drag across a second of timeline asks for
 *     sixty frames nobody will ever look at. Only the newest pending request
 *     survives; the others are dropped before any work is done on them. This is
 *     the same rule the video decoder's `latest` lane follows, for the same
 *     reason.
 *   · **Export awaits the exact frame.** A deliverable that showed frame 118's
 *     particles at frame 120 would be wrong in a file, silently, and "wrong
 *     pixels in a file are not recoverable". `settleGenerators` is how the
 *     offline renderer blocks until the exact frames land, and a timeout there
 *     becomes a DIAGNOSTIC that refuses the frame rather than a shrug.
 *   · **Playback looks ahead.** During playback the next frames are already
 *     known, so they are requested before they are needed — which is what turns
 *     "a hair behind" into "exactly on time" for a simulation that costs less
 *     than a frame interval to step.
 *
 * ── Zero cost when nothing uses it ───────────────────────────────────────────
 *
 * Every entry point is a map lookup on an empty map until a generator layer
 * exists in the document. `buildSnapshot` calls in here once per generator
 * layer and never otherwise; a project without one never allocates anything
 * this module owns.
 */

import {
  validateGeneratorFrame,
  type GeneratorFrame,
  type GeneratorFrameRequest,
} from './generatorContract';
import {
  createStateCache,
  planSeek,
  recordFrame,
  resetStateCache,
  type GeneratorStateCache,
} from './generatorState';
import { nativeReady, runNativeGenerate } from '../native/nativeClient';

/**
 * How long one `generate` call may take before it is treated as a failure.
 *
 * Generous by the standards of a frame and stingy by the standards of a plugin
 * doing real work, which is the correct place for it to sit: a simulation that
 * takes longer than this per frame cannot be previewed at all, so the useful
 * answer is a named plugin error rather than a viewport that appears frozen.
 */
export const GENERATE_BUDGET_MS = 2_000;

/** The export budget. Longer, for the same reason `EXPORT_STEP_TIMEOUT_MS` is:
 *  a frame that takes two seconds is a slow export, not a broken plugin. */
export const GENERATE_EXPORT_BUDGET_MS = 20_000;

/**
 * Consecutive failures before a layer stops asking.
 *
 * A generator that throws throws every frame, and re-running it sixty times a
 * second turns one bug into a wedged editor. The third failure disables the
 * layer's requests until something about it changes — which is what the user
 * doing anything at all to the layer produces.
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Exact frames kept per layer, for export and for holding across a stall. */
const MAX_CACHED_FRAMES = 8;

/** What the scheduler needs to reach plugin code. Narrow on purpose: it is a
 *  seam, and the tests drive it with a plain function. */
export interface GeneratorRunner {
  generate(
    pluginId: string,
    kindId: string,
    request: GeneratorFrameRequest,
    timeoutMs: number,
  ): Promise<unknown>;
}

/** One frame's demand, as the snapshot builder states it. */
export interface GeneratorDemand {
  layerId: string;
  pluginId: string;
  kindId: string;
  /** Everything but `state`, which the host owns. */
  request: Omit<GeneratorFrameRequest, 'state'>;
  /** Frames to prefetch past `request.frame`. 0 while paused. */
  lookAhead?: number;
  /** The caller will await this exact frame (export). */
  exact?: boolean;
}

/** A generator failure, as the user sees it. */
export interface GeneratorError {
  layerId: string;
  pluginId: string;
  kindId: string;
  message: string;
}

interface LayerEntry {
  pluginId: string;
  kindId: string;
  /** Identity of the SIMULATION — a change invalidates the past. */
  key: string;
  state: GeneratorStateCache;
  frames: Map<number, GeneratorFrame>;
  /**
   * What the PARAMETERS were when each cached frame was produced.
   *
   * Kept beside `frames` rather than inside `GeneratorFrame`, which is the
   * shape the renderer consumes and has no business carrying the scheduler's
   * bookkeeping.
   */
  frameParams: Map<number, string>;
  /** The newest frame produced, whatever its number. Served when the exact one
   *  is not ready, which is what "never blank" means. */
  latest: GeneratorFrame | null;
  pending: GeneratorDemand | null;
  running: boolean;
  failures: number;
  /** The frame the last request asked for, and whether it followed the one
   *  before it — the scheduler's own test for "the transport is running". */
  lastFrame: number | null;
  sequential: boolean;
  /** Resolvers waiting for an exact frame (export). */
  waiters: Map<number, Array<() => void>>;
}

const layers = new Map<string, LayerEntry>();
let runner: GeneratorRunner | null = null;
let revisionSeq = 0;
let errors: GeneratorError[] | null = null;
/** Export mode: longer budget, no look-ahead, every request exact. */
let exactMode = false;

/** Install the thing that can actually call plugin code. */
export function setGeneratorRunner(next: GeneratorRunner | null): void {
  runner = next;
}

/** True when this document has asked for a generator frame at all. The one
 *  question `buildSnapshot` may ask on a project that has no generators. */
export function hasGeneratorLayers(): boolean {
  return layers.size > 0;
}

/**
 * Export mode.
 *
 * Global rather than per-request because it changes what a REQUEST MEANS: in
 * export every frame is awaited exactly and nothing is prefetched, since the
 * loop is already walking frames in order and a look-ahead would compete with
 * the frame being waited on.
 */
export function setGeneratorExactMode(on: boolean): void {
  exactMode = on;
}

/**
 * Ask for a frame and get what is available now.
 *
 * The exact frame when it exists, the newest one otherwise, and null only when
 * this layer has never produced anything — the one case where there is nothing
 * to hold and the layer draws empty for a frame or two.
 */
export function requestGeneratorFrame(demand: GeneratorDemand): GeneratorFrame | null {
  const key = simulationKey(demand);
  let entry = layers.get(demand.layerId);
  if (!entry || entry.key !== key) {
    // A different simulation: the seed changed, or the layer was re-kinded.
    // Its past is not this simulation's past, so none of it carries over.
    entry = {
      pluginId: demand.pluginId,
      kindId: demand.kindId,
      key,
      state: createStateCache(),
      frames: new Map(),
      frameParams: new Map(),
      latest: null,
      pending: null,
      running: false,
      failures: 0,
      lastFrame: null,
      sequential: false,
      waiters: new Map(),
    };
    layers.set(demand.layerId, entry);
  }

  const frame = Math.trunc(demand.request.frame);
  /*
    Is the playhead RUNNING?

    Asked here rather than read from the transport, because what look-ahead
    actually needs to know is whether the next frame is predictable — and the
    request pattern says that directly. Playback asks for n, n+1, n+2; a scrub
    jumps; a paused viewport re-asks for the same frame. Only the first of those
    should spend work on frames nobody has asked for yet.

    Re-asking for the SAME frame (a repaint) leaves the verdict alone rather
    than clearing it: a playing comp that stalls for one frame should not lose
    its runway and then have to earn it back.
  */
  if (entry.lastFrame !== null && frame !== entry.lastFrame) {
    entry.sequential = frame === entry.lastFrame + 1;
  }
  entry.lastFrame = frame;

  /*
    A cached frame is only the frame that was ASKED FOR if its parameters still
    match.

    The playhead standing still is the common case while a user works: they drag
    a property and watch. The frame number does not change, so a cache keyed on
    the frame number alone answers every repaint with the geometry from before
    the edit — the viewport freezes, and the plugin looks broken while the
    inspector insists the value changed. (Export never saw it: `exactMode` asks
    for every frame regardless.)

    So the params are part of the cache key. `paramsKey` is a stringify of the
    sampled properties — at most a few dozen scalars, built in the kind's own
    declared order — and it costs a few microseconds against a frame that costs
    milliseconds.
  */
  const params = paramsKey(demand);
  const have = entry.frames.get(frame);
  const stale = have !== undefined && entry.frameParams.get(frame) !== params;
  if (stale) {
    entry.frames.delete(frame);
    entry.frameParams.delete(frame);
  }
  if (!have || stale || exactMode || demand.exact) {
    // Re-stating the demand for a frame already served is what keeps the
    // look-ahead moving during playback; the pump drops it as a no-op when the
    // frame is cached and nothing further is wanted.
    entry.pending = demand;
    void pump(demand.layerId);
  }
  return (stale ? undefined : have) ?? entry.latest;
}

/**
 * The identity of a request's parameters.
 *
 * Deliberately the whole params object rather than a hash: a hash would be
 * smaller and would collide, and a collision here is a frame that silently
 * refuses to update — the exact bug this key exists to prevent.
 */
function paramsKey(demand: GeneratorDemand): string {
  try {
    return JSON.stringify(demand.request.params);
  } catch {
    // A parameter that cannot be stringified (a cycle, a BigInt) is not
    // something the prop schema can produce, but a key that throws would take
    // the render down. An empty key means "always a miss", which is slow and
    // correct rather than fast and wrong.
    return '';
  }
}

/**
 * Wait until every layer that has an outstanding EXACT demand has served it.
 *
 * Resolves with the layers that did not make it. The caller (the offline
 * renderer) turns those into per-layer diagnostics, so a generator that wedged
 * refuses the frame instead of exporting the previous frame's particles under
 * this frame's number.
 */
export async function settleGenerators(timeoutMs: number): Promise<string[]> {
  const waits: Array<Promise<string | null>> = [];
  for (const [layerId, entry] of layers) {
    const demand = entry.pending;
    if (!demand) continue;
    const frame = Math.trunc(demand.request.frame);
    if (entry.frames.has(frame)) continue;
    waits.push(waitForFrame(layerId, entry, frame, timeoutMs));
  }
  if (waits.length === 0) return [];
  const settled = await Promise.all(waits);
  return settled.filter((id): id is string => id !== null);
}

function waitForFrame(
  layerId: string,
  entry: LayerEntry,
  frame: number,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(layerId);
    }, timeoutMs);
    const list = entry.waiters.get(frame) ?? [];
    list.push(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(entry.frames.has(frame) ? null : layerId);
    });
    entry.waiters.set(frame, list);
  });
}

/**
 * The box the newest produced frame occupies, in LAYER px around the centre —
 * or null for a layer that has never produced one.
 *
 * Read by the workspace's geometry, so selection, the marquee and the outline
 * follow the particles rather than the emitter box the property panel happens
 * to hold. Cheap: the bounds were measured once when the frame was validated
 * (or declared by the plugin), and this is the stored result.
 */
export function latestGeneratorBounds(
  layerId: string,
): { x: number; y: number; width: number; height: number } | null {
  return layers.get(layerId)?.latest?.bounds ?? null;
}

/** Errors raised since the last call, and forget them. Shaped like
 *  `takeSceneLayerErrors` so the surfacing side has one habit, not two. */
export function takeGeneratorErrors(): GeneratorError[] | null {
  const out = errors;
  errors = null;
  return out;
}

/** Drop everything — a document closed, or a plugin stopped. */
export function resetGenerators(layerId?: string): void {
  if (layerId === undefined) {
    layers.clear();
    errors = null;
    return;
  }
  const entry = layers.get(layerId);
  if (entry) {
    resetStateCache(entry.state);
    layers.delete(layerId);
  }
}

/**
 * Forget everything one plugin's kinds produced — it stopped, or was
 * uninstalled.
 *
 * Its layers keep their properties and their place in the document (see
 * `customLayers.ts`); what goes is the cached geometry, because holding it
 * would mean a stopped plugin's particles carrying on drawing, which is a
 * worse lie than an empty layer.
 */
export function resetGeneratorsForPlugin(pluginId: string): void {
  for (const [layerId, entry] of [...layers]) {
    if (entry.pluginId === pluginId) layers.delete(layerId);
  }
}

/** Test seam, and the teardown a stopped plugin needs. */
export function resetGeneratorsForTests(): void {
  layers.clear();
  runner = null;
  errors = null;
  exactMode = false;
  revisionSeq = 0;
}

function simulationKey(demand: GeneratorDemand): string {
  return `${demand.pluginId}.${demand.kindId}#${demand.request.seed}`;
}

/**
 * Drive one layer's queue until nothing is pending.
 *
 * Re-entrant by design: `running` is the lock, and the loop re-reads `pending`
 * after every await so a request that arrived mid-frame supersedes the one that
 * was about to run. That is the whole of "latest-wins" — no cancellation
 * message, no bookkeeping, just never starting work nobody is waiting for.
 */
async function pump(layerId: string): Promise<void> {
  const entry = layers.get(layerId);
  if (!entry || entry.running) return;
  const active = runner;
  if (!active) return;
  entry.running = true;
  try {
    for (;;) {
      const demand = entry.pending;
      if (!demand) break;
      if (entry.failures >= MAX_CONSECUTIVE_FAILURES) {
        // Woken rather than left to time out: an export blocked on this frame
        // should refuse NOW, naming the plugin, instead of spending the settle
        // budget waiting for work that is no longer being attempted.
        entry.pending = null;
        wake(entry, Math.trunc(demand.request.frame));
        break;
      }

      const target = Math.trunc(demand.request.frame);
      if (entry.frames.has(target)) {
        // The frame is here. Either prefetch the next one or stop; clearing
        // `pending` first is what stops a look-ahead from looping forever.
        entry.pending = null;
        const next = nextLookAhead(entry, demand);
        if (next) entry.pending = next;
        continue;
      }

      /*
        Is this generator stateful? On the very first frame nobody knows.

        `planSeek` answers "run one frame from nothing" while the question is
        open, because the alternative — replaying four hundred frames to serve
        the frame the playhead is already on, in case the plugin turns out to
        carry state — makes every generator feel broken on the frame it
        appears. That probe frame is the right answer for a STATELESS generator
        and for frame 0, and it is a guess everywhere else.

        So the guess is never kept: if the probe comes back carrying state and
        the target was not frame 0, the whole cache is thrown away and the seek
        re-planned properly from the start. The probe's geometry stays as
        `latest` — the viewport shows something plausible for a turn instead of
        nothing — but it is removed from the by-frame cache, so neither a
        later scrub back to it nor an export can serve it. Determinism is the
        claim this whole module exists to make; a first-request-wins frame would
        break it in the one way nobody would ever suspect.
      */
      const statefulnessUnknown = entry.state.stateful === undefined;
      const plan = planSeek(entry.state, target);
      let failed = false;
      for (const frame of plan.frames) {
        // Re-check on every step: a 48-frame catch-up is the one place a
        // superseding request has real work to interrupt.
        if (entry.pending !== demand && entry.pending !== null) break;
        const request: GeneratorFrameRequest = {
          ...demand.request,
          frame,
          // The non-target frames of a catch-up are simulation steps, not
          // frames anybody will look at, so their times are derived rather
          // than sampled — the plugin's params for an intermediate frame are
          // the ones it was given for the target, which is a real limitation
          // and documented as one in docs/PLUGINS.md.
          ...(frame === target ? {} : {
            compTime: demand.request.compTime + (frame - target) / demand.request.fps,
            layerTime: demand.request.layerTime + (frame - target) / demand.request.fps,
          }),
          // The first frame of the plan starts from wherever `planSeek` said;
          // every frame after it starts from the one just recorded.
          state: frame === plan.frames[0] ? plan.state : entry.state.cursor?.state,
        };
        const budget = exactMode || demand.exact ? GENERATE_EXPORT_BUDGET_MS : GENERATE_BUDGET_MS;
        let raw: unknown;
        try {
          raw = await withTimeout(
            generateOne(entry, layerId, active, request, budget),
            budget,
            `generate() for frame ${frame} did not finish within ${budget} ms.`,
          );
        } catch (err) {
          recordFailure(entry, layerId, err instanceof Error ? err.message : String(err));
          failed = true;
          break;
        }

        const result = validateGeneratorFrame(
          raw,
          (revisionSeq += 1),
          demand.request.layerSize,
        );
        if ('error' in result) {
          recordFailure(entry, layerId, result.error);
          failed = true;
          break;
        }
        entry.failures = 0;
        // A textured frame names a file in its plugin's package; whoever
        // resolves it needs to know whose package. Stamped here rather than in
        // the validator, which never learns which layer it is validating for.
        if (result.frame.textureAssetKey !== undefined) result.frame.pluginId = entry.pluginId;
        recordFrame(entry.state, frame, (raw as { state?: unknown }).state);
        // Only the TARGET's instances are kept. A catch-up frame's buffer is a
        // megabyte nobody will draw, and holding forty-eight of them to reach
        // one is how a scrub becomes an out-of-memory.
        if (frame === target) store(entry, frame, result.frame, paramsKey(demand));
      }

      if (failed) {
        entry.pending = null;
        wake(entry, target);
        break;
      }
      if (statefulnessUnknown && entry.state.stateful === true && target !== 0) {
        // The probe was computed from no state, and so was the cursor and any
        // checkpoint it wrote. All of it is discarded; only the verdict stays.
        resetStateCache(entry.state);
        entry.state.stateful = true;
        entry.frames.delete(target);
        entry.frameParams.delete(target);
        continue;
      }
      if (plan.truncated) continue; // Another chunk of the same seek.
      wake(entry, target);
      if (entry.pending === demand) {
        entry.pending = nextLookAhead(entry, demand);
      }
    }
  } finally {
    entry.running = false;
    // A request that arrived while the lock was held gets its own turn rather
    // than waiting for the next frame to re-state it.
    if (entry.pending) void pump(layerId);
  }
}

/**
 * One frame's worth of plugin work: the compiled addon if there is one, the
 * plugin's Worker otherwise.
 *
 * Placed here rather than in the pump so the loop above stays one shape. What a
 * native generator returns is the same raw object `validateGeneratorFrame`
 * already takes, so nothing downstream branches on which side produced it —
 * including the checkpoint machinery, which keys on the frame number and knows
 * nothing about runners. Every determinism rule therefore holds unchanged: a
 * catch-up frame comes through here like any other, a superseded request is
 * dropped by the pump's own re-check before the next call, and a native result
 * that never arrives leaves the previous frame on screen exactly as a slow
 * Worker does.
 *
 * `nativeReady` is a miss on an empty map for every plugin without a running
 * process, so a project with no native plugins pays one lookup per generate.
 */
async function generateOne(
  entry: LayerEntry,
  layerId: string,
  active: GeneratorRunner,
  request: GeneratorFrameRequest,
  budget: number,
): Promise<unknown> {
  if (nativeReady(entry.pluginId, 'generate')) {
    const native = await runNativeGenerate({
      pluginId: entry.pluginId,
      generatorId: entry.kindId,
      // The LAYER is the instance: its lane, and whatever per-instance state
      // the addon keeps, are the same thing this scheduler's entry is.
      instanceId: layerId,
      ...request,
    });
    // Refused, superseded, benched or crashed — all `null`, and all mean the
    // plugin's JavaScript is what runs this frame.
    if (native) return native;
  }
  return active.generate(entry.pluginId, entry.kindId, request, budget);
}

/** The next frame to prefetch during playback, or null. */
function nextLookAhead(entry: LayerEntry, demand: GeneratorDemand): GeneratorDemand | null {
  // Export walks frames in order and awaits each; a prefetch there would
  // compete with the frame the encoder is blocked on.
  if (exactMode) return null;
  // Only while the requests look like playback — see `requestGeneratorFrame`.
  if (!entry.sequential) return null;
  const ahead = demand.lookAhead ?? 0;
  if (ahead <= 0) return null;
  const base = Math.trunc(demand.request.frame);
  for (let i = 1; i <= ahead; i++) {
    const f = base + i;
    if (entry.frames.has(f)) continue;
    return {
      ...demand,
      lookAhead: ahead - i,
      request: {
        ...demand.request,
        frame: f,
        compTime: demand.request.compTime + i / demand.request.fps,
        layerTime: demand.request.layerTime + i / demand.request.fps,
      },
    };
  }
  return null;
}

function store(entry: LayerEntry, frame: number, produced: GeneratorFrame, params: string): void {
  entry.frames.set(frame, produced);
  entry.frameParams.set(frame, params);
  entry.latest = produced;
  if (entry.frames.size > MAX_CACHED_FRAMES) {
    // Insertion order is production order, and the oldest produced frame is the
    // one furthest from whatever the playhead is doing now.
    const oldest = entry.frames.keys().next();
    if (!oldest.done) {
      entry.frames.delete(oldest.value);
      entry.frameParams.delete(oldest.value);
    }
  }
}

function wake(entry: LayerEntry, frame: number): void {
  const list = entry.waiters.get(frame);
  if (!list) return;
  entry.waiters.delete(frame);
  for (const fn of list) fn();
}

function recordFailure(entry: LayerEntry, layerId: string, message: string): void {
  entry.failures += 1;
  const out = errors ?? [];
  // One message per layer per collection: a failing generator fails every
  // frame, and the tenth copy of a sentence tells nobody anything the first did
  // not.
  if (!out.some((e) => e.layerId === layerId)) {
    out.push({ layerId, pluginId: entry.pluginId, kindId: entry.kindId, message });
  }
  errors = out;
}

/**
 * Reject if a promise has not settled in time.
 *
 * The runner is given the same budget and is expected to enforce it too; this
 * is the backstop for a runner that cannot — a fake in a test, or a transport
 * whose own timeout was lost. A budget enforced in exactly one place is a
 * budget that stops existing the day that place is refactored.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}
