/**
 * framePerf — per-stage timings for the viewport's render tick.
 *
 * The HUD used to show one number, the wall time of the whole tick, which
 * answers "is it slow" and nothing about WHERE. This splits that tick into the
 * stages every frame actually walks, so a change to any one of them can be
 * measured before and after instead of argued about:
 *
 *   snapshot       buildSnapshot — the scene walk (useWorkspace)
 *   flatten        snapshotToFrameScene — snapshot → renderer scene
 *   textureFeed    MotionRendererBackend's per-frame texture feed walk
 *   raster         vector/text rasterisation inside the feed (count + ms)
 *   bake           CPU effect-chain bakes inside the feed (count + ms)
 *   gpuSubmit      renderer.render — pass encoding and queue submit
 *   cacheReadback  copying a finished frame into the RAM preview
 *   total          the whole render tick, cache blits excluded
 *   gpuTime        the GPU's OWN time for a frame's passes, from WebGPU
 *                  timestamp queries (see below) — not a CPU stage at all
 *
 * Stages NEST where the code does: `textureFeed` contains `raster` and `bake`,
 * and `total` contains everything. They are not meant to sum.
 *
 * ## `gpuTime` lags
 *
 * Every other stage is measured on the CPU inside the frame it belongs to.
 * `gpuTime` is read back from a mapped buffer once the GPU has finished the
 * frame's command buffer, which is one to three frames AFTER that frame was
 * submitted — and it arrives outside any open frame. `reportGpuTime` therefore
 * attributes it to the most recently COMMITTED frame in the ring, so the
 * `gpuTime` column of frame N usually holds the GPU time of frame N-1 or N-2.
 * Over a rolling window that is the same distribution; per-frame it is off by
 * the pipeline depth, and nothing should correlate it with the CPU columns of
 * the same row. Frames with no readback hold 0 with a run count of 0, so
 * `mean / perFrame` is the mean over frames that were measured.
 *
 * Only WebGPU with the `timestamp-query` feature reports it. WebGL2, the null
 * backend, SwiftShader and an adapter without the feature never call
 * `reportGpuTime`, and the stage stays at zero with `perFrame` 0 — the HUD
 * shows "n/a" for that, never "0 ms".
 *
 * ## VRAM
 *
 * `reportGpuMemory` carries the renderer's byte estimate (its ResourceManager
 * counts what it allocates; see `packages/renderer/src/gpu/gpuMemory.ts`).
 * It is a gauge, not a per-frame timing: `sample()` reports the latest value
 * and the peak the renderer has seen.
 *
 * ## Cost
 *
 * The hot path allocates nothing: stages are small integers, timings go into
 * preallocated Float64Array rings, and an open stage is one slot in a typed
 * array. A begin/end pair outside an open frame is a single branch and records
 * nothing — so the idle pre-render pump, export and thumbnail renders that go
 * through the same code do not pollute the viewport's numbers.
 *
 * `sample()` (which sorts for the p95) runs on the HUD's timer, never per frame.
 *
 * ## Dev access
 *
 * `window.__motionPerf` in development: `sample()`, `reset()`, and
 * `userTiming = true` to mirror every stage into `performance.measure` so the
 * DevTools Performance panel shows them on its timeline (allocates; off by
 * default).
 */

export const PERF_STAGES = [
  'snapshot',
  'flatten',
  'textureFeed',
  'raster',
  'bake',
  'gpuSubmit',
  'cacheReadback',
  'total',
  'gpuTime',
] as const;

export type PerfStageName = (typeof PERF_STAGES)[number];

/** Stage ids for the begin/end calls — numbers, so the hot path indexes arrays. */
export const PerfStage = {
  snapshot: 0,
  flatten: 1,
  textureFeed: 2,
  raster: 3,
  bake: 4,
  gpuSubmit: 5,
  cacheReadback: 6,
  total: 7,
  gpuTime: 8,
} as const satisfies Record<PerfStageName, number>;

export type PerfStageId = (typeof PerfStage)[PerfStageName];

const STAGE_COUNT = PERF_STAGES.length;

/** Frames the rolling statistics cover — two seconds at 60 fps. */
export const PERF_WINDOW = 120;

export interface PerfStageStats {
  /** Rolling mean over the window, ms per frame (frames where the stage did not run count as 0). */
  mean: number;
  /** 95th percentile over the window, ms. */
  p95: number;
  /** The most recent committed frame, ms. */
  last: number;
  /** Mean times the stage ran per frame (a raster count, say). */
  perFrame: number;
}

