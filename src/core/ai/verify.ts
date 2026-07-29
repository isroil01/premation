/**
 * Cheap deterministic checks that run before the render-and-critique pass.
 *
 * The point is division of labour: a vision pass costs a render plus a model
 * turn and is good at taste, but it should not be spending that budget noticing
 * that a layer sits off-canvas or that a keyframe lands past the end of the
 * composition. Those are arithmetic.
 *
 * ## Read the false positives before changing anything here
 *
 * A first attempt at this verifier flagged five issues
 * against known-good output. **All five were wrong**, and each one is now a
 * structural constraint rather than a comment:
 *
 *  1. `offscreen: Light Sweep` ×2 — the sweep *starts* at x = −480 by design
 *     and animates across the frame. A static-bounds check on an animated
 *     position is meaningless, so `offscreen` samples the position over time
 *     and only reports a layer that is off-canvas at EVERY sample.
 *  2. `simultaneous: 5 layers at 0.000s` ×2 — ambient orbs carry a *single*
 *     opacity keyframe. That is a constant, not an entrance, so `entranceOf`
 *     ignores any track with fewer than two keyframes.
 *  3. `opacity-only: title` ×1 — the run picked the `blur_resolve` archetype,
 *     which pairs opacity with an *effect* parameter rather than a transform.
 *     So `PAIRED_WITH_OPACITY` counts effect params as motion.
 *
 * A verifier that reports correct work to the model is worse than no verifier:
 * it spends a turn and then makes the output worse. When adding a check, write
 * the false positive you are guarding against into the test file.
 */

import type { ToolContext } from '@motion/ai-tools';

export type VerdictKind =
  | 'past-end'
  | 'offscreen'
  | 'invisible'
  | 'opacity-only'
  | 'simultaneous';

export interface Finding {
  kind: VerdictKind;
  /** Layers involved. Empty for comp-wide findings. */
  nodeIds: string[];
  /** Addressed to the model: what is wrong and what to do about it. */
  message: string;
}

/**
 * Baseline uniform samples across the composition.
 *
 * Uniform sampling alone is NOT enough, and getting this wrong reproduced
 * false positive #1 in a new disguise: a real `add_light_sweep` crosses the
 * frame in 0.9s, so on a 15s composition a 12-point grid (1.36s apart) steps
 * straight over the only interval where the layer is visible and reports it
 * offscreen. `sampleTimes` therefore also samples every keyframe and every
 * midpoint between keyframes — for piecewise motion the extremes are at the
 * keyframes by construction, so that makes the check exact rather than lucky.
 */
const UNIFORM_SAMPLES = 12;

/**
 * A track spanning at least this fraction of the composition is ambient drift
 * (parallax, a slow float), not an entrance.
 *
 * Same lesson as false positive #2, one level up: "has ≥2 keyframes" is not the
 * same as "enters". Real `add_ambient_orbs` output gives every orb a 10-second
 * y-drift starting at t=0, and `add_background` a 10-second scale drift — so a
 * naive entrance test reports "6 layers all enter at 0.00s" on a composition
 * where nothing enters at all. Ambient motion starting together is the point of
 * ambient motion.
 */
const AMBIENT_SPAN_FRACTION = 0.6;

/** An entrance is a short burst; anything longer is a move, not an arrival. */
const ENTRANCE_MAX_SEC = 2.5;

/**
 * Margin, in px, by which a layer's box must clear the canvas before we call it
 * offscreen. Generous on purpose — a sliver of a layer poking in is usually
 * deliberate (a bleed, a partial reveal), and a false positive costs more than
 * a miss.
 */
const OFFSCREEN_SLACK = 8;

/** Entrances landing within this window of each other read as simultaneous. */
const SIMULTANEITY_WINDOW_SEC = 0.02;

/** Below this many co-entering layers, simultaneity is intentional, not a bug. */
const SIMULTANEITY_MIN_LAYERS = 4;

/**
 * Channels that count as real motion alongside opacity.
 *
 * `effect.*` is here because of false positive #3: `blur_resolve` pairs a fade
 * with an animated blur, which looks like a transform-less fade to any check
 * that only knows about x/y/scale/rotation — but reads as a proper entrance.
 */
function isPairedWithOpacity(prop: string): boolean {
  if (prop.startsWith('effect.')) return true;
  if (prop.startsWith('ta.')) return true; // text animators
  return ['x', 'y', 'z', 'scale', 'scaleX', 'scaleY', 'rotation', 'rotationX', 'rotationY'].includes(prop);
}

/**
 * The layer's entrance: the earliest time at which any of its tracks actually
 * *moves*, in composition seconds.
 *
 * Returns null for a layer with no animation at all — including one whose
 * tracks each hold a single keyframe. That single-keyframe case is false
 * positive #2: one keyframe sets a constant value, it does not animate.
 */
