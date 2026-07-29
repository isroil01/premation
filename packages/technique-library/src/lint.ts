/**
 * The timing linter.
 *
 * ## Why this replaces most of the critique loop
 *
 * Three still frames at 35% / 70% / last-frame cannot show timing, spacing,
 * easing, overshoot, flicker or pacing. The most expensive part of the old loop —
 * six critics × three stills × five iterations — was structurally blind to the
 * only dimension that mattered. Every rule below is a *mechanical* property of
 * the keyframes, so it costs nothing and is never wrong about what it measured.
 *
 * ## Errors block; warnings inform
 *
 * An error is a defect that is objectively present: linear easing on a visible
 * move, a two-keyframe hero move, three siblings on an identical stagger
 * interval. Those go to a deterministic repair pass — re-emit with corrected
 * params — and never to an LLM, because "add an overshoot" is not a judgement.
 *
 * ## It runs on `ToolCall[]`
 *
 * Before execution, not after. A defect caught here costs nothing to fix; the
 * same defect caught after the document has been mutated costs an undo entry and
 * a re-run.
 */

import type { ToolCall } from '@motion/design-system';

export type TimingRule =
  | 'LINEAR_EASING'
  | 'NO_OVERSHOOT'
  | 'UNIFORM_STAGGER'
  | 'SIMULTANEOUS_ENTRY'
  | 'NO_PROPERTY_OFFSET'
  | 'MISSING_MOTION_BLUR'
  | 'DEAD_AIR'
  | 'POPPING'
  | 'SUB_MINIMUM_DURATION'
  | 'ANTIPATTERN_VIOLATION'
  | 'NO_CONTINUITY';

export type Severity = 'error' | 'warn';

export interface TimingFinding {
  rule: TimingRule;
  severity: Severity;
  nodeIds: string[];
  message: string;
}

const ERROR_RULES: ReadonlySet<TimingRule> = new Set([
  'LINEAR_EASING',
  'NO_OVERSHOOT',
  'UNIFORM_STAGGER',
  'SIMULTANEOUS_ENTRY',
  'POPPING',
  'SUB_MINIMUM_DURATION',
  'ANTIPATTERN_VIOLATION',
  'NO_CONTINUITY',
]);

interface Keyframe {
  t: number;
  value: number;
  easing: string;
  bezier?: number[];
}

interface Track {
  nodeId: string;
  prop: string;
  keys: Keyframe[];
}

/** Roles whose motion is "hero" — held to the overshoot rule. */
const HERO_PROPS = new Set(['scale', 'scaleX', 'scaleY', 'x', 'y', 'z']);

/** Props whose motion is ambient by nature and exempt from the overshoot rule. */
const AMBIENT_PROPS = new Set(['rotation', 'opacity', 'timeRemap']);

/**
 * Two consecutive stagger gaps closer than this FRACTION of each other read as
 * identical.
 *
 * Relative, not absolute. A 2ms absolute threshold is meaningless across scales:
 * on a 400ms gap it is noise, and on a 25ms gap it is 8% — a real difference.
 * Using it flagged a legitimately curved 14-element stagger as uniform, because
 * a power curve converges toward linear in its tail and the last few gaps landed
 * within 2ms of each other while still differing by a visible proportion.
 */
const STAGGER_RELATIVE_EPSILON = 0.03;
/** Below this many siblings, a shared interval is a coincidence. */
const STAGGER_MIN_SIBLINGS = 3;
/** Entries within this window read as simultaneous. */
const SIMULTANEITY_WINDOW_MS = 20;
/** Below this many co-entering layers, simultaneity is intentional. */
const SIMULTANEITY_MIN_LAYERS = 3;
/** Longer than this with nothing animating is dead air. */
const DEAD_AIR_MS = 700;
/**
 * A value jump this large across ONE frame is a pop.
 *
 * Expressed as a fraction of the track's own range, not in absolute units, so it
 * works for opacity (0–100), scale (0–2) and position (0–1920) without three
 * different thresholds.
 */
const POP_FRACTION = 0.6;

