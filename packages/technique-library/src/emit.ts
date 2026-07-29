/**
 * Emit helpers — where the craft actually lives.
 *
 * Every technique builds its output from these rather than writing raw keyframe
 * arrays, and that is deliberate: it means the eight craft markers are available
 * as *vocabulary* instead of as discipline. A technique author who reaches for
 * `heroMove` gets anticipation, overshoot and a settle for free, with per-segment
 * beziers already chosen. Getting them by remembering to type three keyframes
 * every time is how the third technique ends up with two.
 *
 * The bezier constants are the opinionated part of this file. They are not
 * derived from anything — they are the numbers, chosen by hand, that make a move
 * read as authored. Changing one changes the feel of every technique that uses it.
 */

import { mk, type ToolCall } from '@motion/design-system';
import type { EmitContext } from './schema';

// ── The curve vocabulary ──────────────────────────────────────────────

/**
 * Named beziers, all four floats explicit.
 *
 * A technique NEVER passes an easing preset name like `'easeOut'`. The preset
 * enum exists for humans in the graph editor; a library that used it would give
 * every technique the same two curves, and the whole point of a library is that
 * `luxury_film` and `broadcast_sports` do not move the same way.
 */
export const CURVES = {
  /** Leaves fast, arrives slow. The workhorse for anything settling. */
  settle: [0.16, 1, 0.3, 1] as [number, number, number, number],
  /** Overshoots the target and comes back. Note y2 > 1 — that is the overshoot. */
  overshoot: [0.34, 1.42, 0.64, 1] as [number, number, number, number],
  /** Big overshoot. Expressive; wrong for product UI. */
  elastic: [0.22, 1.8, 0.36, 1] as [number, number, number, number],
  /** Pulls back before it goes. y1 < 0 is the anticipation. */
  anticipate: [0.5, -0.36, 0.68, 1] as [number, number, number, number],
  /** Starts instantly, decelerates hard. Editorial hard-cut feel. */
  snap: [0, 0.86, 0.14, 1] as [number, number, number, number],
  /** Slow both ends. For long ambient drifts. */
  glide: [0.42, 0, 0.58, 1] as [number, number, number, number],
  /** Accelerates out — for exits, which should feel like leaving. */
  exit: [0.7, 0, 0.84, 0] as [number, number, number, number],
  /** Nearly linear but not quite. For camera moves, where linear reads as robotic. */
  drift: [0.25, 0.1, 0.4, 1] as [number, number, number, number],
} as const;

export type CurveName = keyof typeof CURVES;

// ── The lens vocabulary ───────────────────────────────────────────────

/**
 * Focal lengths, as a multiple of the frame's larger dimension.
 *
 * In this projection model `focalLength` is the distance from the camera to the
 * projection plane in px, so a value near the frame width is a "normal" lens and
 * the ratio to the frame is what actually reads as focal length. Expressing them
 * as multiples means the same name gives the same LOOK at any comp size.
 *
 * Every camera technique used to skip this entirely and take the engine default,
 * which meant a slow contemplative push and a crash zoom were shot on the same
 * lens. Focal length is the first decision a camera operator makes and it changes
 * a shot more than the move does: a long lens compresses depth so a push reads as
 * the subject growing, a wide lens exaggerates it so the same push reads as
 * rushing INTO the scene.
 */
export const LENSES = {
  /** Very wide. Strong perspective, edges stretch. Aggressive, immersive. */
  wide: 0.5,
  /** Wide-normal. Slight exaggeration; the documentary default. */
  normal: 0.85,
  /** Portrait-length. Gentle compression, flattering, calm. */
  portrait: 1.5,
  /** Long. Depth collapses; planes stack. Cinematic and observational. */
  long: 2.6,
} as const;

export type LensName = keyof typeof LENSES;

/**
 * Create the composition's camera, on a chosen lens.
 *
 * One helper rather than five copies of `create_layer` so that every camera
 * technique makes a lens decision — and so that adding a sixth cannot forget to.
 * `focalLength` is a real keyframable channel the renderer samples, so a
 * technique that wants a dolly-zoom keyframes it afterwards.
 */