function entranceOf(ctx: ToolContext, nodeId: string, durationSeconds: number): number | null {
  let earliest: number | null = null;
  for (const track of ctx.anim.tracks(nodeId)) {
    if (track.keyframes.length < 2) continue;
    const first = track.keyframes[0]!.t;
    const last = track.keyframes[track.keyframes.length - 1]!.t;
    const span = last - first;
    // Ambient drift, not an arrival — see AMBIENT_SPAN_FRACTION.
    if (span > ENTRANCE_MAX_SEC || span >= durationSeconds * AMBIENT_SPAN_FRACTION) continue;
    if (earliest === null || first < earliest) earliest = first;
  }
  return earliest === null ? null : ctx.time.toCompTime(nodeId, earliest);
}

/**
 * Times at which to evaluate a layer, in composition seconds.
 *
 * A uniform grid plus every keyframe and every inter-keyframe midpoint. The
 * keyframes are what make this exact: a short event cannot fall between two
 * samples when the samples include its own endpoints.
 */
function sampleTimes(ctx: ToolContext, nodeId: string, durationSeconds: number): number[] {
  const times = new Set<number>();
  for (let i = 0; i < UNIFORM_SAMPLES; i++) {
    times.add((durationSeconds * i) / Math.max(1, UNIFORM_SAMPLES - 1));
  }
  for (const track of ctx.anim.tracks(nodeId)) {
    const kfs = track.keyframes;
    for (let i = 0; i < kfs.length; i++) {
      const kf = kfs[i]!;
      times.add(ctx.time.toCompTime(nodeId, kf.t));
      if (i > 0) times.add(ctx.time.toCompTime(nodeId, (kfs[i - 1]!.t + kf.t) / 2));
    }
  }
  return [...times].filter((t) => t >= 0 && t <= durationSeconds).sort((a, b) => a - b);
}

/**
 * Does this layer cover (essentially) the whole canvas?
 *
 * Used to exempt backdrops from the paired-motion rule — a full-bleed layer
 * that only changes opacity is a crossfade, not a flat entrance.
 */
function fillsFrame(
  node: { width?: number; height?: number },
  comp: { width: number; height: number },
): boolean {
  return (node.width ?? 0) >= comp.width * 0.95 && (node.height ?? 0) >= comp.height * 0.95;
}

/** A layer's box at composition time `t`, falling back to its base transform. */
function boxAt(
  ctx: ToolContext,
  node: { id: string; x: number; y: number; width?: number; height?: number },
  t: number,
): { x: number; y: number; w: number; h: number } {
  const v = ctx.anim.evaluate(node.id, ctx.time.toLayerTime(node.id, t));
  const scaleX = v['scaleX'] ?? v['scale'] ?? 1;
  const scaleY = v['scaleY'] ?? v['scale'] ?? 1;
  return {
    x: v['x'] ?? node.x,
    y: v['y'] ?? node.y,
    w: (node.width ?? 0) * scaleX,
    h: (node.height ?? 0) * scaleY,
  };
}

/**
 * Run every check against the current scene.
 *
 * Pure over the ToolContext — no mutation, no rendering, no network. Safe to
 * call as often as you like.
 */
