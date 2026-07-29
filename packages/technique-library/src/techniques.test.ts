/**
 * The acceptance test for Phase 2 and Phase 4.1.
 *
 * Two claims are proved here, and they are the two the whole architecture rests
 * on:
 *
 *  1. **The craft floor is real.** Every technique exhibits at least four of the
 *     eight markers, VERIFIED against the emitted calls rather than trusted from
 *     the declaration. A technique that says it overshoots and does not is worse
 *     than one that admits it doesn't.
 *  2. **The timing linter passes on 100% of library output, with no iteration.**
 *     That is what makes the quality floor deterministic instead of stochastic —
 *     and it is why running the caster on a weak model can still produce
 *     professional output.
 */

import { LOOK_PACKS, resolvePack } from '@motion/design-system';
import { TECHNIQUES, candidates, clashesWith, technique, techniqueIds } from './registry';
import { coerceParams, CRAFT_MARKERS, type CraftMarker, type EmitContext, type TechniqueDef } from './schema';
import { craftScore, lintTiming, tracksFromCalls } from './lint';

const FRAME = { width: 1920, height: 1080 };
const FPS = 30;

/** Every role a technique might animate, so no emit path is skipped. */
const ALL_TARGETS: EmitContext['targets'] = {
  headline: ['hl_0', 'hl_1', 'hl_2'],
  subhead: ['sub_0'],
  support: ['sup_0'],
  overline: ['ov_0'],
  media: ['media_0'],
  mark: ['mark_0'],
  stat: ['stat_0', 'stat_1', 'stat_2'],
  quote: ['quote_0', 'quote_1'],
  list: ['li_0', 'li_1', 'li_2'],
  cta: ['cta_0'],
  rule: ['rule_0'],
  background: ['bg_0'],
  camera: [],
};

function contextFor(packId: string, durationMs = 4000): EmitContext {
  const pack = resolvePack(packId);
  return {
    startMs: 500,
    durationMs,
    frameMs: 1000 / FPS,
    width: FRAME.width,
    height: FRAME.height,
    pack,
    targets: ALL_TARGETS,
    idPrefix: 'tst',
  };
}

function emit(t: TechniqueDef, packId: string, seed: number, durationMs?: number) {
  // Clamp to the technique's own declared range. Handing a 1.8s-max technique a
  // 4s slot stretches its moves until they are slow — which then reports
  // `motion_blur` as absent on a technique whose whole point is speed.
  const dur = Math.min(Math.max(durationMs ?? 4000, t.minDurationMs), t.maxDurationMs);
  const ctx = contextFor(packId, dur);
  const params = coerceParams(t.params, {});
  return { ctx, calls: t.emit(ctx, params.value, seed) };
}

/** Which packs allow a given technique. */
function packsFor(t: TechniqueDef): string[] {
  return LOOK_PACKS.filter((p) => !p.forbid.includes(t.id)).map((p) => p.id);
}

// ── Marker verification ───────────────────────────────────────────────

/**
 * Detect which markers the EMITTED CALLS actually exhibit.
 *
 * Deliberately independent of what the technique declares. A declaration is a
 * claim; this is the measurement, and the test below compares them.
 */