export function emitCamera(
  ctx: EmitContext,
  id: string,
  name: string,
  lens: LensName,
): { calls: ToolCall[]; focalLength: number } {
  const focalLength = Math.round(Math.max(ctx.width, ctx.height) * LENSES[lens]);
  return {
    calls: [
      mk('create_layer', { id, kind: 'camera', name }),
      mk('update_layer', { nodeId: id, focalLength }),
    ],
    focalLength,
  };
}

// ── Keyframe construction ─────────────────────────────────────────────

export interface Key {
  t: number;
  value: number;
  easing?: string;
  bezier?: [number, number, number, number];
}

/** Milliseconds → composition seconds, the unit every tool takes. */
export const sec = (ms: number): number => Number((ms / 1000).toFixed(4));

/** One `set_keyframes` call for one property. */
export function track(nodeId: string, prop: string, keys: readonly Key[]): ToolCall {
  return mk('set_keyframes', {
    keyframes: keys.map((k) => ({
      nodeId,
      prop,
      t: sec(k.t),
      value: k.value,
      easing: k.bezier ? 'bezier' : (k.easing ?? 'linear'),
      ...(k.bezier ? { bezier: k.bezier } : {}),
    })),
  });
}

/**
 * The hero move: **anticipation → overshoot → settle**, three keyframes minimum.
 *
 * This is craft marker #1 and #2 in one helper, and it is the single most
 * important function in the package. A two-keyframe move from A to B is what a
 * model produces when asked to animate something, and it is why that output
 * reads as a transition rather than as motion: real motion has a *before* and an
 * *after* the destination.
 *
 * `anticipation` is a fraction of the travel, applied backwards, over 2–4 frames.
 * `overshoot` is a fraction of the travel applied past the target. Both scale
 * with the pack's `overshootBias`, so `luxury_film` gets a whisper and
 * `broadcast_sports` gets a punch from the same call.
 */
export function heroMove(
  ctx: EmitContext,
  nodeId: string,
  prop: string,
  o: {
    from: number;
    to: number;
    startMs: number;
    durationMs: number;
    /** Counter-move before the main move, as a fraction of travel. 0 to skip. */
    anticipation?: number;
    /** Excursion past the target, as a fraction of travel. */
    overshoot?: number;
  },
): ToolCall {
  const bias = ctx.pack.pack.motionSignature.overshootBias;
  const travel = o.to - o.from;
  const anticipation = (o.anticipation ?? 0.08) * bias;
  const overshoot = (o.overshoot ?? 0.35) * bias;

  const keys: Key[] = [];
  const antFrames = 2 + Math.round(bias * 2); // 2–4 frames
  const antMs = antFrames * ctx.frameMs;

  if (anticipation > 0 && travel !== 0) {
    // Pull the OPPOSITE way first. `anticipate` has a negative y1, so the layer
    // eases into the counter-move rather than jumping into it.
    keys.push({ t: o.startMs, value: o.from, bezier: CURVES.anticipate });
    keys.push({ t: o.startMs + antMs, value: o.from - travel * anticipation, bezier: CURVES.snap });
  } else {
    keys.push({ t: o.startMs, value: o.from, bezier: CURVES.settle });
  }

  const mainStart = o.startMs + (anticipation > 0 ? antMs : 0);
  const mainDur = o.durationMs - (mainStart - o.startMs);

  if (overshoot > 0 && travel !== 0) {
    // Peak at ~62% of the remaining time, then settle over the rest. Peaking at
    // the halfway point makes the return read as slow as the approach, which is
    // the "rubber band" look; a late peak reads as a landing.
    keys.push({ t: mainStart + mainDur * 0.62, value: o.to + travel * overshoot, bezier: CURVES.settle });
    keys.push({ t: o.startMs + o.durationMs, value: o.to, bezier: CURVES.settle });
  } else {
    keys.push({ t: o.startMs + o.durationMs, value: o.to, bezier: CURVES.settle });
  }

  return track(nodeId, prop, keys);
}

/**
 * Cross-property offset — craft marker #3.
 *
 * Properties on one layer must not all start on the same frame. Which leads and
 * which lags is not arbitrary: **opacity leads** (a thing becomes visible
 * slightly before it moves, or the move's first frames are invisible and wasted),
 * **scale is the reference**, and **position lags** (the object commits to its
 * size before it commits to its place). One or two frames is enough — the effect
 * is felt, not seen.
 */
