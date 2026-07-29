/**
 * Spring solver → keyframe baking.
 *
 * ## Why this exists
 *
 * Bezier easing cannot produce the settle characteristic of a spring. A bezier
 * is monotone in its parameter and reaches its target exactly once; a spring
 * crosses the target, comes back, crosses again, each excursion smaller than the
 * last, and the *ratio* between those excursions is what the eye reads as mass.
 * You can fake one overshoot with `y2 > 1`. You cannot fake the second, and
 * every shipped design system — iOS, Material 3, Framer, Figma prototyping —
 * animates UI on springs. It is the single clearest tell between real product
 * motion and product motion that was drawn by hand.
 *
 * ## Why it bakes to keyframes
 *
 * The alternative — a `spring` easing kind evaluated at sample time — would put
 * a second motion evaluator in the engine, and the export path would have to
 * learn about it too. That breaks the invariant that **every render path is the
 * deterministic offline path**: the preview and the export would be two
 * implementations of the same curve, which is exactly how they drift.
 *
 * So the spring is solved here, at author time, into ordinary keyframes at the
 * composition's frame rate. The renderer, the exporter, the graph editor and the
 * timing linter all see the same thing they always saw: keyframes. Nothing
 * downstream learns that springs exist.
 *
 * This file is pure — no DOM, no engine. Same seed, same output, always.
 */

/** Physical spring parameters. Mass is rarely worth changing; stiffness and damping are. */
export interface SpringParams {
  /** Higher = faster, tighter. iOS-ish default 180. */
  stiffness: number;
  /** Higher = less bounce. Critical damping is 2·√(stiffness·mass). */
  damping: number;
  /** Higher = more inertia, slower start and longer settle. */
  mass: number;
  /** Initial velocity in value-units/second — a spring handed off from a gesture. */
  velocity?: number;
}

/**
 * Designer-facing presets.
 *
 * Named rather than numeric because "snappy" is the vocabulary a designer
 * actually briefs in, and because a caster choosing from five names produces
 * consistent output where a caster inventing (stiffness, damping) pairs does
 * not. The numbers are tuned so that:
 *   - `gentle` never overshoots (over-damped) — correct for shadows, colour,
 *     backdrop blur, anything where a bounce reads as a glitch;
 *   - `snappy` overshoots ~2%, the UI-appropriate ceiling;
 *   - `bouncy` overshoots ~10%, which is expressive and WRONG for product UI —
 *     the UI motion linter flags it above 4%.
 */
export const SPRING_PRESETS = {
  gentle: { stiffness: 120, damping: 26, mass: 1 },
  snappy: { stiffness: 320, damping: 30, mass: 1 },
  bouncy: { stiffness: 260, damping: 14, mass: 1 },
  stiff: { stiffness: 520, damping: 40, mass: 1 },
  molasses: { stiffness: 60, damping: 24, mass: 1.6 },
} as const satisfies Record<string, SpringParams>;

export type SpringPresetName = keyof typeof SPRING_PRESETS;

export function resolveSpring(
  spec: SpringPresetName | SpringParams | undefined,
): SpringParams {
  if (spec === undefined) return { ...SPRING_PRESETS.snappy };
  if (typeof spec === 'string') return { ...SPRING_PRESETS[spec] };
  return spec;
}

/** Damping ratio ζ: <1 under-damped (bounces), =1 critical, >1 over-damped. */
export function dampingRatio(p: SpringParams): number {
  return p.damping / (2 * Math.sqrt(Math.max(1e-9, p.stiffness * p.mass)));
}

export interface SpringSample {
  /** Seconds since the spring started. */
  t: number;
  value: number;
}

export interface BakeOptions {
  from: number;
  to: number;
  spring: SpringParams;
  /** Frames per second to bake at — the composition's fps. */
  fps: number;
  /**
   * Settle threshold as a fraction of the total travel. The spring is considered
   * at rest once |value − to| stays below this for a few consecutive frames.
   */
  restThreshold?: number;
  /** Hard cap so an under-damped, low-stiffness spring can't bake 40 seconds. */
  maxDurationSec?: number;
}

const DEFAULT_REST_THRESHOLD = 0.001;
const DEFAULT_MAX_DURATION_SEC = 4;
/** Consecutive at-rest frames required before we stop. One is not enough — a
 *  spring passes through its target at speed on the way to the far excursion. */
const REST_FRAMES = 3;

/**
 * Closed-form damped harmonic oscillator, evaluated per frame.
 *
 * Analytic rather than numerically integrated on purpose: Euler/RK4 accumulate
 * error, so the same spring baked at 24fps and 60fps would settle to slightly
 * different values and a snapshot test of "same seed → identical output" would
 * fail across frame rates. The closed form is exact at every t.
 */
