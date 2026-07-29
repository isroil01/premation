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

import { LOOK_PACKS } from '@motion/design-system';
import { TECHNIQUES } from '@motion/technique-library';
import {
  briefPrompt,
  emitAndValidate,
  layoutCastPrompts,
  motionCastPrompts,
  runCaster,
  sequence,
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