/** Rebuild the animation tracks a batch of calls would produce. */
export function tracksFromCalls(calls: readonly ToolCall[]): Track[] {
  const byKey = new Map<string, Track>();
  for (const c of calls) {
    if (c.name !== 'set_keyframes') continue;
    const kfs = c.args.keyframes;
    if (!Array.isArray(kfs)) continue;
    for (const raw of kfs) {
      const k = raw as Record<string, unknown>;
      const nodeId = String(k.nodeId ?? '');
      const prop = String(k.prop ?? '');
      const key = `${nodeId}::${prop}`;
      let track = byKey.get(key);
      if (!track) {
        track = { nodeId, prop, keys: [] };
        byKey.set(key, track);
      }
      track.keys.push({
        t: Number(k.t ?? 0) * 1000,
        value: Number(k.value ?? 0),
        easing: String(k.easing ?? 'linear'),
        ...(Array.isArray(k.bezier) ? { bezier: (k.bezier as number[]).map(Number) } : {}),
      });
    }
  }
  for (const t of byKey.values()) t.keys.sort((a, b) => a.t - b.t);
  return [...byKey.values()];
}

/** A track's first moving keyframe time, or null if it never moves. */
function entryOf(track: Track): number | null {
  if (track.keys.length < 2) return null;
  for (let i = 1; i < track.keys.length; i++) {
    if (track.keys[i]!.value !== track.keys[0]!.value) return track.keys[0]!.t;
  }
  return null;
}

/**
 * Does this track overshoot?
 *
 * Two ways to qualify, and both are real overshoot:
 *  • **value overshoot** — some intermediate keyframe is past the final value;
 *  • **curve overshoot** — a bezier with `y > 1` or `y < 0`, which makes the
 *    interpolated value exceed its endpoints even with only two keyframes.
 *
 * Counting only the first would reject a perfectly good two-keyframe move with an
 * overshoot curve, which is a real and common way to author one.
 */
function hasOvershoot(track: Track): boolean {
  const keys = track.keys;
  if (keys.length >= 3) {
    const first = keys[0]!.value;
    const last = keys[keys.length - 1]!.value;
    const dir = Math.sign(last - first);
    if (dir !== 0) {
      for (let i = 1; i < keys.length - 1; i++) {
        if (Math.sign(keys[i]!.value - last) === dir) return true;
      }
    }
  }
  return keys.some((k) => k.bezier && (k.bezier[1]! > 1.001 || k.bezier[3]! > 1.001 || k.bezier[1]! < -0.001));
}

export interface TimingLintScene {
  calls: readonly ToolCall[];
  fps: number;
  durationMs: number;
  /** Technique instances cast, for the antipattern and duration rules. */
  instances?: readonly { id: string; startMs: number; durationMs: number; minDurationMs?: number; neverWith?: readonly string[] }[];
  /** Beat boundaries and how many elements survive each — for NO_CONTINUITY. */
  beatBoundaries?: readonly { atMs: number; survivors: number }[];
  /** Layer ids classed as hero content, held to the overshoot rule. */
  heroNodeIds?: readonly string[];
  /**
   * Layer ids that are product-UI elements.
   *
   * Exempt from `UNIFORM_STAGGER`, and this is a real distinction rather than an
   * escape hatch: a UI list stagger is **supposed** to be nearly even. Its job is
   * to show that rows are distinct, not to give each one a moment, and a
   * conspicuously curved rhythm in an interface draws attention to the animation
   * instead of to the content. The metronome rule is an editorial rule.
   *
   * They are still held to every other rule here, and additionally to the
   * stricter `@motion/product-motion` linter.
   */
  uiNodeIds?: readonly string[];
}

const find = (rule: TimingRule, nodeIds: string[], message: string): TimingFinding => ({
  rule,
  severity: ERROR_RULES.has(rule) ? 'error' : 'warn',
  nodeIds,
  message,
});