export interface PerfSample {
  /** Frames currently in the window. */
  frames: number;
  stages: Record<PerfStageName, PerfStageStats>;
  /** Mean GPU completion latency after submit, ms — null when not measured. */
  gpuDoneMs: number | null;
  /** Renderer's estimated GPU memory in use, bytes — null until a renderer reports. */
  gpuBytes: number | null;
  /** High-water mark of `gpuBytes` — null until a renderer reports. */
  gpuBytesPeak: number | null;
}

const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

class FramePerf {
  /** Ring of committed per-frame ms, STAGE_COUNT × PERF_WINDOW. */
  private readonly ms = new Float64Array(STAGE_COUNT * PERF_WINDOW);
  /** Ring of committed per-frame run counts, same layout. */
  private readonly counts = new Float64Array(STAGE_COUNT * PERF_WINDOW);
  /** This frame's accumulators. */
  private readonly accMs = new Float64Array(STAGE_COUNT);
  private readonly accCount = new Float64Array(STAGE_COUNT);
  /** Outermost start time of an open stage, and its nesting depth. */
  private readonly openAt = new Float64Array(STAGE_COUNT);
  private readonly depth = new Int32Array(STAGE_COUNT);
  private readonly scratch = new Float64Array(PERF_WINDOW);
  private head = 0;
  private filled = 0;
  private frameOpen = false;
  private gpuDoneAcc = 0;
  private gpuDoneN = 0;
  private gpuBytes = -1;
  private gpuBytesPeak = -1;

  /** Mirror stages into `performance.measure` (DevTools). Allocates — dev only. */
  userTiming = false;
  /** Master switch. Off, every call is a single branch. */
  enabled = true;

  /** Open a frame: stages recorded until `endFrame` belong to it. */
  beginFrame(): void {
    if (!this.enabled) return;
    this.accMs.fill(0);
    this.accCount.fill(0);
    this.depth.fill(0);
    this.frameOpen = true;
  }

  /**
   * Close the frame. `commit = false` discards it — a RAM-preview blit is not
   * a render and must not dilute the stage means with zeros.
   */
  endFrame(commit = true): void {
    if (!this.frameOpen) return;
    this.frameOpen = false;
    if (!commit) return;
    const base = this.head * STAGE_COUNT;
    for (let s = 0; s < STAGE_COUNT; s++) {
      this.ms[base + s] = this.accMs[s]!;
      this.counts[base + s] = this.accCount[s]!;
    }
    this.head = (this.head + 1) % PERF_WINDOW;
    if (this.filled < PERF_WINDOW) this.filled++;
  }

  /** Whether a frame is open (callers never need this; tests do). */
  get inFrame(): boolean {
    return this.frameOpen;
  }

  begin(stage: PerfStageId): void {
    if (!this.frameOpen) return;
    const d = this.depth[stage]!;
    this.depth[stage] = d + 1;
    if (d === 0) this.openAt[stage] = now();
  }

  end(stage: PerfStageId): void {
    if (!this.frameOpen) return;
    const d = this.depth[stage]!;
    if (d === 0) return;
    this.depth[stage] = d - 1;
    if (d !== 1) return;
    const start = this.openAt[stage]!;
    const t = now();
    this.accMs[stage] = this.accMs[stage]! + (t - start);
    this.accCount[stage] = this.accCount[stage]! + 1;
    if (this.userTiming) this.measure(stage, start, t);
  }

  /** Add a duration measured elsewhere (a worker, an async readback). */
  add(stage: PerfStageId, ms: number): void {
    if (!this.frameOpen || !Number.isFinite(ms)) return;
    this.accMs[stage] = this.accMs[stage]! + ms;
    this.accCount[stage] = this.accCount[stage]! + 1;
  }

  /** GPU completion latency after a submit (`onSubmittedWorkDone`), any time. */
  reportGpuDone(ms: number): void {
    if (!this.enabled || !Number.isFinite(ms)) return;
    this.gpuDoneAcc += ms;
    this.gpuDoneN += 1;
  }

  /**
   * A frame's GPU time from a completed timestamp readback (see "`gpuTime`
   * lags" above). Attributed to the most recently committed frame; a second
   * report before the next commit replaces the first. Nothing is recorded
   * until a frame has been committed — a readback from the idle pre-render
   * pump or an export has no viewport frame to describe.
   */
  reportGpuTime(ms: number): void {
    if (!this.enabled || !Number.isFinite(ms) || this.filled === 0) return;
    const lastIdx = (this.head - 1 + PERF_WINDOW) % PERF_WINDOW;
    const i = lastIdx * STAGE_COUNT + PerfStage.gpuTime;
    this.ms[i] = ms;
    this.counts[i] = 1;
  }

