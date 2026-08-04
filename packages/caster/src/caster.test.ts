/**
 * The project-level acceptance test.
 *
 * The one that matters most is **criterion 7 — weak-model parity**:
 *
 * > Running the caster on a weak model produces output that passes the linters,
 * > proving craft lives in the library, not the model.
 *
 * It is simulated here by the harshest version of a weak model: hooks that pick
 * the FIRST candidate every time, always seed 0, never any parameters. If that
 * still passes all three linters with zero errors, then nothing about the quality
 * of the output depended on the model's judgement — which is the entire thesis.
 *
 * A second hook simulates a HOSTILE model that names techniques that do not exist,
 * ones the pack forbids, and ones that clash. That output must also be clean,
 * because the validator falls back deterministically rather than trusting the pick.
 */

import { LOOK_PACKS, candidates, layoutTemplateIds, templatesForPack } from '@motion/design-system';
import { TECHNIQUES } from '@motion/technique-library';
import { PRODUCT_TECHNIQUES } from '@motion/product-motion';
import {
  briefPrompt,
  emitAndValidate,
  layoutCastPrompts,
  motionCastPrompts,
  runCaster,
  sequence,
  availableRolesFor,
  GENERATED_MEDIA,
  survivalBetween,
  tagsForPurpose,
  validate,
  validateCasting,
  type CasterHooks,
  type CreativeBrief,
} from './index';

const FRAME = { width: 1920, height: 1080, fps: 30 };

const CONTENT_A = {
  overline: 'Introducing',
  headline: 'Ship the thing you actually meant to ship',
  subhead: 'One pipeline, from the first commit to the last deploy.',
  cta: 'Start free',
};
const CONTENT_B = {
  headline: 'Ship the thing you actually meant to ship',
  overline: 'The numbers',
  items: [
    { value: '4.2×', label: 'Faster builds', title: 'Faster builds', body: 'Incremental everywhere.' },
    { value: '99.99%', label: 'Uptime', title: 'Always on', body: 'Multi-region by default.' },
    { value: '12k', label: 'Teams', title: 'Proven', body: 'Startups to public companies.' },
  ],
};
const CONTENT_C = {
  headline: 'Ship the thing you actually meant to ship',
  cta: 'Start free',
  support: 'No card required.',
};

function briefFor(packId: string, energy = 0.5): CreativeBrief {
  return {
    lookPackId: packId,
    energy,
    tone: 'confident, unhurried, technical',
    totalDurationMs: 12000,
    beats: [
      { purpose: 'open on the promise', weight: 1.2, content: CONTENT_A },
      { purpose: 'proof — the numbers', weight: 1, content: CONTENT_B },
      { purpose: 'close on the CTA', weight: 0.8, content: CONTENT_C },
    ],
  };
}

/** The weakest plausible model: first candidate, seed 0, no params, every time. */
function weakHooks(brief: CreativeBrief): CasterHooks {
  return {
    brief: async () => brief,
    cast: async (prompts, kind) => {
      const seq = sequence(brief);
      const lists = kind === 'layout'
        ? layoutCastPrompts(seq, brief.lookPackId)
        : motionCastPrompts(seq, brief.lookPackId, brief.energy);
      return prompts.map((p) => {
        const list = lists.find((l) => l.beatIndex === p.beatIndex);
        return { beatIndex: p.beatIndex, id: list?.allowed[0] ?? '', seed: 0 };
      });
    },
  };
}

/** A hostile model: unknown ids, forbidden ids, clashing pairs, absurd params. */
function hostileHooks(brief: CreativeBrief): CasterHooks {
  return {
    brief: async () => brief,
    cast: async (prompts, kind) =>
      prompts.map((p, i) => ({
        beatIndex: p.beatIndex,
        id: kind === 'layout'
          ? ['does.not.exist', 'ui.phone_frame', 'hero.centered_stack'][i % 3]!
          : ['camera.crash_zoom', 'kinetic_type.hard_cut_stack', 'nope.nothing'][i % 3]!,
        params: { intensity: 99, spanMs: -400, nonsense: true },
        seed: 0,
      })),
  };
}

function lintErrors(report: { findings: readonly { severity: string; source: string; rule: string }[] }) {
  return report.findings.filter((f) => f.severity === 'error');
}

// ── The sequencer ─────────────────────────────────────────────────────