export function lintTiming(scene: TimingLintScene): TimingFinding[] {
  const out: TimingFinding[] = [];
  const tracks = tracksFromCalls(scene.calls);
  const frameMs = 1000 / Math.max(1, scene.fps);
  const heroes = new Set(scene.heroNodeIds ?? []);

  // ── LINEAR_EASING ─────────────────────────────────────────────────────────
  // A segment that MOVES on linear easing. A linear segment between two equal
  // values is a hold and is correct — flagging those would fire on every
  // deliberate beat, which is the opposite of what this rule wants.
  const linear: string[] = [];
  for (const t of tracks) {
    for (let i = 0; i < t.keys.length - 1; i++) {
      const a = t.keys[i]!;
      const b = t.keys[i + 1]!;
      if (a.value === b.value) continue;
      if (a.easing === 'hold' || a.easing === 'step') continue;
      if (a.easing === 'linear' && !a.bezier) linear.push(`${t.nodeId}.${t.prop}@${a.t.toFixed(0)}ms`);
    }
  }
  if (linear.length) {
    out.push(find('LINEAR_EASING', [...new Set(linear.map((l) => l.split('.')[0]!))],
      `${linear.length} moving segment(s) use linear easing: ${linear.slice(0, 6).join(', ')}` +
      `${linear.length > 6 ? ` (+${linear.length - 6} more)` : ''}. Nothing physical moves at constant ` +
      `velocity — pass an explicit four-float bezier. Use the CURVES table rather than a preset name, ` +
      `so different techniques do not all share two curves.`));
  }

  // ── NO_OVERSHOOT ──────────────────────────────────────────────────────────
  // Only hero elements, only hero props. An ambient drift and an opacity fade
  // legitimately have no overshoot, and requiring one would make every
  // background wobble.
  // Nodes that are LEAVING — their opacity ends at zero. An exit must not
  // overshoot: a dissolve that bounces is wrong, and demanding one from
  // `transition.slow_dissolve` was the linter mistaking the intent for a defect.
  // The rule is about arrivals.
  const leaving = new Set(
    tracks
      .filter((t) => t.prop === 'opacity' && t.keys.length >= 2 && t.keys[t.keys.length - 1]!.value <= 1)
      .map((t) => t.nodeId),
  );

  const flat: string[] = [];
  for (const t of tracks) {
    if (!heroes.has(t.nodeId) || leaving.has(t.nodeId)) continue;
    if (!HERO_PROPS.has(t.prop) || AMBIENT_PROPS.has(t.prop)) continue;
    if (t.keys.length < 2) continue;
    if (t.keys[0]!.value === t.keys[t.keys.length - 1]!.value) continue; // a hold
    if (!hasOvershoot(t)) flat.push(`${t.nodeId}.${t.prop}`);
  }
  if (flat.length) {
    out.push(find('NO_OVERSHOOT', [...new Set(flat.map((f) => f.split('.')[0]!))],
      `${flat.length} hero move(s) go straight from A to B with no excursion past the target: ` +
      `${flat.slice(0, 5).join(', ')}. Real motion has a *before* and an *after* the destination. ` +
      `Use heroMove(), which emits anticipation → overshoot → settle.`));
  }

  // ── UNIFORM_STAGGER ───────────────────────────────────────────────────────
  const entries = tracks
    .map((t) => ({ nodeId: t.nodeId, at: entryOf(t) }))
    .filter((e): e is { nodeId: string; at: number } => e.at !== null);
  const firstEntry = new Map<string, number>();
  for (const e of entries) {
    const prev = firstEntry.get(e.nodeId);
    if (prev === undefined || e.at < prev) firstEntry.set(e.nodeId, e.at);
  }
  const uiNodes = new Set(scene.uiNodeIds ?? []);
  const sortedEntries = [...firstEntry.entries()]
    .filter(([id]) => !uiNodes.has(id))
    .sort((a, b) => a[1] - b[1]);
  if (sortedEntries.length >= STAGGER_MIN_SIBLINGS) {
    const gaps: number[] = [];
    for (let i = 1; i < sortedEntries.length; i++) {
      gaps.push(sortedEntries[i]![1] - sortedEntries[i - 1]![1]);
    }
    // THREE consecutive identical intervals — four elements in lockstep.
    //
    // The threshold matters. Firing on two identical gaps (three elements) is too
    // aggressive: a curved stagger's neighbouring gaps naturally land within a
    // couple of percent of each other somewhere along the ramp, and reporting
    // that made the linter flag genuinely well-curved output. Two identical gaps
    // is a coincidence; three is a metronome.
    let similarRun = 0;
    for (let i = 1; i < gaps.length; i++) {
      const a = gaps[i - 1]!;
      const b = gaps[i]!;
      const scale = Math.max(Math.abs(a), Math.abs(b), 1e-6);
      similarRun = b > 0 && Math.abs(b - a) / scale <= STAGGER_RELATIVE_EPSILON ? similarRun + 1 : 0;
      // Two MATCHES means three identical gaps, i.e. four elements in lockstep.
      // (One match is two identical gaps, which a curved stagger produces
      // somewhere along its ramp by chance — flagging that reported genuinely
      // well-curved output as a metronome.)
      if (similarRun >= STAGGER_MIN_SIBLINGS - 1) {
        out.push(find('UNIFORM_STAGGER', sortedEntries.map((s) => s[0]),
          `${similarRun + 1} elements enter on an identical ${gaps[i]!.toFixed(0)}ms interval. A fixed ` +
          `stagger is the most recognisable generated-timing signature there is. Use staggerAt(), ` +
          `which applies the pack's stagger curve in waves (never a constant interval).`));
        break;
      }
    }
  }

  // ── SIMULTANEOUS_ENTRY ────────────────────────────────────────────────────
  let group: [string, number][] = [];
  const flushGroup = (): void => {
    if (group.length >= SIMULTANEITY_MIN_LAYERS) {
      out.push(find('SIMULTANEOUS_ENTRY', group.map((g) => g[0]),
        `${group.length} elements all enter at ${group[0]![1].toFixed(0)}ms. Everything arriving at ` +
        `once reads as a single block — the eye needs an order to follow.`));
    }
    group = [];
  };
  for (const e of sortedEntries) {
    if (group.length && e[1] - group[0]![1] > SIMULTANEITY_WINDOW_MS) flushGroup();
    group.push(e);
  }
  flushGroup();

  // ── NO_PROPERTY_OFFSET (warn) ─────────────────────────────────────────────
  const byNode = new Map<string, Track[]>();
  for (const t of tracks) {
    const list = byNode.get(t.nodeId) ?? [];
    list.push(t);
    byNode.set(t.nodeId, list);
  }
  const noOffset: string[] = [];
  for (const [nodeId, list] of byNode) {
    const moving = list.filter((t) => entryOf(t) !== null);
    if (moving.length < 2) continue;
    const starts = moving.map((t) => t.keys[0]!.t);
    if (Math.max(...starts) - Math.min(...starts) < frameMs * 0.5) noOffset.push(nodeId);
  }
  if (noOffset.length) {
    out.push(find('NO_PROPERTY_OFFSET', noOffset,
      `${noOffset.length} layer(s) start every animated property on the same frame. Scale should lead ` +
      `opacity by a frame and position should lag it by two — one or two frames is felt, not seen, ` +
      `and its absence is what makes a move read as one flat transform.`));
  }

  // ── POPPING ───────────────────────────────────────────────────────────────
  const popping: string[] = [];
  for (const t of tracks) {
    if (t.keys.length < 2) continue;
    const values = t.keys.map((k) => k.value);
    const range = Math.max(...values) - Math.min(...values);
    if (range <= 0) continue;
    for (let i = 1; i < t.keys.length; i++) {
      const a = t.keys[i - 1]!;
      const b = t.keys[i]!;
      // A `hold`/`step` segment is SUPPOSED to jump — that is what a hold is for,
      // and glitch techniques are built out of them.
      if (a.easing === 'hold' || a.easing === 'step') continue;
      const dt = b.t - a.t;
      if (dt > frameMs * 1.5) continue;
      if (Math.abs(b.value - a.value) / range > POP_FRACTION) {
        popping.push(`${t.nodeId}.${t.prop}@${b.t.toFixed(0)}ms`);
      }
    }
  }
  if (popping.length) {
    out.push(find('POPPING', [...new Set(popping.map((pp) => pp.split('.')[0]!))],
      `${popping.length} value(s) jump most of their range inside one frame: ${popping.slice(0, 5).join(', ')}. ` +
      `That reads as a glitch rather than a move. Spread it over more frames, or use 'hold' easing if ` +
      `the jump is deliberate.`));
  }

  // ── DEAD_AIR (warn) ───────────────────────────────────────────────────────
  const busy: [number, number][] = tracks
    .filter((t) => t.keys.length >= 2)
    .map((t) => [t.keys[0]!.t, t.keys[t.keys.length - 1]!.t] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  if (busy.length) {
    let cursor = 0;
    const gaps: [number, number][] = [];
    for (const [from, to] of busy) {
      if (from - cursor > DEAD_AIR_MS) gaps.push([cursor, from]);
      cursor = Math.max(cursor, to);
    }
    if (scene.durationMs - cursor > DEAD_AIR_MS) gaps.push([cursor, scene.durationMs]);
    if (gaps.length) {
      out.push(find('DEAD_AIR', [],
        `${gaps.length} stretch(es) longer than ${DEAD_AIR_MS}ms with nothing animating: ` +
        `${gaps.map(([a, b]) => `${(a / 1000).toFixed(1)}–${(b / 1000).toFixed(1)}s`).join(', ')}. ` +
        `A held beat is good; ${(Math.max(...gaps.map(([a, b]) => b - a)) / 1000).toFixed(1)}s of stillness is a stall.`));
    }
  }

  // ── MISSING_MOTION_BLUR (warn) ────────────────────────────────────────────
  const blurred = new Set(
    scene.calls
      .filter((c) => c.name === 'set_motion_blur' && c.args.nodeId && c.args.enabled !== false)
      .map((c) => String(c.args.nodeId)),
  );
  const fastUnblurred: string[] = [];
  for (const t of tracks) {
    if (t.prop !== 'x' && t.prop !== 'y') continue;
    if (blurred.has(t.nodeId)) continue;
    for (let i = 1; i < t.keys.length; i++) {
      const dt = (t.keys[i]!.t - t.keys[i - 1]!.t) / 1000;
      if (dt <= 0) continue;
      const v = Math.abs(t.keys[i]!.value - t.keys[i - 1]!.value) / dt;
      if (v > 900) { fastUnblurred.push(t.nodeId); break; }
    }
  }
  if (fastUnblurred.length) {
    out.push(find('MISSING_MOTION_BLUR', [...new Set(fastUnblurred)],
      `${new Set(fastUnblurred).size} layer(s) exceed 900px/s with motion blur off. Fast unblurred ` +
      `motion is the clearest "looks cheap" signal in the frame. (Ignore this on product-UI elements — ` +
      `real interfaces do not blur.)`));
  }

  // ── SUB_MINIMUM_DURATION and ANTIPATTERN_VIOLATION ────────────────────────
  const instances = scene.instances ?? [];
  for (const inst of instances) {
    if (inst.minDurationMs !== undefined && inst.durationMs < inst.minDurationMs) {
      out.push(find('SUB_MINIMUM_DURATION', [],
        `'${inst.id}' was given ${inst.durationMs}ms but needs at least ${inst.minDurationMs}ms to read ` +
        `at all. Lengthen the beat or cast a faster technique.`));
    }
  }
  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      const a = instances[i]!;
      const b = instances[j]!;
      const clash = a.neverWith?.includes(b.id) || b.neverWith?.includes(a.id);
      if (!clash) continue;
      // Only when they actually OVERLAP in time. Two clashing techniques in
      // different acts of a two-minute piece are not a clash.
      const overlap = a.startMs < b.startMs + b.durationMs && b.startMs < a.startMs + a.durationMs;
      if (overlap) {
        out.push(find('ANTIPATTERN_VIOLATION', [],
          `'${a.id}' and '${b.id}' are both live between ` +
          `${(Math.max(a.startMs, b.startMs) / 1000).toFixed(1)}s and ` +
          `${(Math.min(a.startMs + a.durationMs, b.startMs + b.durationMs) / 1000).toFixed(1)}s, and they clash. ` +
          `Separate them in time or drop one.`));
      }
    }
  }

  // ── NO_CONTINUITY ─────────────────────────────────────────────────────────
  // The rule that turns segments into a piece. A boundary with zero survivors is
  // a slideshow transition, and a sequence of them is a slideshow.
  for (const b of scene.beatBoundaries ?? []) {
    if (b.survivors <= 0) {
      out.push(find('NO_CONTINUITY', [],
        `Nothing survives the beat boundary at ${(b.atMs / 1000).toFixed(1)}s — every element exits and a ` +
        `new set enters. That is a slideshow, not a cut. Declare at least one element that persists, ` +
        `transforms into, match-cuts to, or carries motion across the boundary.`));
    }
  }

  return out;
}

/**
 * Weighted pass rate, 0..1.
 *
 * This replaces `compose ratio` as the quality number. The old metric measured
 * the share of mutations that went through the recipe layer, and treated a high
 * ratio as good — but with a small generic recipe set, a high compose ratio means
 * every output came from the same handful of shapes. It measured HOMOGENEITY and
 * reported it as quality.
 */
export function craftScore(findings: readonly TimingFinding[]): number {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  return Math.max(0, 1 - (errors * 3 + warns) / 22);
}

export function formatTimingFindings(findings: readonly TimingFinding[]): string | null {
  if (!findings.length) return null;
  const errors = findings.filter((f) => f.severity === 'error');
  const warns = findings.filter((f) => f.severity === 'warn');
  const lines: string[] = [];
  if (errors.length) {
    lines.push(`${errors.length} timing error(s) — these block:`);
    lines.push(...errors.map((f) => `  [${f.rule}] ${f.message}`));
  }
  if (warns.length) {
    lines.push(`${warns.length} timing warning(s):`);
    lines.push(...warns.map((f) => `  [${f.rule}] ${f.message}`));
  }
  return lines.join('\n');
}