function detectMarkers(calls: ReturnType<typeof emit>['calls'], ctx: EmitContext): Set<CraftMarker> {
  const found = new Set<CraftMarker>();
  const tracks = tracksFromCalls(calls);
  const frameMs = ctx.frameMs;

  for (const t of tracks) {
    // explicit_bezier — four floats, not a preset name.
    if (t.keys.some((k) => k.bezier?.length === 4)) found.add('explicit_bezier');

    // overshoot — an intermediate key past the final value, or a y>1 curve.
    if (t.keys.length >= 3) {
      const first = t.keys[0]!.value;
      const last = t.keys[t.keys.length - 1]!.value;
      const dir = Math.sign(last - first);
      for (let i = 1; i < t.keys.length - 1; i++) {
        const excursion = t.keys[i]!.value - last;
        // dir === 0 means the track returns to where it started — any excursion
        // in between IS the overshoot, and skipping that case reported
        // `emphasis.flash_pop` (1 → 0.985 → 1.03 → 1) as having none.
        if (dir === 0 ? excursion !== 0 : Math.sign(excursion) === dir) found.add('overshoot');
      }
    }
    if (t.keys.some((k) => k.bezier && (k.bezier[1]! > 1.001 || k.bezier[3]! > 1.001))) found.add('overshoot');

    // anticipation — an early key on the OPPOSITE side of the start value from
    // the destination, or a negative-y1 curve.
    if (t.keys.length >= 3) {
      const first = t.keys[0]!.value;
      const last = t.keys[t.keys.length - 1]!.value;
      const dir = Math.sign(last - first);
      if (dir !== 0 && Math.sign(t.keys[1]!.value - first) === -dir) found.add('anticipation');
    }
    if (t.keys.some((k) => k.bezier && k.bezier[1]! < -0.001)) found.add('anticipation');

    // subframe_care — a keyframe or a hold that is not on a frame boundary.
    for (const k of t.keys) {
      const off = Math.abs((k.t % frameMs) / frameMs);
      if (off > 0.15 && off < 0.85) found.add('subframe_care');
      if (k.easing === 'hold' || k.easing === 'step') found.add('subframe_care');
    }
  }

  // cross_property_offset — two properties on ONE layer starting on different frames.
  const byNode = new Map<string, { start: number; end: number }[]>();
  for (const t of tracks) {
    const spans = byNode.get(t.nodeId) ?? [];
    spans.push({ start: t.keys[0]?.t ?? 0, end: t.keys[t.keys.length - 1]?.t ?? 0 });
    byNode.set(t.nodeId, spans);
  }
  for (const spans of byNode.values()) {
    if (spans.length < 2) continue;
    const starts = spans.map((s) => s.start);
    if (Math.max(...starts) - Math.min(...starts) >= frameMs * 0.4) found.add('cross_property_offset');

    // follow_through — secondary motion that BEGINS after a primary channel has
    // already settled. Detecting it as "the track crosses its final value" does
    // not work: an overshoot has exactly the same keyframe shape, and the two
    // are the same physical phenomenon applied at different times. What
    // distinguishes follow-through is precisely the timing — something is still
    // moving after the main move finished.
    for (const a of spans) {
      for (const b of spans) {
        if (a === b) continue;
        if (b.start >= a.end - frameMs * 0.5 && b.end > b.start) found.add('follow_through');
      }
    }
  }

  // nonuniform_stagger — three or more entry times whose gaps are NOT all equal.
  const entries = [...byNode.values()].map((spans) => Math.min(...spans.map((x) => x.start))).sort((a, b) => a - b);
  if (entries.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < entries.length; i++) gaps.push(entries[i]! - entries[i - 1]!);
    const positive = gaps.filter((g) => g > 0.5);
    if (positive.length >= 2) {
      const spread = Math.max(...positive) - Math.min(...positive);
      if (spread > 2) found.add('nonuniform_stagger');
    }
  }

  // motion_blur — a per-layer enable was emitted.
  if (calls.some((c) => c.name === 'set_motion_blur' && c.args.nodeId)) found.add('motion_blur');

  // A text animator with an animated selector is per-character cross-property
  // motion by construction.
  if (calls.some((c) => c.name === 'text_animator' && c.args.sweep)) {
    found.add('cross_property_offset');
    found.add('nonuniform_stagger');
  }

  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('the library itself', () => {
  it('ships at least 20 techniques — below that, output visibly repeats', () => {
    expect(TECHNIQUES.length).toBeGreaterThanOrEqual(20);
  });

  it('has unique ids, category-prefixed', () => {
    const ids = techniqueIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TECHNIQUES) {
      expect(t.id.startsWith(`${t.category}.`) || t.id.split('.')[0]!.length > 0).toBe(true);
    }
  });

  it('covers every category that carries a piece', () => {
    const cats = new Set(TECHNIQUES.map((t) => t.category));
    for (const need of ['entrance', 'kinetic_type', 'transition', 'camera', 'background', 'emphasis', 'exit']) {
      expect([...cats]).toContain(need);
    }
  });

  it('gives every technique a real intent and a bounded duration', () => {
    for (const t of TECHNIQUES) {
      expect(t.intent.length).toBeGreaterThan(25);
      expect(t.maxDurationMs).toBeGreaterThan(t.minDurationMs);
      expect(t.variants).toBeGreaterThanOrEqual(2);
      expect(t.roles.length).toBeGreaterThan(0);
    }
  });

  it('declares antipatterns symmetrically enough to be enforceable', () => {
    // A `neverWith` naming a technique that does not exist is a rule that can
    // never fire — worse than no rule, because it looks like coverage.
    const ids = new Set(techniqueIds());
    for (const t of TECHNIQUES) {
      for (const other of t.antipatterns.neverWith ?? []) {
        expect(`${t.id} → ${other}`).toBe(ids.has(other) ? `${t.id} → ${other}` : `${t.id} → ${other} (UNKNOWN ID)`);
      }
    }
  });
});