describe('the sequencer', () => {
  it('normalises weights and gives every beat at least the floor', () => {
    const seq = sequence(briefFor('apple_keynote'));
    expect(seq.beats).toHaveLength(3);
    for (const b of seq.beats) expect(b.durationMs).toBeGreaterThanOrEqual(700);
    expect(seq.totalDurationMs).toBeGreaterThanOrEqual(11000);
  });

  it('lays beats end to end with no gaps', () => {
    const seq = sequence(briefFor('swiss_editorial'));
    for (let i = 1; i < seq.beats.length; i++) {
      expect(seq.beats[i]!.startMs).toBe(seq.beats[i - 1]!.startMs + seq.beats[i - 1]!.durationMs);
    }
  });

  it('derives a survivor for every boundary from shared content', () => {
    // The continuity contract. All three beats share a headline, so every boundary
    // is a `persist` — the strongest thread available short of a shared asset.
    const seq = sequence(briefFor('apple_keynote'));
    expect(seq.boundaries).toHaveLength(2);
    for (const b of seq.boundaries) expect(b.survivors).toBeGreaterThan(0);
    expect(seq.beats[0]!.survival?.kind).toBe('persist');
  });

  it('ranks a shared media asset above a shared headline', () => {
    // A viewer tracks a single OBJECT across a cut more strongly than repeated
    // text, so `transform_into` outranks `persist`.
    const s = survivalBetween(
      { headline: 'Same', mediaAssetId: 'a1' },
      { headline: 'Same', mediaAssetId: 'a1' },
    );
    expect(s).toEqual({ kind: 'transform_into', role: 'media' });
  });

  it('falls back to a match cut when only the ROLE is shared', () => {
    const s = survivalBetween({ headline: 'One' }, { headline: 'Two' });
    expect(s).toEqual({ kind: 'match_cut', role: 'headline' });
  });

  it('REJECTS a boundary that shares nothing when autoCarry is off', () => {
    // The rule that turns segments into a piece. Without it, "3–5 scenes tiling
    // the duration" structurally guarantees a slideshow.
    const brief: CreativeBrief = {
      ...briefFor('apple_keynote'),
      beats: [
        { purpose: 'a', weight: 1, content: { headline: 'One' } },
        { purpose: 'b', weight: 1, content: { items: [{ value: '1', label: 'x' }] } },
      ],
    };
    const seq = sequence(brief, { autoCarry: false });
    const problems = validate(seq);
    expect(problems.some((p) => p.severity === 'error' && /no surviving element/.test(p.message))).toBe(true);
  });

  it('bridges a bare boundary with carry_motion by default, and says so', () => {
    const brief: CreativeBrief = {
      ...briefFor('apple_keynote'),
      beats: [
        { purpose: 'a', weight: 1, content: { headline: 'One' } },
        { purpose: 'b', weight: 1, content: { items: [{ value: '1', label: 'x' }] } },
        { purpose: 'c', weight: 1, content: { quote: 'Q' } },
      ],
    };
    const seq = sequence(brief);
    expect(validate(seq).some((p) => p.severity === 'error')).toBe(false);
    // Reported as a warning, so weak continuity is visible rather than silent.
    expect(validate(seq).some((p) => /carry_motion/.test(p.message))).toBe(true);
  });

  it('flags a single beat stretched over a long duration', () => {
    const seq = sequence({ ...briefFor('luxury_film'), beats: [{ purpose: 'hero', weight: 1, content: CONTENT_A }] });
    expect(validate(seq).some((p) => /one beat/i.test(p.message))).toBe(true);
  });

  it('derives usable tag hints from a free-text purpose', () => {
    expect(tagsForPurpose('proof — the numbers')).toContain('stat');
    expect(tagsForPurpose('close on the CTA')).toContain('cta');
    expect(tagsForPurpose('open on the promise')).toContain('hero');
  });
});

// ── Casting validation ────────────────────────────────────────────────

describe('casting validation', () => {
  const brief = briefFor('swiss_editorial', 0.75);
  const seq = sequence(brief);

  it('replaces an unknown technique with the top-ranked valid candidate', () => {
    const { casting, problems } = validateCasting(seq, brief.lookPackId, brief.energy, {
      layouts: seq.beats.map((b) => ({ beatIndex: b.index, templateId: 'nope.nothing', seed: 0 })),
      motion: seq.beats.map((b) => ({ beatIndex: b.index, techniqueId: 'also.nothing', params: {}, seed: 0 })),
    });
    expect(problems.length).toBeGreaterThan(0);
    for (const l of casting.layouts) expect(l.templateId).not.toBe('nope.nothing');
    for (const m of casting.motion) expect(m.techniqueId).not.toBe('also.nothing');
  });

  it('rejects a technique the pack forbids', () => {
    const forbidden = LOOK_PACKS.find((p) => p.id === 'swiss_editorial')!.forbid[0]!;
    const { casting, problems } = validateCasting(seq, brief.lookPackId, brief.energy, {
      layouts: [],
      motion: [{ beatIndex: 0, techniqueId: forbidden, params: {}, seed: 0 }],
    });
    expect(problems.some((p) => /forbidden/.test(p.message))).toBe(true);
    expect(casting.motion[0]?.techniqueId).not.toBe(forbidden);
  });

  it('enforces maxPerComposition across beats', () => {
    // The canonical case: a crash zoom twice in fifteen seconds is amateur, the
    // model agrees it is amateur, and the model plans it anyway.
    const capped = TECHNIQUES.find((t) => t.antipatterns.maxPerComposition === 1)!;
    const energy = (capped.energy[0] + capped.energy[1]) / 2;
    const packId = LOOK_PACKS.find((p) => !p.forbid.includes(capped.id))!.id;
    const s = sequence({ ...briefFor(packId, energy), totalDurationMs: 30000 });
    const { casting } = validateCasting(s, packId, energy, {
      layouts: [],
      motion: s.beats.map((b) => ({ beatIndex: b.index, techniqueId: capped.id, params: {}, seed: 0 })),
    });
    expect(casting.motion.filter((m) => m.techniqueId === capped.id).length).toBeLessThanOrEqual(1);
  });

  it('never leaves a beat with a seed of 0 on every beat', () => {
    // Four declared variants all at seed 0 is one variant. A fallback derived
    // from the beat index at least varies it.
    const { casting } = validateCasting(seq, brief.lookPackId, brief.energy, { layouts: [], motion: [] });
    expect(new Set(casting.layouts.map((l) => l.seed)).size).toBeGreaterThan(1);
  });
});

// ── Emit ──────────────────────────────────────────────────────────────