  /** The renderer's VRAM estimate, any time. Latest value wins; the peak is the renderer's. */
  reportGpuMemory(bytes: number, peak: number): void {
    if (!this.enabled || !Number.isFinite(bytes) || !Number.isFinite(peak)) return;
    this.gpuBytes = bytes;
    this.gpuBytesPeak = peak;
  }

  sample(): PerfSample {
    const n = this.filled;
    const stages = {} as Record<PerfStageName, PerfStageStats>;
    const lastIdx = (this.head - 1 + PERF_WINDOW) % PERF_WINDOW;
    for (let s = 0; s < STAGE_COUNT; s++) {
      let sum = 0;
      let countSum = 0;
      for (let i = 0; i < n; i++) {
        const v = this.ms[i * STAGE_COUNT + s]!;
        this.scratch[i] = v;
        sum += v;
        countSum += this.counts[i * STAGE_COUNT + s]!;
      }
      let p95 = 0;
      if (n > 0) {
        const view = this.scratch.subarray(0, n);
        view.sort();
        p95 = view[Math.min(n - 1, Math.floor(n * 0.95))]!;
      }
      stages[PERF_STAGES[s]!] = {
        mean: n ? sum / n : 0,
        p95,
        last: n ? this.ms[lastIdx * STAGE_COUNT + s]! : 0,
        perFrame: n ? countSum / n : 0,
      };
    }
    const gpuDoneMs = this.gpuDoneN > 0 ? this.gpuDoneAcc / this.gpuDoneN : null;
    // The GPU figure is a since-last-sample mean: it arrives asynchronously and
    // has no frame to ride in.
    this.gpuDoneAcc = 0;
    this.gpuDoneN = 0;
    return {
      frames: n,
      stages,
      gpuDoneMs,
      gpuBytes: this.gpuBytes >= 0 ? this.gpuBytes : null,
      gpuBytesPeak: this.gpuBytesPeak >= 0 ? this.gpuBytesPeak : null,
    };
  }

  reset(): void {
    this.ms.fill(0);
    this.counts.fill(0);
    this.head = 0;
    this.filled = 0;
    this.frameOpen = false;
    this.gpuDoneAcc = 0;
    this.gpuDoneN = 0;
    this.gpuBytes = -1;
    this.gpuBytesPeak = -1;
  }

  private measure(stage: PerfStageId, start: number, end: number): void {
    try {
      performance.measure(`motion:${PERF_STAGES[stage]}`, { start, end });
    } catch {
      /* User Timing L3 unavailable — the rings still have the number */
    }
  }
}

/** The viewport's frame timings. One per app: there is one interactive viewport. */
export const framePerf = new FramePerf();

// Free-function aliases keep instrumented call sites to one short line.
export const perfBegin = (stage: PerfStageId): void => framePerf.begin(stage);
export const perfEnd = (stage: PerfStageId): void => framePerf.end(stage);

/**
 * Expose `window.__motionPerf` in development builds. Idempotent. Called by
 * the viewport when it attaches, so nothing pays for it at import time.
 */
export function installPerfDevGlobal(): void {
  const isDev = typeof process !== 'undefined' && process.env ? process.env.NODE_ENV === 'development' : true;
  if (!isDev || typeof window === 'undefined') return;
  const w = window as unknown as { __motionPerf?: unknown };
  if (w.__motionPerf) return;
  w.__motionPerf = {
    sample: () => framePerf.sample(),
    reset: () => framePerf.reset(),
    get userTiming() { return framePerf.userTiming; },
    set userTiming(on: boolean) { framePerf.userTiming = on; },
    get enabled() { return framePerf.enabled; },
    set enabled(on: boolean) { framePerf.enabled = on; },
    stages: PERF_STAGES,
  };
}

/**
 * Measure GPU completion for one submit, when the device can tell us.
 *
 * `GPUQueue.onSubmittedWorkDone()` resolves once the GPU has finished every
 * command buffer submitted so far — no `timestamp-query` feature needed, so it
 * works on every WebGPU adapter. Feature-detected: anything without the method
 * (WebGL2, the null backend, a test double) is a silent no-op. The promise is
 * the only allocation, and it is taken only when the HUD is open.
 */
export function measureGpuDone(queue: unknown): void {
  const q = queue as { onSubmittedWorkDone?: () => Promise<void> } | null | undefined;
  if (!framePerf.enabled || !q || typeof q.onSubmittedWorkDone !== 'function') return;
  const start = now();
  q.onSubmittedWorkDone().then(
    () => framePerf.reportGpuDone(now() - start),
    () => { /* device lost mid-frame: no sample */ },
  );
}