export function verifyScene(ctx: ToolContext): Finding[] {
  const findings: Finding[] = [];
  const comp = ctx.comp.get();
  const layers = ctx.scene.all().filter((n) => n.visible !== false && n.kind !== 'camera');

  // ── past-end ──────────────────────────────────────────────────────────────
  // Keyframes after the composition ends are simply never seen. Unambiguous,
  // and the cheapest thing here to get right.
  for (const node of layers) {
    let latest = -Infinity;
    for (const track of ctx.anim.tracks(node.id)) {
      for (const kf of track.keyframes) {
        const t = ctx.time.toCompTime(node.id, kf.t);
        if (t > latest) latest = t;
      }
    }
    if (latest > comp.durationSeconds + 1e-6) {
      findings.push({
        kind: 'past-end',
        nodeIds: [node.id],
        message:
          `'${node.name}' has a keyframe at ${latest.toFixed(2)}s but the composition ends at ` +
          `${comp.durationSeconds.toFixed(2)}s — that motion never plays. Move the keyframes earlier ` +
          `or extend the composition.`,
      });
    }
  }

  // ── offscreen ─────────────────────────────────────────────────────────────
  // False positive #1 lives here. A layer that STARTS offscreen and animates in
  // is correct and common (light sweeps, slide-ins), so a single static bounds
  // test is not a check — it is a bug generator. Only a layer that is outside
  // the canvas at every sampled time is actually invisible.
  for (const node of layers) {
    if (!node.width || !node.height) continue; // nulls, cameras, sizeless layers
    let everOnscreen = false;
    for (const t of sampleTimes(ctx, node.id, comp.durationSeconds)) {
      if (everOnscreen) break;
      const b = boxAt(ctx, node, t);
      const onscreen =
        b.x + b.w / 2 > OFFSCREEN_SLACK &&
        b.x - b.w / 2 < comp.width - OFFSCREEN_SLACK &&
        b.y + b.h / 2 > OFFSCREEN_SLACK &&
        b.y - b.h / 2 < comp.height - OFFSCREEN_SLACK;
      if (onscreen) everOnscreen = true;
    }
    if (!everOnscreen) {
      findings.push({
        kind: 'offscreen',
        nodeIds: [node.id],
        message:
          `'${node.name}' is outside the ${comp.width}×${comp.height} frame for the entire composition — ` +
          `it is never visible. Move it into frame, or delete it.`,
      });
    }
  }

  // ── invisible ─────────────────────────────────────────────────────────────
  // Same principle as offscreen: opacity is often keyframed from 0, so only a
  // layer that is transparent at EVERY sample counts.
  for (const node of layers) {
    let everVisible = false;
    for (const t of sampleTimes(ctx, node.id, comp.durationSeconds)) {
      if (everVisible) break;
      const v = ctx.anim.evaluate(node.id, ctx.time.toLayerTime(node.id, t));
      if ((v['opacity'] ?? node.opacity) > 1) everVisible = true;
    }
    if (!everVisible) {
      findings.push({
        kind: 'invisible',
        nodeIds: [node.id],
        message:
          `'${node.name}' has opacity 0 for the whole composition — it never appears. ` +
          `Give it a visible opacity keyframe, or delete it.`,
      });
    }
  }

  // ── opacity-only ──────────────────────────────────────────────────────────
  // False positive #3 lives here. A fade with no accompanying motion reads as
  // flat — but "accompanying motion" includes an animated effect parameter, not
  // just a transform.
  for (const node of layers) {
    // A layer that fills the frame is a backdrop, and cross-fading backdrops is
    // how scene changes are supposed to work — `add_scene` builds exactly this.
    // Demanding movement from one would nag on every multi-scene piece the
    // library produces.
    if (fillsFrame(node, comp)) continue;
    const animated = ctx.anim.tracks(node.id).filter((t) => t.keyframes.length >= 2);
    if (!animated.some((t) => t.prop === 'opacity')) continue;
    if (animated.some((t) => isPairedWithOpacity(t.prop))) continue;
    findings.push({
      kind: 'opacity-only',
      nodeIds: [node.id],
      message:
        `'${node.name}' animates opacity and nothing else. A bare fade reads as flat — pair it with ` +
        `movement (a small y offset or scale) or an effect, or apply an entrance archetype.`,
    });
  }

  // ── simultaneous ──────────────────────────────────────────────────────────
  // False positive #2 lives here, and it is handled in `entranceOf`: a layer
  // whose tracks each hold one keyframe has no entrance and is not counted.
  const entrances = new Map<string, number>();
  for (const node of layers) {
    const t = entranceOf(ctx, node.id, comp.durationSeconds);
    if (t !== null) entrances.set(node.id, t);
  }
  const byTime = [...entrances.entries()].sort((a, b) => a[1] - b[1]);
  let group: Array<[string, number]> = [];
  const flush = (): void => {
    if (group.length >= SIMULTANEITY_MIN_LAYERS) {
      const names = group.map(([id]) => ctx.scene.get(id)?.name ?? id);
      findings.push({
        kind: 'simultaneous',
        nodeIds: group.map(([id]) => id),
        message:
          `${group.length} layers all enter at ${group[0]![1].toFixed(2)}s (${names.join(', ')}). ` +
          `Everything arriving at once reads as a single block — stagger them by 0.06–0.12s so the eye ` +
          `has an order to follow.`,
      });
    }
    group = [];
  };
  for (const entry of byTime) {
    if (group.length && entry[1] - group[0]![1] > SIMULTANEITY_WINDOW_SEC) flush();
    group.push(entry);
  }
  flush();

  return findings;
}

/**
 * Findings as a repair instruction for the model, or null when the scene is
 * clean.
 *
 * Phrased as observations to act on rather than orders: the model can see the
 * frames, this function cannot, and on the rare occasion a finding is wrong the
 * model should be able to overrule it.
 */
export function formatFindings(findings: readonly Finding[]): string | null {
  if (findings.length === 0) return null;
  const lines = findings.map((f) => `- ${f.message}`);
  return (
    `Automated checks found ${findings.length} issue${findings.length === 1 ? '' : 's'} ` +
    `with the scene:\n${lines.join('\n')}\n\n` +
    `Fix the ones that are real. If a check is wrong about your intent — a layer that starts ` +
    `offscreen and sweeps in, for instance — say so and move on.`
  );
}