export const PROPERTY_LEAD_FRAMES: Record<string, number> = {
  opacity: -1,
  scale: 0,
  scaleX: 0,
  scaleY: 0,
  rotation: 1,
  x: 2,
  y: 2,
  z: 2,
  blur: -1,
};

/** Start time for `prop`, offset from the layer's nominal start. */
export function offsetFor(ctx: EmitContext, prop: string, startMs: number): number {
  const lead = PROPERTY_LEAD_FRAMES[prop] ?? 0;
  return startMs + lead * ctx.frameMs;
}

/**
 * Non-uniform stagger — craft marker #6.
 *
 * `curve < 1` decelerates (elements bunch early, then spread), `> 1` accelerates.
 * Never exactly 1: a fixed interval between siblings is the most recognisable
 * generated-timing signature there is, and the timing linter errors on it.
 *
 * The pack supplies the curve, so the same technique staggers differently in
 * `luxury_film` (0.6, a long slow spread) and `broadcast_sports` (1.35, a rush
 * that lands together).
 */
export function staggerAt(ctx: EmitContext, index: number, count: number, spanMs: number): number {
  if (count <= 1) return 0;
  // Amplify the pack's deviation from 1.0 before applying it.
  //
  // A power curve converges toward LINEAR in its tail: with `curve = 0.72` and
  // fourteen elements, the last three gaps differ by about 2% — visually a
  // metronome, and the timing linter reported it as one. Pushing the exponent
  // further from 1 keeps the gaps genuinely varying across the whole run, which
  // is the property the curve exists to provide.
  const curve = 1 + (ctx.pack.pack.pacing.staggerCurve - 1) * 1.6;

  // Large groups stagger in WAVES, not one continuous ramp.
  //
  // A power curve converges toward linear as the element count grows: measured
  // over 19 elements, the last four gaps came out 55 / 54 / 52.6 / 51.3ms —
  // differing by under 3%, which is a metronome by any honest measure, and the
  // timing linter said so. Widening the span does not help; the convergence is a
  // property of the curve, not of its scale.
  //
  // It is also what a designer actually does. Nobody staggers nineteen things on
  // one ramp — they group them, and the group boundaries become part of the
  // rhythm. Within a wave the curve applies; between waves there is a larger
  // beat. The gaps then alternate between two scales and never converge.
  const WAVE_SIZE = 6;
  const wave = Math.floor(index / WAVE_SIZE);
  const withinWave = index % WAVE_SIZE;
  const waveCount = Math.min(WAVE_SIZE, count - wave * WAVE_SIZE);

  // No two elements may enter within ~1.5 frames of each other — inside one
  // frame they are simultaneous however carefully the curve was chosen.
  //
  // The floor is applied by WIDENING THE SPAN until the curve's own smallest gap
  // clears it, never by clamping individual positions. Clamping was the obvious
  // approach and it is wrong: `max(curved, index * minGap)` puts every clamped
  // element exactly `minGap` from the last — a perfectly uniform run, the exact
  // defect the curve exists to avoid, reintroduced by the guard against a
  // different one.
  const minGap = ctx.frameMs * 1.5;
  const smallestUnitGap = waveCount <= 1
    ? 1
    : curve < 1
      ? 1 - Math.pow((waveCount - 1) / waveCount, curve)
      : Math.pow(1 / waveCount, curve);
  const waveSpan = Math.max(spanMs / Math.max(1, Math.ceil(count / WAVE_SIZE)), minGap / Math.max(smallestUnitGap, 1e-6));

  // The beat between waves is deliberately larger than any within-wave gap, so
  // the boundary reads as a breath rather than as another element.
  const betweenWaves = waveSpan * 1.45;
  const raw = wave * (waveSpan + betweenWaves) + Math.pow(withinWave / waveCount, curve) * waveSpan;

  // The whole stagger must FIT. Widening the span to clear the minimum gap can
  // push the last elements of a large group past the end of the slot, where they
  // are simply never seen — and because their keyframes then clamp to the
  // composition end, they all pile onto one time and read as simultaneous. That
  // is what the linter reported: six elements entering at exactly 2500ms.
  //
  // No element may enter after 60% of the slot; past that it has no room to
  // complete its own move. When the ideal spacing does not fit, everything
  // compresses proportionally — which preserves the curve's SHAPE, so the result
  // is a faster version of the same rhythm rather than a different one.
  const positionOf = (idx: number): number => {
    const w = Math.floor(idx / WAVE_SIZE);
    const within = idx % WAVE_SIZE;
    const wc = Math.min(WAVE_SIZE, count - w * WAVE_SIZE);
    return w * (waveSpan + betweenWaves) + Math.pow(within / Math.max(1, wc), curve) * waveSpan;
  };

  const budget = ctx.durationMs * 0.6;
  const maxRaw = positionOf(count - 1);
  if (maxRaw <= budget || maxRaw <= 0) return raw;

  // Compressing a curved stagger proportionally preserves its SHAPE but shrinks
  // its smallest gap — and the smallest gap is exactly what must not shrink.
  // Squeezing nineteen elements into a 1.8s slot that way put several of them
  // inside one frame of each other: `SIMULTANEOUS_ENTRY`, traded for the
  // `UNIFORM_STAGGER` the curve was avoiding.
  //
  // So under compression the curve STRAIGHTENS toward even spacing, which is the
  // arrangement that maximises the minimum gap — and is what a designer does when
  // asked to fit more into less. It is blended, never reached: `t` caps at 0.85
  // so the gaps still vary by well over the linter's 3% threshold and the result
  // never becomes the metronome.
  const scale = budget / maxRaw;
  const evenGap = budget / Math.max(1, count - 1);
  const minGapNeeded = Math.min(minGap, evenGap * 0.98);

  let blend = 0;
  for (let step = 1; step <= 17; step++) {
    const candidate = Math.min(0.85, step / 17);
    let smallest = Infinity;
    for (let i = 1; i < count; i++) {
      const a = positionOf(i - 1) * scale;
      const b = positionOf(i) * scale;
      const ea = (i - 1) * evenGap;
      const eb = i * evenGap;
      smallest = Math.min(smallest, (b + (eb - b) * candidate) - (a + (ea - a) * candidate));
    }
    blend = candidate;
    if (smallest >= minGapNeeded) break;
  }

  const compressed = raw * scale;
  const even = index * evenGap;
  const straightened = compressed + (even - compressed) * blend;

  // Swing.
  //
  // Straightening fixes the minimum gap but flattens the tail: measured on a
  // nine-element exit, the last four gaps came out 54.9 / 53.3 / 52.5 / 52.0 —
  // within 3% of each other, a metronome by any measure, and the linter said so.
  //
  // Swing is the musician's answer and it is not a workaround: alternate gaps are
  // pushed long and short about a constant total, so no two ADJACENT gaps can be
  // equal however far the underlying curve has been straightened. It is the same
  // device that separates a played rhythm from a programmed one, and it costs
  // nothing.
  const SWING = 0.14;
  const swingOffset = (index % 2 === 1 ? 1 : -1) * evenGap * SWING * 0.5;
  return Math.max(0, straightened + (index === 0 ? 0 : swingOffset));
}