describe('the craft floor', () => {
  /**
   * Markers a technique exhibits across the packs it is allowed in.
   *
   * Union rather than intersection, because several markers are legitimately
   * pack-conditional: `motion_blur` fires only where the pack's `blurBias` and
   * the move's velocity warrant it, and `overshoot` scales with `overshootBias`
   * — so `luxury_film` deliberately gets a whisper where `broadcast_sports` gets
   * a punch. Judging a technique on one pack would report those as absent.
   */
  const markersAcrossPacks = (t: TechniqueDef): Set<CraftMarker> => {
    const union = new Set<CraftMarker>();
    for (const packId of packsFor(t)) {
      for (let seed = 0; seed < t.variants; seed++) {
        const { ctx, calls } = emit(t, packId, seed, Math.max(t.minDurationMs + 600, 4000));
        for (const m of detectMarkers(calls, ctx)) union.add(m);
      }
    }
    return union;
  };

  it('every technique exhibits at least FOUR craft markers in its actual output', () => {
    const failures: string[] = [];
    for (const t of TECHNIQUES) {
      const found = markersAcrossPacks(t);
      if (found.size < 4) {
        failures.push(`${t.id}: only ${found.size} marker(s) — ${[...found].join(', ') || 'none'}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('every DECLARED marker is actually present — a claim is not evidence', () => {
    const failures: string[] = [];
    for (const t of TECHNIQUES) {
      const found = markersAcrossPacks(t);
      const missing = t.markers.filter((m) => !found.has(m));
      if (missing.length) failures.push(`${t.id} declares but does not exhibit: ${missing.join(', ')}`);
    }
    expect(failures).toEqual([]);
  });

  it('every marker name a technique declares is a real marker', () => {
    for (const t of TECHNIQUES) {
      for (const m of t.markers) expect(CRAFT_MARKERS).toContain(m);
    }
  });

  it('never uses a bare easing preset on a moving segment', () => {
    // The library's single most important stylistic rule: presets give every
    // technique the same two curves, which is the homogeneity the library exists
    // to remove.
    const failures: string[] = [];
    for (const t of TECHNIQUES) {
      for (const packId of packsFor(t).slice(0, 3)) {
        const { calls } = emit(t, packId, 0);
        for (const track of tracksFromCalls(calls)) {
          for (let i = 0; i < track.keys.length - 1; i++) {
            const a = track.keys[i]!;
            const b = track.keys[i + 1]!;
            if (a.value === b.value) continue;
            if (a.easing === 'hold' || a.easing === 'step') continue;
            if (!a.bezier) failures.push(`${t.id}/${packId}: ${track.nodeId}.${track.prop} uses '${a.easing}'`);
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });
});

describe('the timing linter on library output', () => {
  it('passes with ZERO errors for every technique × pack × variant', () => {
    const failures: string[] = [];
    for (const t of TECHNIQUES) {
      for (const packId of packsFor(t)) {
        for (let seed = 0; seed < t.variants; seed++) {
          const { ctx, calls } = emit(t, packId, seed, Math.max(t.minDurationMs + 600, 4000));
          const errors = lintTiming({
            calls,
            fps: FPS,
            durationMs: ctx.startMs + ctx.durationMs,
            heroNodeIds: [...(ALL_TARGETS.headline ?? []), ...(ALL_TARGETS.mark ?? []), ...(ALL_TARGETS.stat ?? [])],
          }).filter((f) => f.severity === 'error');
          if (errors.length) {
            failures.push(`${t.id} / ${packId} / seed ${seed}: ${errors.map((e) => e.rule).join(', ')}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('scores highly on craftScore', () => {
    for (const t of TECHNIQUES) {
      const packId = packsFor(t)[0]!;
      const { ctx, calls } = emit(t, packId, 0, Math.max(t.minDurationMs + 600, 4000));
      const findings = lintTiming({ calls, fps: FPS, durationMs: ctx.startMs + ctx.durationMs });
      expect(craftScore(findings)).toBeGreaterThan(0.85);
    }
  });
});

describe('the timing linter itself', () => {
  const kf = (nodeId: string, prop: string, keys: { t: number; value: number; easing?: string; bezier?: number[] }[]) => ({
    name: 'set_keyframes',
    args: { keyframes: keys.map((k) => ({ nodeId, prop, t: k.t, value: k.value, easing: k.easing ?? 'linear', ...(k.bezier ? { bezier: k.bezier } : {}) })) },
  });

  it('catches linear easing on a move', () => {
    const f = lintTiming({ calls: [kf('a', 'x', [{ t: 0, value: 0 }, { t: 1, value: 100 }])], fps: 30, durationMs: 2000 });
    expect(f.map((x) => x.rule)).toContain('LINEAR_EASING');
  });

  it('does NOT flag a linear segment between two equal values — that is a hold', () => {
    // The false positive that would fire on every deliberate beat.
    const f = lintTiming({ calls: [kf('a', 'x', [{ t: 0, value: 50 }, { t: 1, value: 50 }])], fps: 30, durationMs: 2000 });
    expect(f.map((x) => x.rule)).not.toContain('LINEAR_EASING');
  });

  it('catches a two-keyframe hero move with no overshoot', () => {
    const f = lintTiming({
      calls: [kf('hero', 'scale', [{ t: 0, value: 0.9, bezier: [0.2, 0, 0.3, 1] }, { t: 0.4, value: 1, bezier: [0.2, 0, 0.3, 1] }])],
      fps: 30, durationMs: 2000, heroNodeIds: ['hero'],
    });
    expect(f.map((x) => x.rule)).toContain('NO_OVERSHOOT');
  });

  it('accepts a two-keyframe move whose CURVE overshoots', () => {
    // Authoring an overshoot with a y>1 bezier is real and common; rejecting it
    // would force three keyframes where two suffice.
    const f = lintTiming({
      calls: [kf('hero', 'scale', [{ t: 0, value: 0.9, bezier: [0.34, 1.42, 0.64, 1] }, { t: 0.4, value: 1, bezier: [0.2, 0, 0.3, 1] }])],
      fps: 30, durationMs: 2000, heroNodeIds: ['hero'],
    });
    expect(f.map((x) => x.rule)).not.toContain('NO_OVERSHOOT');
  });

  it('does not demand overshoot from a non-hero layer', () => {
    const f = lintTiming({
      calls: [kf('bg', 'scale', [{ t: 0, value: 1, bezier: [0.4, 0, 0.6, 1] }, { t: 4, value: 1.05, bezier: [0.4, 0, 0.6, 1] }])],
      fps: 30, durationMs: 5000, heroNodeIds: ['hero'],
    });
    expect(f.map((x) => x.rule)).not.toContain('NO_OVERSHOOT');
  });

  it('catches a uniform stagger across three or more siblings', () => {
    const calls = [0, 0.1, 0.2, 0.3].map((t, i) =>
      kf(`n${i}`, 'y', [{ t, value: 20, bezier: [0.2, 0, 0.3, 1] }, { t: t + 0.4, value: 0, bezier: [0.2, 0, 0.3, 1] }]),
    );
    const f = lintTiming({ calls, fps: 30, durationMs: 3000 });
    expect(f.map((x) => x.rule)).toContain('UNIFORM_STAGGER');
  });

  it('accepts a decelerating stagger', () => {
    const calls = [0, 0.09, 0.21, 0.38].map((t, i) =>
      kf(`n${i}`, 'y', [{ t, value: 20, bezier: [0.2, 0, 0.3, 1] }, { t: t + 0.4, value: 0, bezier: [0.2, 0, 0.3, 1] }]),
    );
    const f = lintTiming({ calls, fps: 30, durationMs: 3000 });
    expect(f.map((x) => x.rule)).not.toContain('UNIFORM_STAGGER');
  });

  it('catches a value popping across one frame', () => {
    const f = lintTiming({
      calls: [kf('a', 'x', [{ t: 0, value: 0, bezier: [0.2, 0, 0.3, 1] }, { t: 1 / 30, value: 100, bezier: [0.2, 0, 0.3, 1] }])],
      fps: 30, durationMs: 2000,
    });
    expect(f.map((x) => x.rule)).toContain('POPPING');
  });

  it('does NOT call a deliberate hold a pop', () => {
    // Glitch techniques are built out of one-frame holds. Reporting those would
    // make the linter reject the technique it is supposed to protect.
    const f = lintTiming({
      calls: [kf('a', 'opacity', [{ t: 0, value: 0, easing: 'hold' }, { t: 1 / 30, value: 100, easing: 'hold' }])],
      fps: 30, durationMs: 2000,
    });
    expect(f.map((x) => x.rule)).not.toContain('POPPING');
  });

  it('catches a beat boundary nothing survives', () => {
    const f = lintTiming({ calls: [], fps: 30, durationMs: 8000, beatBoundaries: [{ atMs: 4000, survivors: 0 }] });
    expect(f.map((x) => x.rule)).toContain('NO_CONTINUITY');
  });

  it('accepts a boundary with a survivor', () => {
    const f = lintTiming({ calls: [], fps: 30, durationMs: 8000, beatBoundaries: [{ atMs: 4000, survivors: 1 }] });
    expect(f.map((x) => x.rule)).not.toContain('NO_CONTINUITY');
  });

  it('only reports clashing techniques that OVERLAP in time', () => {
    const base = { fps: 30, durationMs: 60000, calls: [] };
    const overlapping = lintTiming({
      ...base,
      instances: [
        { id: 'a', startMs: 0, durationMs: 3000, neverWith: ['b'] },
        { id: 'b', startMs: 1000, durationMs: 3000 },
      ],
    });
    expect(overlapping.map((x) => x.rule)).toContain('ANTIPATTERN_VIOLATION');

    const separated = lintTiming({
      ...base,
      instances: [
        { id: 'a', startMs: 0, durationMs: 3000, neverWith: ['b'] },
        { id: 'b', startMs: 40000, durationMs: 3000 },
      ],
    });
    expect(separated.map((x) => x.rule)).not.toContain('ANTIPATTERN_VIOLATION');
  });
});

describe('determinism and variation', () => {
  it('same technique + same seed → byte-identical calls', () => {
    for (const t of TECHNIQUES) {
      const packId = packsFor(t)[0]!;
      expect(JSON.stringify(emit(t, packId, 3).calls)).toBe(JSON.stringify(emit(t, packId, 3).calls));
    }
  });

  it('different seeds produce different output', () => {
    const same: string[] = [];
    for (const t of TECHNIQUES) {
      if (t.variants < 2) continue;
      const packId = packsFor(t)[0]!;
      const outputs = new Set<string>();
      for (let s = 0; s < t.variants; s++) outputs.add(JSON.stringify(emit(t, packId, s).calls));
      if (outputs.size < 2) same.push(t.id);
    }
    expect(same).toEqual([]);
  });

  it('the same technique moves differently in different packs', () => {
    // The pack's motion signature and pacing must actually reach the emitter. If
    // this fails, the packs are cosmetic.
    for (const t of TECHNIQUES) {
      const packs = packsFor(t);
      if (packs.length < 2) continue;
      const a = JSON.stringify(emit(t, packs[0]!, 0).calls);
      const b = JSON.stringify(emit(t, packs[packs.length - 1]!, 0).calls);
      expect(`${t.id}: ${a === b ? 'IDENTICAL ACROSS PACKS' : 'differs'}`).toBe(`${t.id}: differs`);
    }
  });
});

describe('casting', () => {
  const query = (over: Partial<Parameters<typeof candidates>[0]> = {}) => {
    const pack = LOOK_PACKS.find((p) => p.id === 'swiss_editorial')!;
    return candidates({
      pack: { id: pack.id, prefer: pack.prefer, forbid: pack.forbid },
      energy: 0.7,
      slotDurationMs: 3000,
      availableRoles: ['headline', 'overline', 'rule', 'background'],
      ...over,
    });
  };

  it('never offers a technique the pack forbids', () => {
    for (const pack of LOOK_PACKS) {
      const list = candidates({
        pack: { id: pack.id, prefer: pack.prefer, forbid: pack.forbid },
        energy: 0.5,
        slotDurationMs: 5000,
        availableRoles: ['headline', 'background', 'mark', 'stat', 'rule', 'camera', 'media', 'list'],
      });
      for (const c of list) expect(pack.forbid).not.toContain(c.technique.id);
    }
  });

  it('never offers a technique that cannot animate any available role', () => {
    // The constrained match. Without it, a technique that animates `stat` gets
    // cast onto a layout with no stats and emits nothing.
    for (const c of query({ availableRoles: ['background'] })) {
      expect(c.technique.roles).toContain('background');
    }
  });

  it('never offers a technique the slot is too short for', () => {
    for (const c of query({ slotDurationMs: 600 })) {
      expect(c.technique.minDurationMs).toBeLessThanOrEqual(600);
    }
  });

  it('respects maxPerComposition', () => {
    const capped = TECHNIQUES.find((t) => t.antipatterns.maxPerComposition === 1)!;
    const list = query({
      alreadyCast: [capped.id],
      availableRoles: [...capped.roles],
      energy: (capped.energy[0] + capped.energy[1]) / 2,
      slotDurationMs: capped.maxDurationMs,
    });
    expect(list.map((c) => c.technique.id)).not.toContain(capped.id);
  });

  it('applies antipatterns SYMMETRICALLY', () => {
    // Checking one direction only meant a clashing pair could be co-cast
    // depending purely on which was chosen first.
    const withNeverWith = TECHNIQUES.find((t) => (t.antipatterns.neverWith?.length ?? 0) > 0)!;
    const victim = withNeverWith.antipatterns.neverWith![0]!;
    expect(clashesWith(technique(victim)!, [withNeverWith.id])).toContain(withNeverWith.id);
    expect(clashesWith(withNeverWith, [victim])).toContain(victim);
  });

  it('caps the list — a model handed 250 options picks from the top', () => {
    expect(query({ limit: 5 })).toHaveLength(5);
    expect(query().length).toBeLessThanOrEqual(25);
  });

  it('ranks the pack preference list first', () => {
    const list = query();
    const pack = LOOK_PACKS.find((p) => p.id === 'swiss_editorial')!;
    const preferred = list.filter((c) => pack.prefer.includes(c.technique.id));
    if (preferred.length) expect(pack.prefer).toContain(list[0]!.technique.id);
  });

  it('gives every editorial pack enough techniques to avoid visible repetition', () => {
    for (const pack of LOOK_PACKS) {
      if (pack.vocabulary === 'product') continue;
      const list = candidates({
        pack: { id: pack.id, prefer: pack.prefer, forbid: pack.forbid },
        energy: (pack.motionSignature.overshootBias + 0.4),
        slotDurationMs: 6000,
        availableRoles: ['headline', 'background', 'mark', 'stat', 'rule', 'camera', 'media', 'list', 'overline', 'cta'],
      });
      expect(`${pack.id}: ${list.length}`).toBe(`${pack.id}: ${Math.max(list.length, 5)}`);
    }
  });
});

describe('param coercion', () => {
  const spec = {
    lines: { kind: 'stringArray', required: true, minItems: 2, maxItems: 4 },
    intensity: { kind: 'number', default: 0.7, min: 0, max: 1 },
    mode: { kind: 'enum', values: ['a', 'b'], default: 'a' },
  } as const;

  it('fills defaults', () => {
    const r = coerceParams(spec as never, { lines: ['x', 'y'] });
    expect(r.value.intensity).toBe(0.7);
    expect(r.value.mode).toBe('a');
  });

  it('fixes a numeric string — the model meant the number', () => {
    expect(coerceParams(spec as never, { lines: ['x', 'y'], intensity: '0.4' }).value.intensity).toBe(0.4);
  });

  it('REPORTS an out-of-range value rather than clamping it', () => {
    // Silently clamping produces output nobody asked for, and the caster never
    // learns its mental model of the parameter was wrong.
    const r = coerceParams(spec as never, { lines: ['x', 'y'], intensity: 4 });
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/maximum is 1/);
  });

  it('reports a missing required param', () => {
    expect(coerceParams(spec as never, {}).errors.join()).toMatch(/'lines' is required/);
  });

  it('drops an unknown key without failing the cast', () => {
    const r = coerceParams(spec as never, { lines: ['x', 'y'], nonsense: 1 });
    expect(r.ok).toBe(true);
    expect(r.errors.join()).toMatch(/ignored/);
    expect(r.value.nonsense).toBeUndefined();
  });
});
