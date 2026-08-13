/**
 * History-dependent simulation, in a renderer built on random access.
 *
 * ── The problem this exists to solve ────────────────────────────────────────
 *
 * Every other layer in this editor answers `stateAt(t)` immediately, because
 * every other layer is a pure function of time. The particle system is the
 * clearest case: `particleSim.ts` is a CLOSED-FORM emitter whose own header
 * says so — particle `i` is born at `i / birthRate` and its position is the
 * ballistic solution `p0 + v0·age + ½g·age²`. Nothing accumulates, so scrubbing
 * is free.
 *
 * A simulation is defined by the opposite property. Collision, flocking, fluid,
 * AE's Foam / Wave World / Caustics — each frame depends on the one before it,
 * and that is exactly what a closed form cannot express. Two particles bounce
 * off each other or they do not; there is no formula for "where would this be
 * at t=5s" that does not replay how it got there.
 *
 * So the emitter is not a foundation to extend. Its architecture IS the absence
 * of the thing a simulation is. This is the new subsystem, and its whole job is
 * to make a history-dependent layer behave, from the outside, like the pure
 * functions the rest of the renderer assumes.
 *
 * ── The contract that makes that possible ───────────────────────────────────
 *
 * ONE INVARIANT, and everything here exists to hold it:
 *
 *     stateAt(f) does not depend on which frames were asked for before it.
 *
 * Scrub to 200, jump back to 10, play forward to 50, export frames in any
 * order — each must produce bit-identical state to stepping from 0. Without it,
 * a preview and its export disagree, which is the one failure this codebase
 * treats as disqualifying (see MOTION_FORMAT_FREEZE.md: one engine for preview
 * and export).
 *
 * That invariant is what forbids the obvious optimisation. A cache that keeps
 * "the current state" and steps it forward when asked for a later frame is
 * correct only for monotonic playback; the first backward seek silently returns
 * a state from the wrong history. The tests drive access in deliberately hostile
 * orders for this reason.
 *
 * ── Why pre-roll never restarts from zero ───────────────────────────────────
 *
 * The scoping note left this open: "how far a seek may pre-roll before
 * restarting is cheaper". It resolves to NEVER, and for a structural reason
 * rather than a measured one. Restarting means stepping from frame 0, and
 * frame 0's snapshot is pinned and never evicted — so the nearest snapshot at
 * or before any frame is always at least as close as 0 is. Pre-rolling from it
 * can only be cheaper or equal. The question presupposed that a seek might land
 * with no usable snapshot behind it, which pinning makes impossible.
 *
 * ── What is deliberately not here ───────────────────────────────────────────
 *
 * No GPU state. The scoping note observed that ping-pong render targets work on
 * both backends without compute shaders, which remains true and is the right
 * shape for a fluid or a wave field later. It is not needed for the state class
 * this opens with, and putting it in first would have meant designing the seek
 * machinery around a texture round-trip before anything depended on one.
 */

/**
 * A simulation the cache can drive.
 *
 * Both methods MUST be pure with respect to anything outside `state`: no
 * `Date.now()`, no `Math.random()`, no reading a store. A step that consults
 * anything ambient breaks the invariant above in a way no test here can catch,
 * because it will reproduce perfectly inside a single run and diverge between
 * a preview and an export.
 */
export interface Simulation<S> {
  /** State at frame 0. Pure — same output every call. */
  init(): S;
  /**
   * Advance one frame: given state at `frame - 1`, return state at `frame`.
   *
   * May mutate and return `prev`; the cache never hands out a state it also
   * keeps, so in-place stepping is safe and is the cheap path.
   */
  step(prev: S, frame: number): S;
  /** Deep copy. The cache stores copies, so a shallow one corrupts snapshots. */
  clone(state: S): S;
}

export interface SimulationCacheOptions {
  /**
   * Frames between snapshots. The cost knob: a seek pre-rolls at most this many
   * frames, and memory grows as `duration / interval`.
   */
  snapshotInterval?: number;
  /** Cap on retained snapshots, frame 0 excluded — it is pinned. */
  maxSnapshots?: number;
  /**
   * Refuse to pre-roll further than this in one call. A guard against a seek to
   * frame 10^9 hanging the UI, not a correctness device.
   */
  maxPreRoll?: number;
}

const DEFAULTS = { snapshotInterval: 30, maxSnapshots: 64, maxPreRoll: 100_000 } as const;