/**
 * Follow-through — craft marker #4.
 *
 * A subordinate element keeps moving after the primary has settled, then comes to
 * rest on its own. This is what makes a group read as connected mass rather than
 * as N independent animations that happen to overlap.
 */
export function followThrough(
  _ctx: EmitContext,
  nodeId: string,
  prop: string,
  o: { restValue: number; amount: number; settleMs: number; durationMs: number },
): ToolCall {
  return track(nodeId, prop, [
    { t: o.settleMs, value: o.restValue + o.amount, bezier: CURVES.settle },
    // Cross back past rest — a follow-through that only decays never reads as
    // momentum, it reads as a slow fade.
    { t: o.settleMs + o.durationMs * 0.55, value: o.restValue - o.amount * 0.28, bezier: CURVES.settle },
    { t: o.settleMs + o.durationMs, value: o.restValue, bezier: CURVES.settle },
  ]);
}

/**
 * Motion blur — craft marker #7 — but only where velocity warrants it.
 *
 * Blindly enabling it on every layer is as wrong as never enabling it: motion
 * blur on a slow drift costs render time and changes nothing, and on a UI element
 * it actively reads as fake. So this takes the actual travel and duration and
 * decides.
 */
export const BLUR_VELOCITY_THRESHOLD_PX_PER_SEC = 900;