export function sampleSpring(o: BakeOptions, t: number): number {
  const { from, to, spring } = o;
  const { stiffness: k, damping: c, mass: m } = spring;
  const v0 = spring.velocity ?? 0;
  const delta = to - from;
  if (delta === 0 && v0 === 0) return to;

  const wn = Math.sqrt(k / m);            // undamped natural frequency
  const zeta = c / (2 * Math.sqrt(k * m)); // damping ratio

  // Displacement measured FROM the target, so it decays to zero.
  const x0 = -delta;

  if (zeta < 1) {
    // Under-damped: oscillates. This is the case that produces the second
    // overshoot a bezier cannot express.
    const wd = wn * Math.sqrt(1 - zeta * zeta);
    const envelope = Math.exp(-zeta * wn * t);
    const a = x0;
    const b = (v0 + zeta * wn * x0) / wd;
    return to + envelope * (a * Math.cos(wd * t) + b * Math.sin(wd * t));
  }
  if (Math.abs(zeta - 1) < 1e-6) {
    // Critically damped: fastest approach with no overshoot at all.
    const envelope = Math.exp(-wn * t);
    return to + envelope * (x0 + (v0 + wn * x0) * t);
  }
  // Over-damped: two real roots, no overshoot, slower than critical.
  const r = wn * Math.sqrt(zeta * zeta - 1);
  const r1 = -zeta * wn + r;
  const r2 = -zeta * wn - r;
  const c2 = (v0 - r1 * x0) / (r2 - r1);
  const c1 = x0 - c2;
  return to + c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t);
}

export interface BakedSpring {
  /** Frame-aligned samples, `t` in seconds from the start of the spring. */
  samples: readonly SpringSample[];
  /** How long the spring took to settle, seconds. */
  durationSec: number;
  /** Peak excursion past the target as a fraction of travel. 0 = no overshoot. */
  overshoot: number;
  /** True when the hard cap cut the spring off before it settled. */
  truncated: boolean;
}

/**
 * Bake a spring into frame-aligned keyframe samples.
 *
 * The final sample is snapped **exactly** to `to`. Without that, an under-damped
 * spring leaves the property a hair off its target forever, and a later
 * animation that reads the value inherits the error — a class of bug that is
 * invisible in one shot and obvious after five.
 */
export function bakeSpring(o: BakeOptions): BakedSpring {
  const fps = Math.max(1, o.fps);
  const dt = 1 / fps;
  const travel = Math.abs(o.to - o.from) || 1;
  const rest = (o.restThreshold ?? DEFAULT_REST_THRESHOLD) * travel;
  const maxDuration = o.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC;
  const maxFrames = Math.ceil(maxDuration * fps);

  const samples: SpringSample[] = [];
  let restRun = 0;
  let peak = 0;
  let truncated = true;

  for (let f = 0; f <= maxFrames; f++) {
    const t = f * dt;
    const value = sampleSpring(o, t);
    samples.push({ t, value });

    // Overshoot is signed travel past the target, normalized.
    const past = (value - o.to) * Math.sign(o.to - o.from || 1);
    if (past > peak) peak = past;

    if (Math.abs(value - o.to) <= rest) {
      restRun++;
      if (restRun >= REST_FRAMES) {
        truncated = false;
        break;
      }
    } else {
      restRun = 0;
    }
  }

  // Snap the last sample dead on target — see the docstring.
  const last = samples[samples.length - 1]!;
  samples[samples.length - 1] = { t: last.t, value: o.to };

  return {
    samples,
    durationSec: samples[samples.length - 1]!.t,
    overshoot: peak / travel,
    truncated,
  };
}

/**
 * Drop samples that sit on the straight line between their neighbours.
 *
 * A 60fps spring that settles in 500ms is 30 keyframes. Most of them are
 * redundant: during the long exponential tail the curve is locally almost
 * linear, and a keyframe there costs timeline clutter and file size while
 * changing nothing on screen. `tolerance` is in value units.
 *
 * Endpoints are always kept. The first two frames are always kept too — that is
 * where the initial velocity lives, and thinning it flattens the launch.
 *
 * The guarantee is on the **reconstruction**, not on each dropped sample in
 * isolation: every dropped sample lies within `tolerance` of the line between
 * the two samples that actually survived around it. A naive version compared
 * each candidate against its immediate neighbours instead, which let error
 * compound across a run of drops — measured at 4.7× tolerance on a bouncy
 * spring, i.e. visibly flattened motion for a caller who asked for 0.5px.
 */
export function thinSamples(
  samples: readonly SpringSample[],
  tolerance: number,
): readonly SpringSample[] {
  if (samples.length <= 3) return samples;

  const lineValueAt = (a: SpringSample, b: SpringSample, t: number): number => {
    const span = b.t - a.t;
    return span <= 0 ? a.value : a.value + ((b.value - a.value) * (t - a.t)) / span;
  };

  const out: SpringSample[] = [samples[0]!, samples[1]!];
  /** Samples provisionally dropped since the last kept one. */
  let pending: SpringSample[] = [];

  for (let i = 2; i < samples.length - 1; i++) {
    const anchor = out[out.length - 1]!;
    const candidate = samples[i + 1]!;
    const trial = [...pending, samples[i]!];
    // Would dropping this one, on top of everything already dropped, still
    // reconstruct? Check the WHOLE run against the span it would collapse into.
    const withinTolerance = trial.every(
      (s) => Math.abs(s.value - lineValueAt(anchor, candidate, s.t)) <= tolerance,
    );
    if (withinTolerance) {
      pending = trial;
    } else {
      out.push(samples[i]!);
      pending = [];
    }
  }
  out.push(samples[samples.length - 1]!);
  return out;
}