export class SimulationPreRollLimit extends Error {
  constructor(readonly frame: number, readonly limit: number) {
    super(`simulation: frame ${frame} needs more than ${limit} steps of pre-roll`);
    this.name = 'SimulationPreRollLimit';
  }
}

export interface SimulationStats {
  /** Frames stepped since construction — the cost the cache is hiding. */
  stepped: number;
  /** Calls answered by a snapshot with no stepping at all. */
  hits: number;
  snapshots: number;
}

export class SimulationCache<S> {
  private readonly sim: Simulation<S>;
  private readonly interval: number;
  private readonly maxSnapshots: number;
  private readonly maxPreRoll: number;
  /** frame → state AT that frame. Always holds 0. */
  private readonly snaps = new Map<number, S>();
  /** Insertion recency for eviction; frame 0 never enters it. */
  private readonly recency: number[] = [];
  private stats: SimulationStats = { stepped: 0, hits: 0, snapshots: 0 };

  constructor(sim: Simulation<S>, opts: SimulationCacheOptions = {}) {
    this.sim = sim;
    // A zero or negative interval would snapshot never (or every frame with a
    // modulo by zero), so it is clamped rather than trusted.
    this.interval = Math.max(1, Math.floor(opts.snapshotInterval ?? DEFAULTS.snapshotInterval));
    this.maxSnapshots = Math.max(1, Math.floor(opts.maxSnapshots ?? DEFAULTS.maxSnapshots));
    this.maxPreRoll = Math.max(1, Math.floor(opts.maxPreRoll ?? DEFAULTS.maxPreRoll));
    this.reset();
  }

  /** Drop everything and re-seed. Call when the config changes — a simulation
   *  driven by different parameters is a different history, and reusing
   *  snapshots across that boundary is the one way to get a state that never
   *  existed under either configuration. */
  reset(): void {
    this.snaps.clear();
    this.recency.length = 0;
    this.snaps.set(0, this.sim.clone(this.sim.init()));
    this.stats = { stepped: 0, hits: 0, snapshots: 1 };
  }

  getStats(): SimulationStats {
    return { ...this.stats, snapshots: this.snaps.size };
  }

  /**
   * State at `frame`, independent of every earlier call.
   *
   * The returned object is freshly owned by the caller: it is never a state the
   * cache also holds, so mutating it cannot corrupt a snapshot. That costs one
   * clone on a snapshot-exact hit and nothing at all otherwise, since the
   * stepped state is already a private copy.
   */
  stateAt(frame: number): S {
    // Frames before the start are the initial state rather than an error: a
    // layer whose in-point sits after the playhead asks for negative frames
    // during ordinary scrubbing.
    const target = Math.max(0, Math.floor(frame));

    const base = this.nearestSnapshotAt(target);
    if (base === target) {
      this.stats.hits += 1;
      return this.sim.clone(this.snaps.get(base)!);
    }

    const distance = target - base;
    if (distance > this.maxPreRoll) throw new SimulationPreRollLimit(target, this.maxPreRoll);

    let state = this.sim.clone(this.snaps.get(base)!);
    for (let f = base + 1; f <= target; f++) {
      state = this.sim.step(state, f);
      this.stats.stepped += 1;
      // Snapshot on the way past. A seek that pre-rolls 300 frames leaves the
      // ten intermediate snapshots behind it, so the NEXT seek into that region
      // is cheap — the work is already being done, and only the clone is extra.
      if (f % this.interval === 0 && !this.snaps.has(f)) this.remember(f, state);
    }
    return state;
  }

  /** The largest snapshotted frame ≤ `frame`. Always ≥ 0, because 0 is pinned. */
  private nearestSnapshotAt(frame: number): number {
    if (this.snaps.has(frame)) return frame;
    let best = 0;
    for (const f of this.snaps.keys()) {
      if (f <= frame && f > best) best = f;
    }
    return best;
  }

  private remember(frame: number, state: S): void {
    this.snaps.set(frame, this.sim.clone(state));
    this.recency.push(frame);
    while (this.recency.length > this.maxSnapshots) {
      // Oldest-inserted goes first. Frame 0 is never in `recency`, so it cannot
      // be chosen here — which is what makes `nearestSnapshotAt` total and lets
      // pre-roll never need to restart.
      const victim = this.recency.shift();
      if (victim !== undefined) this.snaps.delete(victim);
    }
  }
}