export function blurIfFast(
  ctx: EmitContext,
  nodeId: string,
  travelPx: number,
  durationMs: number,
): ToolCall[] {
  if (durationMs <= 0) return [];
  const velocity = Math.abs(travelPx) / (durationMs / 1000);
  const bias = ctx.pack.pack.motionSignature.blurBias;
  if (bias <= 0) return []; // a product pack: real UI does not blur
  if (velocity < BLUR_VELOCITY_THRESHOLD_PX_PER_SEC * (2 - bias)) return [];
  return [mk('set_motion_blur', { nodeId, enabled: true })];
}

/** Composition-level shutter. Emit once per piece, not per layer. */
export function compositionShutter(ctx: EmitContext): ToolCall[] {
  const bias = ctx.pack.pack.motionSignature.blurBias;
  if (bias <= 0) return [];
  return [
    mk('set_motion_blur', {
      enabled: true,
      shutterAngle: Math.round(140 + bias * 80), // 140–220; 180 is film
      shutterPhase: -90,
      // 16+ on fast packs or fast moves band. 8 is the engine default and it
      // shows on anything that crosses the frame.
      samples: bias > 0.6 ? 16 : 12,
    }),
  ];
}

/**
 * A hold — craft marker #8.
 *
 * Two keyframes at the same value with `hold` easing. The value is pinned across
 * the interval instead of drifting, which is what makes a beat land: motion that
 * never stops has no rhythm, and "everything is always moving slightly" is a
 * distinct generated-motion tell of its own.
 */
export function hold(nodeId: string, prop: string, value: number, fromMs: number, toMs: number): ToolCall {
  return track(nodeId, prop, [
    { t: fromMs, value, easing: 'hold' },
    { t: toMs, value, easing: 'hold' },
  ]);
}

/**
 * Sub-frame timing — the other half of marker #8.
 *
 * Snapping every keyframe to a frame boundary quantises the motion, and on fast
 * moves that quantisation is visible as stepping. Offsetting a key by a fraction
 * of a frame changes the interpolated value AT the sampled frame, which is what
 * removes the step.
 */
export function subFrame(ms: number, frameMs: number, fraction = 0.5): number {
  return ms + frameMs * fraction;
}

/** Fade in with a real curve, offset by the opacity lead. */
export function fadeIn(ctx: EmitContext, nodeId: string, startMs: number, durationMs: number): ToolCall {
  return track(nodeId, 'opacity', [
    { t: offsetFor(ctx, 'opacity', startMs), value: 0, bezier: CURVES.settle },
    // Opacity finishes EARLY — at ~55% of the move. A fade that runs the whole
    // duration means the element is still translucent while it settles, which
    // reads as weak. Arriving opaque and still moving reads as solid.
    { t: offsetFor(ctx, 'opacity', startMs) + durationMs * 0.55, value: 100, bezier: CURVES.settle },
  ]);
}

/** Fade out, accelerating — exits should feel like leaving. */
export function fadeOut(_ctx: EmitContext, nodeId: string, startMs: number, durationMs: number): ToolCall {
  return track(nodeId, 'opacity', [
    { t: startMs, value: 100, bezier: CURVES.exit },
    { t: startMs + durationMs, value: 0, bezier: CURVES.exit },
  ]);
}

/** Travel distance that scales with the frame rather than a fixed px value. */
export function travel(ctx: EmitContext, fraction: number): number {
  return Math.round(Math.min(ctx.width, ctx.height) * fraction);
}

/**
 * The layer ids a technique may animate — its DECLARED roles only.
 *
 * Every emitter must go through this rather than flattening `ctx.targets`.
 * `roles` is a contract the registry already enforces at cast time (a technique
 * is only offered for a slot whose layout produced a role it declares), and an
 * emitter that then animates everything breaks it from the other side.
 *
 * It is also a correctness issue, not just tidiness. Grabbing every target meant
 * `entrance.slide_in_edge` — which declares six roles — tried to stagger
 * nineteen layers inside its own 1.8s maximum. There is no arrangement of
 * nineteen entries in 1.8s that clears both the minimum-gap floor and the
 * uniform-stagger rule, so the technique was forced to choose which defect to
 * ship. Honouring the declared roles removes the dilemma rather than resolving it.
 */
export function rolesTargets(ctx: EmitContext, roles: readonly string[]): string[] {
  const out: string[] = [];
  for (const role of roles) {
    for (const id of ctx.targets[role as keyof EmitContext['targets']] ?? []) out.push(id);
  }
  return out;
}