describe('emit', () => {
  function run(packId: string, energy = 0.5) {
    const brief = briefFor(packId, energy);
    const seq = sequence(brief);
    const { casting } = validateCasting(seq, packId, energy, {
      layouts: seq.beats.map((b) => ({ beatIndex: b.index, templateId: '', seed: b.index + 2 })),
      motion: [],
    });
    return emitAndValidate({
      sequence: seq, casting, lookPackId: packId,
      width: FRAME.width, height: FRAME.height, fps: FRAME.fps,
    });
  }

  it('emits the composition shutter exactly once', () => {
    const { calls } = run('broadcast_sports');
    const comp = calls.filter((c) => c.name === 'set_motion_blur' && !c.args.nodeId);
    expect(comp.length).toBeLessThanOrEqual(1);
  });

  it('gives each beat its own id prefix so two beats cannot collide', () => {
    // Two beats using the same template must not produce the same layer ids, or
    // beat 2's update_layer silently retargets beat 1's headline.
    const { calls } = run('saas_explainer');
    const ids = calls.filter((c) => c.name === 'create_layer').map((c) => String(c.args.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces a report with real metrics', () => {
    const { report } = run('apple_keynote');
    expect(report.beats).toBe(3);
    expect(report.templates.length).toBe(3);
    expect(report.metrics.templateDiversity).toBeGreaterThan(0);
    expect(report.metrics.variantEntropy).toBeGreaterThan(0);
  });

  it('is deterministic — the same sequence and casting produce identical calls', () => {
    expect(JSON.stringify(run('luxury_film').calls)).toBe(JSON.stringify(run('luxury_film').calls));
  });
});

// ── The headline test: weak-model parity ──────────────────────────────

describe('weak-model parity (criterion 7)', () => {
  const EDITORIAL = LOOK_PACKS.filter((p) => p.vocabulary === 'editorial').map((p) => p.id);

  it('passes all three linters with a model that always picks the first option', async () => {
    // This is the thesis, stated as a test. If a model that exercises NO judgement
    // still produces clean output, then none of the quality came from the model.
    const failures: string[] = [];
    for (const packId of EDITORIAL) {
      for (const energy of [0.2, 0.5, 0.85]) {
        const brief = briefFor(packId, energy);
        const r = await runCaster({
          userPrompt: 'a product launch teaser',
          hooks: weakHooks(brief),
          ...FRAME,
        });
        const errors = lintErrors(r.report);
        if (errors.length) {
          failures.push(`${packId}@${energy}: ${errors.map((e) => `${e.source}/${e.rule}`).join(', ')}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('passes all three linters with a HOSTILE model', async () => {
    // Unknown ids, forbidden ids, clashing pairs, out-of-range params. Every one
    // is corrected deterministically rather than re-requested, so the output is
    // clean even though every single pick was wrong.
    const failures: string[] = [];
    for (const packId of EDITORIAL) {
      const brief = briefFor(packId, 0.6);
      const r = await runCaster({
        userPrompt: 'a product launch teaser',
        hooks: hostileHooks(brief),
        ...FRAME,
      });
      const errors = lintErrors(r.report);
      if (errors.length) failures.push(`${packId}: ${errors.map((e) => `${e.source}/${e.rule}`).join(', ')}`);
      // And it must have NOTICED, rather than silently accepting nonsense.
      expect(r.problems.casting.length).toBeGreaterThan(0);
    }
    expect(failures).toEqual([]);
  });

  it('scores well on all three scores even at the weakest setting', async () => {
    for (const packId of EDITORIAL) {
      const brief = briefFor(packId, 0.5);
      const r = await runCaster({ userPrompt: 'x', hooks: weakHooks(brief), ...FRAME });
      expect(r.report.designScore).toBeGreaterThan(0.8);
      expect(r.report.craftScore).toBeGreaterThan(0.8);
    }
  });
});

// ── Determinism and diversity ─────────────────────────────────────────

describe('determinism (criterion 1) and diversity (criterion 3)', () => {
  it('same prompt + same seed → byte-identical calls', async () => {
    const brief = briefFor('apple_keynote');
    const a = await runCaster({ userPrompt: 'x', hooks: weakHooks(brief), ...FRAME });
    const b = await runCaster({ userPrompt: 'x', hooks: weakHooks(brief), ...FRAME });
    expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
  });

  it('different seeds produce visibly different results', async () => {
    // Criterion 3 wants ≥12 of 20 runs distinct. Measured here across seeds on one
    // pack, holding everything else fixed, so the variation is attributable to the
    // libraries' variant axes rather than to a different brief.
    const brief = briefFor('swiss_editorial', 0.7);
    const seq = sequence(brief);
    const outputs = new Set<string>();
    for (let seed = 0; seed < 20; seed++) {
      // Both axes. Motion seeds carry most of the variation, so measuring layout
      // alone understates what a real run produces.
      const { casting } = validateCasting(seq, brief.lookPackId, brief.energy, {
        layouts: seq.beats.map((b) => ({ beatIndex: b.index, templateId: '', seed: seed * 3 + b.index })),
        motion: seq.beats.map((b) => ({ beatIndex: b.index, techniqueId: '', params: {}, seed: seed * 5 + b.index })),
      });
      const { calls } = emitAndValidate({
        sequence: seq, casting, lookPackId: brief.lookPackId,
        width: FRAME.width, height: FRAME.height, fps: FRAME.fps,
      });
      outputs.add(JSON.stringify(calls));
    }
    expect(outputs.size).toBeGreaterThanOrEqual(12);
  });

  it('reports variant entropy so "always seed 0" is visible', async () => {
    const brief = briefFor('apple_keynote');
    const seq = sequence(brief);
    const allZero = emitAndValidate({
      sequence: seq,
      casting: {
        layouts: seq.beats.map((b) => ({ beatIndex: b.index, templateId: 'hero.centered_stack', seed: 0 })),
        motion: [],
      },
      lookPackId: brief.lookPackId, width: FRAME.width, height: FRAME.height, fps: FRAME.fps,
    });
    // Three beats, one distinct seed → entropy 1/3. The old compose-ratio metric
    // would have reported this as a perfect score.
    expect(allZero.report.metrics.variantEntropy).toBeLessThan(0.5);
  });
});

// ── Cost (criterion 4) ────────────────────────────────────────────────

describe('cost (criterion 4)', () => {
  it('makes at most 3 model calls per run', async () => {
    let calls = 0;
    const brief = briefFor('apple_keynote');
    const counted: CasterHooks = {
      brief: async (p, u) => { calls++; return weakHooks(brief).brief(p, u); },
      cast: async (prompts, kind) => { calls++; return weakHooks(brief).cast(prompts, kind); },
    };
    await runCaster({ userPrompt: 'x', hooks: counted, ...FRAME });
    // brief + cast(layout) + cast(motion) = 3. The optional fit critic makes 4,
    // which is the stated ceiling.
    expect(calls).toBeLessThanOrEqual(3);
  });

  it('batches the per-beat casts into ONE call each', async () => {
    // Not one call per beat. A five-beat piece must not become eleven calls.
    let castCalls = 0;
    let promptsSeen = 0;
    const brief = briefFor('saas_explainer');
    const counted: CasterHooks = {
      brief: async () => brief,
      cast: async (prompts, kind) => {
        castCalls++;
        promptsSeen += prompts.length;
        return weakHooks(brief).cast(prompts, kind);
      },
    };
    await runCaster({ userPrompt: 'x', hooks: counted, ...FRAME });
    expect(castCalls).toBe(2);
    expect(promptsSeen).toBe(6); // 3 beats × (layout + motion)
  });
});

// ── The prompts ───────────────────────────────────────────────────────

describe('what the model is shown', () => {
  it('the brief prompt never mentions keyframes, easing or timing', () => {
    // Asking a text model to author craft it cannot perceive is the failure the
    // whole re-architecture exists to fix. The prompt must not invite it.
    const p = briefPrompt(LOOK_PACKS).toLowerCase();
    for (const word of ['keyframe', 'bezier', 'easing', 'stagger', 'overshoot', 'milliseconds']) {
      expect(`${word} in brief prompt: ${p.includes(word)}`).toBe(`${word} in brief prompt: false`);
    }
  });

  it('the brief prompt states the continuity rule explicitly', () => {
    expect(briefPrompt(LOOK_PACKS)).toMatch(/share something/i);
  });

  it('caps the candidate list the caster sees', () => {
    // A model handed 250 options picks from the top of the list.
    const seq = sequence(briefFor('saas_explainer'));
    for (const p of layoutCastPrompts(seq, 'saas_explainer')) {
      expect(p.allowed.length).toBeLessThanOrEqual(12);
    }
    for (const p of motionCastPrompts(seq, 'saas_explainer', 0.5)) {
      expect(p.allowed.length).toBeLessThanOrEqual(25);
    }
  });

  it('only ever offers candidates the pack allows', () => {
    for (const pack of LOOK_PACKS) {
      const seq = sequence(briefFor(pack.id));
      for (const p of motionCastPrompts(seq, pack.id, 0.5)) {
        for (const id of p.allowed) expect(pack.forbid).not.toContain(id);
      }
    }
  });

  it('never offers an editorial technique for a product pack (criterion 6b)', () => {
    const editorialIds = new Set(TECHNIQUES.map((t) => t.id));
    for (const pack of LOOK_PACKS.filter((p) => p.vocabulary === 'product')) {
      const seq = sequence(briefFor(pack.id));
      for (const p of motionCastPrompts(seq, pack.id, 0.5)) {
        for (const id of p.allowed) {
          // An editorial id may only appear if it is genuinely vocabulary-neutral
          // (an exit, a dissolve) — never a kinetic-type or high-energy one.
          if (!editorialIds.has(id)) continue;
          const t = TECHNIQUES.find((x) => x.id === id)!;
          expect(`${pack.id} offered ${id} (${t.category})`).not.toMatch(/kinetic_type/);
          expect(t.energy[1]).toBeLessThan(0.9);
        }
      }
    }
  });
});

/**
 * The composition is ONE composition, not N stacked posters.
 *
 * Paint order is creation order, so a template that emits its own full-frame
 * backdrop inside a multi-beat piece covers every beat composed before it. That
 * failure is invisible in a per-template test — each template is correct alone —
 * and invisible in a linter that reads a flat layer list with no z-order. It is
 * only visible here, where several beats share a frame.
 */
describe('composition integrity', () => {
  const emitFor = (packId: string, energy = 0.5) => {
    const brief = briefFor(packId, energy);
    const seq = sequence(brief);
    const casting = validateCasting(seq, packId, energy, {
      layouts: layoutCastPrompts(seq, packId).map((p, i) => ({
        beatIndex: p.beatIndex, templateId: p.allowed[0]!, seed: i * 7 + 1,
      })),
      motion: motionCastPrompts(seq, packId, energy).map((p, i) => ({
        beatIndex: p.beatIndex, techniqueId: p.allowed[0]!, params: {}, seed: i * 11 + 3,
      })),
    }).casting;
    return { seq, ...emitAndValidate({ sequence: seq, casting, lookPackId: packId, ...FRAME }) };
  };

  it('emits exactly one backdrop and one surface treatment, whatever the beat count', () => {
    for (const pack of LOOK_PACKS) {
      const { calls, seq } = emitFor(pack.id);
      expect(seq.beats.length).toBeGreaterThan(1);
      expect(calls.filter((c) => c.name === 'create_gradient')).toHaveLength(1);
      expect(calls.filter((c) => c.name === 'add_surface_treatment')).toHaveLength(1);
    }
  });

  it('creates the backdrop before any beat content, so it sits behind it', () => {
    for (const pack of LOOK_PACKS) {
      const { calls } = emitFor(pack.id);
      const backdrop = calls.findIndex((c) => c.name === 'create_gradient');
      const firstContent = calls.findIndex((c) => c.name === 'create_layer');
      expect(backdrop).toBeGreaterThanOrEqual(0);
      expect(firstContent).toBeGreaterThan(backdrop);
    }
  });

  it('does not vary the backdrop angle only by pack — the seed moves it too', () => {
    const angles = new Set<number>();
    for (let seed = 0; seed < 8; seed++) {
      const brief = briefFor('apple_keynote');
      const seq = sequence(brief);
      const { calls } = emitAndValidate({
        sequence: seq,
        casting: {
          layouts: seq.beats.map((b) => ({ beatIndex: b.index, templateId: 'hero.centered_stack', seed })),
          motion: [],
        },
        lookPackId: 'apple_keynote',
        ...FRAME,
      });
      const g = calls.find((c) => c.name === 'create_gradient');
      angles.add(Number(g!.args.angle));
    }
    expect(angles.size).toBeGreaterThan(1);
  });
});

/**
 * Beat lifecycle.
 *
 * The renderer has no per-layer time range — visibility is `visible !== false`
 * and the only lever on "is this on screen now" is the opacity track. So a beat
 * whose content is never animated out stays in frame for the rest of the piece,
 * and a five-beat composition renders as a pile.
 */
describe('beat lifecycle', () => {
  const PACK = 'apple_keynote';

  /** Opacity tracks, keyed by layer, rebuilt from the emitted calls. */
  function opacityTracks(calls: readonly { name: string; args: Record<string, unknown> }[]) {
    const byId = new Map<string, { t: number; value: number }[]>();
    for (const c of calls) {
      if (c.name !== 'set_keyframes') continue;
      for (const raw of (c.args.keyframes as Record<string, unknown>[]) ?? []) {
        if (String(raw.prop) !== 'opacity') continue;
        const id = String(raw.nodeId);
        const keys = byId.get(id) ?? [];
        keys.push({ t: Number(raw.t) * 1000, value: Number(raw.value) });
        byId.set(id, keys);
      }
    }
    for (const keys of byId.values()) keys.sort((a, b) => a.t - b.t);
    return byId;
  }

  function emitFor(packId: string) {
    const brief = briefFor(packId);
    const seq = sequence(brief);
    const casting = validateCasting(seq, packId, brief.energy, {
      layouts: layoutCastPrompts(seq, packId).map((p, i) => ({
        beatIndex: p.beatIndex, templateId: p.allowed[0]!, seed: i * 7 + 1,
      })),
      motion: motionCastPrompts(seq, packId, brief.energy).map((p, i) => ({
        beatIndex: p.beatIndex, techniqueId: p.allowed[0]!, params: {}, seed: i * 11 + 3,
      })),
    }).casting;
    const { calls } = emitAndValidate({ sequence: seq, casting, lookPackId: packId, ...FRAME });
    return { seq, calls, tracks: opacityTracks(calls), casting };
  }

  it('animates every non-final beat OUT, so content does not accumulate', () => {
    const { seq, calls, tracks } = emitFor(PACK);
    // Which layers belong to which beat: the emitter prefixes them `b{index}_`.
    for (const beat of seq.beats.slice(0, -1)) {
      const ids = calls
        .filter((c) => c.name === 'create_layer' && String(c.args.id ?? '').startsWith(`b${beat.index}_`))
        .map((c) => String(c.args.id));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const keys = tracks.get(id);
        expect(keys).toBeDefined();
        // Ends hidden…
        expect(keys![keys!.length - 1]!.value).toBeLessThanOrEqual(1);
        // …and is hidden by the time the NEXT beat is properly under way.
        const nextEnd = seq.beats[beat.index + 1]!.startMs + seq.beats[beat.index + 1]!.durationMs;
        expect(keys![keys!.length - 1]!.t).toBeLessThan(nextEnd);
      }
    }
  });

  it('holds the FINAL beat to the end — a piece must not end on an empty frame', () => {
    const { seq, calls, tracks } = emitFor(PACK);
    const last = seq.beats[seq.beats.length - 1]!;
    const ids = calls
      .filter((c) => c.name === 'create_layer' && String(c.args.id ?? '').startsWith(`b${last.index}_`))
      .map((c) => String(c.args.id));
    expect(ids.length).toBeGreaterThan(0);
    // At least one element is still visible at the final frame.
    const visible = ids.filter((id) => {
      const keys = tracks.get(id);
      return !keys || keys[keys.length - 1]!.value > 1;
    });
    expect(visible.length).toBeGreaterThan(0);
  });

  it('lets the SURVIVING role cross the boundary and cuts everything else before it', () => {
    // This is the only place `survival` changes the output. Until the lifecycle
    // pass existed the sequencer computed a survivor, validated that one was
    // present, and nothing ever read it.
    const { seq, calls, tracks, casting } = emitFor(PACK);
    const beat = seq.beats[0]!;
    const boundary = beat.startMs + beat.durationMs;
    const survivingRole = beat.survival?.role;
    expect(survivingRole).toBeDefined();

    // Layer ids carry their role in the id: `b0_headline_0`, `b0_cta`, …
    const ids = calls
      .filter((c) => c.name === 'create_layer' && String(c.args.id ?? '').startsWith('b0_'))
      .map((c) => String(c.args.id));
    const survivors = ids.filter((id) => id.startsWith(`b0_${survivingRole}`));
    const others = ids.filter((id) => !id.startsWith(`b0_${survivingRole}`) && tracks.has(id));
    expect(survivors.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);

    for (const id of survivors) {
      const keys = tracks.get(id)!;
      expect(keys[keys.length - 1]!.t).toBeGreaterThan(boundary);
    }
    for (const id of others) {
      const keys = tracks.get(id)!;
      expect(keys[keys.length - 1]!.t).toBeLessThanOrEqual(boundary + 1);
    }
    expect(casting.layouts).toHaveLength(seq.beats.length);
  });

  it('never fades a layer past a value the template set deliberately', () => {
    // `emitMedia` places its placeholder at 82. An entrance that ramps to 100
    // would silently overrule a design decision with a default.
    for (const pack of LOOK_PACKS) {
      const { calls, tracks } = emitFor(pack.id);
      const capped = new Map<string, number>();
      for (const c of calls) {
        if (c.name !== 'update_layer' || c.args.opacity === undefined) continue;
        capped.set(String(c.args.nodeId), Number(c.args.opacity));
      }
      for (const [id, cap] of capped) {
        for (const k of tracks.get(id) ?? []) expect(k.value).toBeLessThanOrEqual(cap);
      }
    }
  });
});

/**
 * Art-directed imagery.
 *
 * The design linter has always carried a `PRIMITIVE_ONLY` rule whose message is
 * the plainest statement of the ceiling in the whole codebase: "it is entirely
 * rectangles and text. That is the ceiling on how designed it can look." It
 * fired on 100% of output and no template could satisfy it, because nothing in
 * the pipeline could produce a picture.
 */
describe('art-directed imagery', () => {
  const PACK = 'swiss_editorial';

  function emitWithArt(art: string | undefined, packId = PACK) {
    const base = briefFor(packId);
    const brief: CreativeBrief = {
      ...base,
      beats: base.beats.map((b, i) => (i === 0 && art ? { ...b, art } : b)),
    };
    const seq = sequence(brief);
    const casting = validateCasting(seq, packId, brief.energy, {
      layouts: layoutCastPrompts(seq, packId).map((p) => ({
        // Prefer a media layout where one is offered, so the rewrite is exercised.
        beatIndex: p.beatIndex,
        templateId: p.allowed.find((a) => /media|split|scrim|gallery/.test(a)) ?? p.allowed[0]!,
        seed: 1,
      })),
      motion: motionCastPrompts(seq, packId, brief.energy).map((p) => ({
        beatIndex: p.beatIndex, techniqueId: p.allowed[0]!, params: {}, seed: 3,
      })),
    }).casting;
    return { seq, ...emitAndValidate({ sequence: seq, casting, lookPackId: packId, ...FRAME }) };
  }

  it('makes media layouts castable for a beat that asked for a picture', () => {
    const withArt = sequence({
      ...briefFor(PACK),
      beats: [{ purpose: 'open', weight: 1, content: { headline: 'One' }, art: 'a lone figure on a salt flat at dawn' }],
    });
    expect(withArt.beats[0]!.content.mediaAssetId).toBeDefined();
    // …and a beat with no art direction stays free of the sentinel, so it is
    // never offered a layout it cannot fill.
    const without = sequence({
      ...briefFor(PACK),
      beats: [{ purpose: 'open', weight: 1, content: { headline: 'One' } }],
    });
    expect(without.beats[0]!.content.mediaAssetId).toBeUndefined();
  });

  it('emits generate_image instead of create_media, keeping the template layer id', () => {
    const { calls } = emitWithArt('a lone figure on a salt flat at dawn');
    const gen = calls.filter((c) => c.name === 'generate_image');
    expect(gen.length).toBeGreaterThan(0);
    // The sentinel must never reach the engine.
    expect(calls.some((c) => c.name === 'create_media' && c.args.assetId === GENERATED_MEDIA)).toBe(false);

    for (const g of gen) {
      const id = String(g.args.id);
      // The layer id is the template's own, so the sizing call still lands.
      expect(calls.some((c) => c.name === 'update_layer' && c.args.nodeId === id)).toBe(true);
      expect(String(g.args.prompt)).toContain('salt flat');
      expect(['square', 'landscape', 'portrait']).toContain(String(g.args.aspect));
    }
  });

  it('appends the pack\'s own art direction, so imagery belongs to the piece', () => {
    const { calls } = emitWithArt('a lone figure on a salt flat at dawn');
    const g = calls.find((c) => c.name === 'generate_image')!;
    const prompt = String(g.args.prompt);
    // The pack decides palette and surface for everything else in the frame; an
    // image generated without them is the one element that does not match.
    expect(prompt).toContain('#');
    expect(prompt).toMatch(/no lettering|no logo|no watermark/);
  });

  it('clears PRIMITIVE_ONLY when a picture is present, and reports it when not', () => {
    const withArt = emitWithArt('a lone figure on a salt flat at dawn');
    const without = emitWithArt(undefined);
    const has = (r: { findings: readonly { rule: string }[] }) =>
      r.findings.some((f) => f.rule === 'PRIMITIVE_ONLY');
    expect(has(without.report)).toBe(true);
    expect(has(withArt.report)).toBe(false);
  });

  it('never generates over imagery the user actually supplied', () => {
    const base = briefFor(PACK);
    const brief: CreativeBrief = {
      ...base,
      beats: base.beats.map((b, i) =>
        i === 0 ? { ...b, art: 'something else entirely', content: { ...b.content, mediaAssetId: 'asset_42' } } : b,
      ),
    };
    const seq = sequence(brief);
    expect(seq.beats[0]!.content.mediaAssetId).toBe('asset_42');
  });

  it('does not claim transform_into between two DIFFERENT generated pictures', () => {
    // The strongest survival in the vocabulary exists because the viewer tracks
    // one object across the cut. Two beats that each asked for a picture asked
    // for two different pictures.
    const seq = sequence({
      ...briefFor(PACK),
      beats: [
        { purpose: 'a', weight: 1, content: { headline: 'One' }, art: 'a salt flat at dawn' },
        { purpose: 'b', weight: 1, content: { quote: 'Q' }, art: 'a city street at night' },
      ],
    });
    expect(seq.beats[0]!.survival?.kind).not.toBe('transform_into');
  });
});

describe('the image budget', () => {
  it('caps generated images per composition however many beats ask for one', () => {
    const base = briefFor('swiss_editorial');
    const brief: CreativeBrief = {
      ...base,
      beats: base.beats.map((b) => ({ ...b, art: 'a lone figure on a salt flat at dawn' })),
    };
    const seq = sequence(brief);
    expect(seq.beats.every((b) => b.art)).toBe(true);

    const casting = validateCasting(seq, 'swiss_editorial', brief.energy, {
      layouts: layoutCastPrompts(seq, 'swiss_editorial').map((p) => ({
        beatIndex: p.beatIndex,
        templateId: p.allowed.find((a) => /media|split|scrim/.test(a)) ?? p.allowed[0]!,
        seed: 1,
      })),
      motion: [],
    }).casting;
    const { calls } = emitAndValidate({ sequence: seq, casting, lookPackId: 'swiss_editorial', ...FRAME });

    expect(calls.filter((c) => c.name === 'generate_image').length).toBeLessThanOrEqual(2);
    // Beats over budget must not emit a create_media for an asset that does not
    // exist — they fall back to the deliberate placeholder panel.
    expect(calls.some((c) => c.name === 'create_media' && c.args.assetId === GENERATED_MEDIA)).toBe(false);
  });
});

/**
 * Graphic devices.
 *
 * Before these existed the whole forty-template library emitted six kinds of
 * tool call and every shape it ever made was `shape: 'rect'`. The engine has had
 * star, polygon, line and ellipse primitives, a repeater, trim paths and inline
 * SVG the entire time.
 */
describe('graphic devices', () => {
  function emitFor(packId: string, seed = 1) {
    const brief = briefFor(packId);
    const seq = sequence(brief);
    const casting = validateCasting(seq, packId, brief.energy, {
      layouts: layoutCastPrompts(seq, packId).map((p) => ({
        beatIndex: p.beatIndex, templateId: p.allowed[0]!, seed,
      })),
      motion: [],
    }).casting;
    return emitAndValidate({ sequence: seq, casting, lookPackId: packId, ...FRAME });
  }

  it('puts something that is not a rectangle into every editorial composition', () => {
    for (const pack of LOOK_PACKS.filter((p) => p.vocabulary === 'editorial')) {
      const { calls } = emitFor(pack.id);
      const nonRect = calls.filter(
        (c) =>
          (c.name === 'create_layer' && c.args.shape !== undefined && c.args.shape !== 'rect') ||
          c.name === 'import_svg' ||
          c.name === 'add_repeater' ||
          c.name === 'set_trim_path',
      );
      expect(`${pack.id}: ${nonRect.length}`).not.toBe(`${pack.id}: 0`);
    }
  });

  it('gives the PRODUCT packs no device — a dashboard has no halftone behind it', () => {
    for (const pack of LOOK_PACKS.filter((p) => p.vocabulary === 'product')) {
      const { calls } = emitFor(pack.id);
      const deviceCalls = calls.filter((c) => String(c.args.id ?? c.args.nodeId ?? '').startsWith('comp_') &&
        c.name !== 'create_gradient' && c.name !== 'add_surface_treatment' && c.name !== 'set_motion_blur');
      expect(`${pack.id}: ${deviceCalls.length}`).toBe(`${pack.id}: 0`);
    }
  });

  it('keeps devices ambient — nothing a device draws competes with the content', () => {
    for (const pack of LOOK_PACKS.filter((p) => p.vocabulary === 'editorial')) {
      const { calls } = emitFor(pack.id);
      const deviceOpacities = calls
        .filter((c) => c.name === 'update_layer' && String(c.args.nodeId ?? '').startsWith('comp_'))
        .map((c) => Number(c.args.opacity ?? 100));
      expect(deviceOpacities.length).toBeGreaterThan(0);
      for (const o of deviceOpacities) expect(o).toBeLessThanOrEqual(30);
    }
  });

  it('places devices ON the grid — "nearly aligned" is the amateur signal', () => {
    // OFF_GRID is an error, so this is really a guard against a future device
    // choosing an arbitrary x/y and only failing on some frame sizes.
    for (const pack of LOOK_PACKS) {
      const { report } = emitFor(pack.id);
      const offGrid = report.findings.filter((f) => f.rule === 'OFF_GRID');
      expect(`${pack.id}: ${offGrid.length}`).toBe(`${pack.id}: 0`);
    }
  });

  it('does not let a decorative crop mark answer PRIMITIVE_ONLY', () => {
    // The registration-mark device is an `import_svg`, and therefore an asset by
    // the letter of `isAsset`. If it satisfied PRIMITIVE_ONLY, a rule about
    // whether the frame contains real imagery would be answered by a 64px mark
    // in a corner — retiring the rule without changing a single frame.
    const swiss = emitFor('swiss_editorial');
    const hasSvg = swiss.calls.some((c) => c.name === 'import_svg');
    if (hasSvg) {
      expect(swiss.report.findings.some((f) => f.rule === 'PRIMITIVE_ONLY')).toBe(true);
    }
  });

  it('varies the device with the seed rather than pinning one per pack', () => {
    const ids = new Set<string>();
    for (let seed = 0; seed < 8; seed++) {
      const { calls } = emitFor('swiss_editorial', seed);
      const names = calls
        .filter((c) => String(c.args.id ?? '').startsWith('comp_') && c.name !== 'create_gradient')
        .map((c) => String(c.args.name ?? ''));
      ids.add(names.join('|'));
    }
    expect(ids.size).toBeGreaterThan(1);
  });
});

/**
 * Template breadth.
 *
 * Measured before this was addressed: `mobile_app` could use THREE templates in
 * total and `saas_product` six, against eleven to thirty for every editorial
 * pack. A pack with three layouts has no structural choice to make — the
 * caster's whole job at that stage is picking a structure, and with three
 * options it is decided before the model is asked.
 */
describe('template breadth', () => {
  const RICH_CONTENT = {
    overline: 'Introducing',
    headline: 'Ship the thing you actually meant to ship',
    subhead: 'One pipeline, from the first commit to the last deploy.',
    support: 'No card required.',
    cta: 'Start free',
    quote: 'It changed how the team works.',
    attribution: 'Someone',
    items: [
      { value: '4.2x', label: 'Faster', title: 'Faster builds', body: 'Incremental everywhere.' },
      { value: '99.99%', label: 'Uptime', title: 'Always on', body: 'Multi-region by default.' },
      { value: '12k', label: 'Teams', title: 'Proven', body: 'Startups to public companies.' },
    ],
  };

  it('gives every pack a real structural choice', () => {
    for (const pack of LOOK_PACKS) {
      const allowed = templatesForPack(pack).length;
      expect(`${pack.id}: ${allowed >= 8}`).toBe(`${pack.id}: true`);
    }
  });

  it('offers every pack enough candidates that the pick is a decision', () => {
    for (const pack of LOOK_PACKS) {
      const offered = candidates({ packId: pack.id, content: RICH_CONTENT }).length;
      expect(`${pack.id}: ${offered >= 6}`).toBe(`${pack.id}: true`);
    }
  });

  it('keeps every layoutPrefer entry pointing at a template that exists', () => {
    // A prefer list naming a template that was never written is how both product
    // packs ended up with techniques and nowhere to put them.
    const ids = new Set(layoutTemplateIds());
    for (const pack of LOOK_PACKS) {
      for (const id of pack.layoutPrefer) {
        expect(`${pack.id} -> ${id}: ${ids.has(id)}`).toBe(`${pack.id} -> ${id}: true`);
      }
    }
  });

  it('keeps every template reachable from at least one pack', () => {
    const reachable = new Set(LOOK_PACKS.flatMap((p) => templatesForPack(p).map((t) => t.id)));
    for (const id of layoutTemplateIds()) {
      expect(`${id}: ${reachable.has(id)}`).toBe(`${id}: true`);
    }
  });
});

/**
 * Direction and variants.
 *
 * The caster has always accepted a pack, an accent, an energy and a duration,
 * and nothing in the product could supply any of them — so every run guessed
 * four things the person typing may already have decided.
 */
describe('direction and variants', () => {
  const hooks = (brief: CreativeBrief): CasterHooks => weakHooks(brief);

  it('lets the user override the pack the model picked', async () => {
    const brief = briefFor('broadcast_sports');
    const r = await runCaster({
      userPrompt: 'x', hooks: hooks(brief), ...FRAME,
      direction: { lookPackId: 'luxury_film' },
    });
    expect(r.brief.lookPackId).toBe('luxury_film');
    expect(r.report.lookPackId).toBe('luxury_film');
  });

  it('applies the override BEFORE casting, so candidates come from the right pack', async () => {
    // Overriding after the sequencer would leave the cast prompts describing a
    // pack the piece is not in, and every template would then be substituted.
    const brief = briefFor('broadcast_sports');
    const r = await runCaster({
      userPrompt: 'x', hooks: hooks(brief), ...FRAME,
      direction: { lookPackId: 'luxury_film' },
    });
    for (const t of r.report.templates) {
      expect(`${t}: ${templatesForPack(LOOK_PACKS.find((p) => p.id === 'luxury_film')!).some((x) => x.id === t)}`)
        .toBe(`${t}: true`);
    }
  });

  it('carries accent, energy and duration through', async () => {
    const brief = briefFor('apple_keynote');
    const r = await runCaster({
      userPrompt: 'x', hooks: hooks(brief), ...FRAME,
      direction: { accent: '#ff0055', energy: 0.9, totalDurationMs: 6000 },
    });
    expect(r.brief.accent).toBe('#ff0055');
    expect(r.brief.energy).toBe(0.9);
    expect(r.brief.totalDurationMs).toBe(6000);
  });

  it('produces one variant by default, and it is the validated casting', async () => {
    const brief = briefFor('apple_keynote');
    const r = await runCaster({ userPrompt: 'x', hooks: hooks(brief), ...FRAME });
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]!.calls).toBe(r.calls);
  });

  it('produces N genuinely different variants, all of them lint-clean', async () => {
    const brief = briefFor('swiss_editorial');
    const r = await runCaster({ userPrompt: 'x', hooks: hooks(brief), ...FRAME, variants: 4 });
    expect(r.variants).toHaveLength(4);

    // Different, not just re-labelled: the seeds drive real variant selection
    // inside the templates and techniques.
    const shapes = new Set(r.variants.map((v) => JSON.stringify(v.calls)));
    expect(shapes.size).toBeGreaterThan(1);

    // Every alternative is held to the same bar as the single-result path —
    // offering a choice between one good piece and three broken ones is worse
    // than not offering a choice.
    for (const v of r.variants) {
      const errors = v.report.findings.filter((f) => f.severity === 'error');
      expect(`variant ${v.index}: ${errors.map((e) => e.rule).join(',')}`).toBe(`variant ${v.index}: `);
    }
  });

  it('returns the variants best-first and applies the best', async () => {
    const brief = briefFor('saas_explainer');
    const r = await runCaster({ userPrompt: 'x', hooks: hooks(brief), ...FRAME, variants: 3 });
    const score = (v: (typeof r.variants)[number]) =>
      v.report.designScore + v.report.craftScore + v.report.uiMotionScore;
    for (let i = 1; i < r.variants.length; i++) {
      expect(score(r.variants[i - 1]!)).toBeGreaterThanOrEqual(score(r.variants[i]!));
    }
    expect(r.calls).toBe(r.variants[0]!.calls);
  });
});

/**
 * Reachability.
 *
 * A technique can be registered, linted, craft-floor-verified and completely
 * unreachable. `camera.crash_zoom` declared `roles: ['camera']`, no layout ever
 * produces a `camera` slot, and the candidate filter is
 * `t.roles.some(r => availableRoles.has(r))` — so it was dropped on 100% of
 * beats and had never once been cast.
 */
describe('technique reachability', () => {
  /** Every role a beat can ever offer, across all content shapes. */
  const EVERY_OFFERABLE_ROLE = new Set<string>([
    ...availableRolesFor({
      index: 0, startMs: 0, durationMs: 5000, purpose: 'x', tags: [],
      content: {
        headline: 'h', subhead: 's', support: 'sp', overline: 'o', quote: 'q', cta: 'c',
        mediaAssetId: 'a', items: [{ value: '1', label: 'l', title: 't', body: 'b' }],
      },
    } as never),
  ]);

  it('every technique declares at least one role a beat can actually offer', () => {
    const unreachable = [...TECHNIQUES, ...PRODUCT_TECHNIQUES]
      .filter((t) => !t.roles.some((r) => EVERY_OFFERABLE_ROLE.has(r)))
      .map((t) => `${t.id} (roles: ${t.roles.join(', ')})`);
    expect(unreachable).toEqual([]);
  });

  it('every technique is offered for at least one pack and beat', () => {
    // The stronger end-to-end form: walk every pack over rich content and check
    // each technique surfaces somewhere. Catches role lists that are technically
    // satisfiable but excluded by every pack's forbid rules.
    const offered = new Set<string>();
    for (const pack of LOOK_PACKS) {
      const seq = sequence(briefFor(pack.id));
      for (const energy of [0.2, 0.5, 0.85]) {
        for (const p of motionCastPrompts(seq, pack.id, energy)) {
          for (const id of p.allowed) offered.add(id);
        }
      }
    }
    const never = [...TECHNIQUES, ...PRODUCT_TECHNIQUES]
      .map((t) => t.id)
      .filter((id) => !offered.has(id));
    /**
     * The exemption used to be "assert cameras, merely report the rest", and
     * that blind spot swallowed something large: EVERY product technique sat in
     * `never`, because `motionCastPrompts` searched only the editorial registry
     * and no product pack was ever offered one. Thirty-odd entries, computed
     * right here, printed nowhere, looked at by nobody. A sweep with an
     * exemption is a sweep with a blind spot — the same lesson
     * `templates.test.ts` records about skipping the product packs.
     *
     * So the exemption is BOUNDED rather than open. A technique can still
     * legitimately need content this fixture does not produce, but the number
     * that do is pinned and the list is in the failure message, so anything
     * that pushes it up has to be looked at rather than absorbed.
     */
    const cameraNever = never.filter((id) => id.startsWith('camera.'));
    expect(cameraNever).toEqual([]);
    // Product techniques must ALSO be reachable now the pool is
    // vocabulary-scoped. This is the assertion whose absence hid the gap.
    const productOffered = PRODUCT_TECHNIQUES.filter((t) => offered.has(t.id)).length;
    expect(`${productOffered}/${PRODUCT_TECHNIQUES.length} product offered`).toBe(
      `${Math.max(productOffered, Math.ceil(PRODUCT_TECHNIQUES.length * 0.7))}/${PRODUCT_TECHNIQUES.length} product offered`,
    );
    expect(`unreachable: ${never.length} — ${never.join(', ')}`).toBe(
      `unreachable: ${Math.min(never.length, 15)} — ${never.join(', ')}`,
    );
  });
});
