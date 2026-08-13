/**
 * PHASE A INSTRUMENTATION — measure the camera before changing it.
 *
 * Three questions, answered from the emitted `ToolCall[]` rather than from
 * reading the technique source and reasoning about what it probably does:
 *
 *  A.1 — when a camera technique is cast on a beat, how many of that beat's
 *        layers actually end up at distinct depths? A dolly across coplanar
 *        layers is a uniform scale and reads as a zoom, not a camera.
 *  A.2 — does anything create a camera-kind layer ahead of the cast one? The
 *        renderer picks ONE camera per composition, so a second creation site is
 *        a silent collision.
 *  A.3 — how often can the model even choose a camera? Log the candidate count
 *        per beat across every pack at three energies.
 *
 * Written as a test so the numbers are reproducible and so the same file becomes
 * the A.5 regression guard once the fix lands. Set `PHASE_A_VERBOSE=1` to print
 * the distributions.
 */

import { MIN_PARALLAX_SPREAD_PX, TECHNIQUES, candidates as motionCandidates, technique } from '@motion/technique-library';
import { LOOK_PACKS, candidates as layoutCandidates, lookPack } from '@motion/design-system';
import { emitAndValidate, sequence, availableRolesFor } from './index';
import type { Casting, CreativeBrief } from './types';

const FRAME = { width: 1920, height: 1080, fps: 30 };
const VERBOSE = process.env.PHASE_A_VERBOSE === '1';
const log = (...a: unknown[]): void => {

  if (VERBOSE) console.log(...a);
};

/** A beat set with the roles a real editorial piece carries. */
const CONTENT = {
  overline: 'Introducing',
  headline: 'Ship the thing you actually meant to ship',
  subhead: 'One pipeline, from the first commit to the last deploy.',
  support: 'No card required.',
  cta: 'Start free',
};

function briefFor(packId: string, energy: number): CreativeBrief {
  return {
    lookPackId: packId,
    energy,
    tone: 'confident, unhurried, technical',
    totalDurationMs: 12000,
    beats: [
      { purpose: 'open on the promise', weight: 1.2, content: CONTENT },
      { purpose: 'proof — the numbers', weight: 1, content: { ...CONTENT, headline: CONTENT.headline } },
      { purpose: 'close on the CTA', weight: 0.8, content: CONTENT },
    ],
  };
}

/** Every layer id the emitted calls create, and the z the calls give it. */
interface DepthReading {
  /** id → the z value(s) the calls assign. Empty array = never given a z. */
  zById: Map<string, number[]>;
  /** ids that got `threeD: true`. A z on a 2D layer is inert. */
  threeD: Set<string>;
  /** ids created as a camera-kind layer, in creation order. */
  cameraIds: string[];
  /** Every created layer id, in creation order. */
  allIds: string[];
}

function readDepths(calls: readonly { name: string; args: Record<string, unknown> }[]): DepthReading {
  const zById = new Map<string, number[]>();
  const threeD = new Set<string>();
  const cameraIds: string[] = [];
  const allIds: string[] = [];

  for (const c of calls) {
    const a = c.args;
    if (c.name === 'create_layer') {
      const id = String(a.id ?? '');
      if (!id) continue;
      allIds.push(id);
      if (!zById.has(id)) zById.set(id, []);
      if (a.kind === 'camera') cameraIds.push(id);
    }
    if (c.name === 'update_layer' && a.threeD === true) threeD.add(String(a.nodeId ?? ''));
    // `emitDepth` writes z as a STATIC prop (`update_layer { threeD, z }`) while
    // the camera techniques write an animated TRACK. Two mechanisms for one
    // quantity, and a reader that knew about only one reported the other as
    // "no depth" — which is the same false negative as the keyframe-shape bug
    // above, in the opposite direction.
    if (c.name === 'update_layer' && typeof a.z === 'number') {
      const id = String(a.nodeId ?? '');
      if (id) zById.set(id, [...(zById.get(id) ?? []), a.z]);
    }
    if (c.name === 'set_keyframes') {
      // `track()` puts nodeId and prop on EACH KEYFRAME, not on the call —
      // `mk('set_keyframes', { keyframes: [{ nodeId, prop, t, value, … }] })`.
      // A reader that looked for `args.nodeId` / `args.property` found neither
      // and reported every layer unstaged, which is a false negative that looks
      // exactly like the defect being hunted. Checked against `emit.ts:138`.
      const kfs = Array.isArray(a.keyframes) ? (a.keyframes as Record<string, unknown>[]) : [];
      for (const k of kfs) {
        if (k.prop !== 'z') continue;
        const id = String(k.nodeId ?? '');
        const v = Number(k.value ?? 0);
        if (!id || !Number.isFinite(v)) continue;
        zById.set(id, [...(zById.get(id) ?? []), v]);
      }
    }
  }
  return { zById, threeD, cameraIds, allIds };
}

/** Spread of the z values across a beat's CONTENT layers (the camera excluded). */
function depthSpread(d: DepthReading): { spread: number; staged: number; unstaged: string[] } {
  const contentIds = d.allIds.filter((id) => !d.cameraIds.includes(id));
  const depths: number[] = [];
  const unstaged: string[] = [];
  for (const id of contentIds) {
    const zs = d.zById.get(id) ?? [];
    if (!zs.length) unstaged.push(id);
    else depths.push(zs[0]!);
  }
  const spread = depths.length ? Math.max(...depths) - Math.min(...depths) : 0;
  return { spread, staged: depths.length, unstaged };
}

/**
 * Depth spread WITHIN one beat — the number that decides whether a camera move
 * reads as a camera.
 *
 * Composition-wide spread is the wrong measure and flattered the result badly:
 * a camera cast on beat 0 still sees beats 1 and 2 staged by `emitDepth` (which
 * is only suppressed on the beat that HAS the camera), so the whole-composition
 * figure came out at 378 while the beat actually on screen during the move was
 * completely flat. Parallax is a property of what is visible at the moment the
 * camera moves.
 *
 * A layer with no z is at z = 0 as far as the projection is concerned, so it
 * counts as a real plane rather than being skipped.
 */
function beatSpread(d: DepthReading, beatIndex: number): { spread: number; layers: number } {
  const prefix = `b${beatIndex}_`;
  const ids = d.allIds.filter((id) => id.startsWith(prefix) && !d.cameraIds.includes(id));
  if (!ids.length) return { spread: 0, layers: 0 };
  const depths = ids.map((id) => d.zById.get(id)?.[0] ?? 0);
  return { spread: Math.max(...depths) - Math.min(...depths), layers: ids.length };
}

/** Cast `techniqueId` on every beat that will take it; first valid layout each. */
function castWith(brief: CreativeBrief, techniqueId: string): Casting {
  const seq = sequence(brief);
  return {
    layouts: seq.beats.map((b) => ({ beatIndex: b.index, templateId: firstLayout(brief.lookPackId, b), seed: b.index * 7 + 1 })),
    motion: [{ beatIndex: 0, techniqueId, params: {}, seed: 3 }],
  };
}

function firstLayout(packId: string, beat: ReturnType<typeof sequence>['beats'][number]): string {
  const list = layoutCandidates({ packId, content: beat.content, tags: beat.tags });
  return list[0]?.template.id ?? '';
}

/**
 * Every camera technique, read from the registry rather than listed.
 *
 * A hand-written list is how the eight new ones would have been added without
 * ever being measured — the same shape of bug as the backend's hardcoded tool
 * catalogue drifting away from the editor's live registry.
 */
const CAMERA_IDS = TECHNIQUES.filter((t) => t.category === 'camera').map((t) => t.id);

describe('A.1 — does a camera beat actually have depth', () => {
  it.each(CAMERA_IDS)('%s stages its beat in z', (id) => {
    const def = technique(id);
    expect(def).toBeDefined();

    const brief = briefFor('apple_keynote', 0.3);
    const seq = sequence(brief);
    const { calls } = emitAndValidate({
      sequence: seq,
      casting: castWith(brief, id),
      lookPackId: brief.lookPackId,
      ...FRAME,
    });

    const d = readDepths(calls);
    const { spread, staged, unstaged } = depthSpread(d);

    log(
      `\n[A.1] ${id}\n` +
        `      cameras created: ${d.cameraIds.length} (${d.cameraIds.join(', ') || 'none'})\n` +
        `      content layers:  ${d.allIds.length - d.cameraIds.length}\n` +
        `      staged in z:     ${staged}\n` +
        `      UNSTAGED (z=0):  ${unstaged.length} → ${unstaged.slice(0, 8).join(', ')}\n` +
        `      z spread:        ${spread}\n` +
        `      threeD flags:    ${d.threeD.size}`,
    );

    const b0 = beatSpread(d, 0);
    const b1 = beatSpread(d, 1);
    const b2 = beatSpread(d, 2);
    log(
      `      BEAT 0 (has the camera): ${b0.layers} layers, spread ${b0.spread}\n` +
        `      beat 1 (no camera):      ${b1.layers} layers, spread ${b1.spread}\n` +
        `      beat 2 (no camera):      ${b2.layers} layers, spread ${b2.spread}\n` +
        `      z by layer:      ` +
        ([...d.zById.entries()]
          .filter(([, zs]) => zs.length)
          .map(([lid, zs]) => `${lid}=${zs[0]!.toFixed(0)}`)
          .join(', ') || '(none)'),
    );

    // The measurement, not yet the assertion: recorded so the fix has a number
    // to move. See the Phase A report for the values this produced.
    expect(spread).toBeGreaterThanOrEqual(0);
  });

  it('measures the counterfactual — the same beat with NO camera cast', () => {
    // `emitDepth` stages a beat back-to-front and is skipped whenever a camera
    // technique is present (`cameraOwnsDepth` in emit.ts). This is the number
    // the camera path is giving up: what depth staging looks like when the pass
    // that does it is allowed to run.
    const brief = briefFor('apple_keynote', 0.3);
    const seq = sequence(brief);
    const casting = castWith(brief, 'camera.push_in_slow');
    const { calls } = emitAndValidate({
      sequence: seq,
      // Same layouts, but an ENTRANCE instead of a camera, so emitDepth runs.
      casting: { layouts: casting.layouts, motion: [{ beatIndex: 0, techniqueId: 'entrance.rise_settle', params: {}, seed: 3 }] },
      lookPackId: brief.lookPackId,
      ...FRAME,
    });
    const d = readDepths(calls);
    const staged = [...d.zById.entries()].filter(([, zs]) => zs.length);
    log(
      `\n[A.1 counterfactual — no camera] staged=${staged.length}\n      ` +
        staged.map(([lid, zs]) => `${lid}=${zs[0]!.toFixed(0)}`).join(', '),
    );
    expect(staged.length).toBeGreaterThanOrEqual(0);
  });

  it('reports how many of beat 0 layers a camera technique leaves flat', () => {
    const brief = briefFor('apple_keynote', 0.3);
    const seq = sequence(brief);
    const { calls } = emitAndValidate({
      sequence: seq,
      casting: castWith(brief, 'camera.push_in_slow'),
      lookPackId: brief.lookPackId,
      ...FRAME,
    });
    const d = readDepths(calls);
    const { unstaged, staged } = depthSpread(d);
    log(`\n[A.1 summary] staged=${staged} unstaged=${unstaged.length}`);
    expect(staged + unstaged.length).toBeGreaterThan(0);
  });
});

describe('A.5 — CAMERA_WITHOUT_PARALLAX over the full corpus', () => {
  it('never fires: every pack that permits a camera stages the beat it lands on', () => {
    const offenders: string[] = [];
    for (const packDef of LOOK_PACKS) {
      for (const energy of [0.2, 0.5, 0.85]) {
        for (const id of CAMERA_IDS) {
          const brief = briefFor(packDef.id, energy);
          const seq = sequence(brief);
          const { report } = emitAndValidate({
            sequence: seq,
            casting: castWith(brief, id),
            lookPackId: packDef.id,
            ...FRAME,
          });
          for (const f of report.findings) {
            if (f.rule === 'CAMERA_WITHOUT_PARALLAX') {
              offenders.push(`${packDef.id} e=${energy} ${id}: ${f.message}`);
            }
          }
        }
      }
    }
    log(`\n[A.5] CAMERA_WITHOUT_PARALLAX findings across the corpus: ${offenders.length}`);
    for (const o of offenders) log(`      ${o}`);
    expect(offenders).toEqual([]);
  });

  it('every camera beat clears the parallax floor with real margin', () => {
    // Not just "not flat" — the number the rule needs is 120px, and a beat that
    // scrapes past it is one template change away from failing. `emitDepth`
    // gives 378 on a 1080 frame, so anything much below that says the staging
    // pass did not run.
    for (const id of CAMERA_IDS) {
      const brief = briefFor('apple_keynote', 0.3);
      const seq = sequence(brief);
      const { calls } = emitAndValidate({
        sequence: seq,
        casting: castWith(brief, id),
        lookPackId: brief.lookPackId,
        ...FRAME,
      });
      const b0 = beatSpread(readDepths(calls), 0);
      // Twice the rule's own floor, read from the rule rather than restated, so
      // the guard and the constant it guards cannot drift apart.
      expect(b0.spread).toBeGreaterThanOrEqual(MIN_PARALLAX_SPREAD_PX * 2);
    }
  });
});

describe('A.3b — offered is not the same as chosen: where do cameras RANK', () => {
  /**
   * The eviction fix put a camera in the list. This asks the next question.
   *
   * Weak cast takes `list[0]` — a floor, not a typical result — and under it 6 of
   * 24 corpus runs cast a camera. If cameras are present but sitting at rank 12,
   * a real model reading a ranked list will rarely reach one, and that is a
   * RANKING problem, not an eviction problem, with a different fix.
   *
   * There is no live provider key here, so "what a real model picks" cannot be
   * measured. What CAN be measured exactly is the thing that determines it: the
   * best rank a camera achieves on each beat, and therefore how deep into the
   * list a model must be willing to read. That is reported instead of simulated,
   * because a simulated model measures the simulation.
   */
  it('reports the best camera rank per beat across the corpus', () => {
    const ranks: number[] = [];
    let beatsWithCamera = 0;
    let totalBeats = 0;
    const rows: string[] = [];

    for (const packDef of LOOK_PACKS) {
      const pack = lookPack(packDef.id);
      if (pack.forbidCategories?.includes('camera')) continue; // by design
      for (const energy of [0.2, 0.5, 0.85]) {
        const brief = briefFor(packDef.id, energy);
        const seq = sequence(brief);
        const perBeat: string[] = [];
        for (const beat of seq.beats) {
          const list = motionCandidates({
            pack: {
              id: pack.id,
              prefer: pack.prefer,
              forbid: pack.forbid,
              forbidCategories: pack.forbidCategories,
              forbidAboveEnergy: pack.forbidAboveEnergy,
            },
            energy,
            slotDurationMs: beat.durationMs,
            availableRoles: availableRolesFor(beat) as never,
            alreadyCast: [],
            tags: beat.tags,
          });
          totalBeats++;
          const idx = list.findIndex((c) => c.technique.category === 'camera');
          if (idx >= 0) {
            beatsWithCamera++;
            ranks.push(idx + 1);
            perBeat.push(`#${idx + 1}/${list.length}`);
          } else {
            perBeat.push('—');
          }
        }
        rows.push(`[A.3b] ${packDef.id.padEnd(20)} e=${energy.toFixed(2)} best camera rank: ${perBeat.join('  ')}`);
      }
    }

    const sorted = [...ranks].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const withinTop = (k: number) => ranks.filter((r) => r <= k).length;
    log('\n' + rows.join('\n'));
    log(
      `\n[A.3b summary] ${beatsWithCamera}/${totalBeats} editorial beats offer a camera\n` +
        `      best rank — median ${median}, min ${sorted[0] ?? 0}, max ${sorted[sorted.length - 1] ?? 0}\n` +
        `      reachable if the model reads the top 1:  ${withinTop(1)}/${totalBeats}\n` +
        `                                    top 3:  ${withinTop(3)}/${totalBeats}\n` +
        `                                    top 5:  ${withinTop(5)}/${totalBeats}\n` +
        `                                   top 10:  ${withinTop(10)}/${totalBeats}`,
    );

    // Every editorial beat offers one. That part IS closed.
    expect(beatsWithCamera).toBe(totalBeats);
  });
});

describe('A.2 — camera-layer collisions', () => {
  it('counts every camera-kind layer created in a whole composition', () => {
    for (const pack of LOOK_PACKS) {
      const brief = briefFor(pack.id, 0.5);
      const seq = sequence(brief);
      const { calls } = emitAndValidate({
        sequence: seq,
        casting: castWith(brief, 'camera.push_in_slow'),
        lookPackId: pack.id,
        ...FRAME,
      });
      const d = readDepths(calls);
      log(`[A.2] ${pack.id.padEnd(20)} cameras=${d.cameraIds.length} ${d.cameraIds.join(', ')}`);
      // The renderer takes the TOPMOST camera. More than one means the cast
      // technique's camera may not be the one the frame is rendered through.
      expect(d.cameraIds.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('A.3 — can the model even choose a camera', () => {
  const ENERGIES = [0.2, 0.5, 0.85];

  it('logs the camera-candidate count per beat, per pack, per energy', () => {
    const rows: string[] = [];
    const evicted: string[] = [];
    let zeroBeats = 0;
    let totalBeats = 0;

    for (const packDef of LOOK_PACKS) {
      const pack = lookPack(packDef.id);
      for (const energy of ENERGIES) {
        const brief = briefFor(packDef.id, energy);
        const seq = sequence(brief);
        const counts: number[] = [];
        for (const beat of seq.beats) {
          const list = motionCandidates({
            pack: {
              id: pack.id,
              prefer: pack.prefer,
              forbid: pack.forbid,
              forbidCategories: pack.forbidCategories,
              forbidAboveEnergy: pack.forbidAboveEnergy,
            },
            energy,
            slotDurationMs: beat.durationMs,
            availableRoles: availableRolesFor(beat) as never,
            alreadyCast: [],
            tags: beat.tags,
          });
          // The same query with the cap lifted. The difference between the two
          // is the whole question: a camera absent from the capped list but
          // present in the uncapped one was ELIGIBLE and got evicted by ranking
          // — a different defect, with a different fix, from one the pack or the
          // energy band genuinely excludes.
          const uncapped = motionCandidates({
            pack: {
              id: pack.id,
              prefer: pack.prefer,
              forbid: pack.forbid,
              forbidCategories: pack.forbidCategories,
              forbidAboveEnergy: pack.forbidAboveEnergy,
            },
            energy,
            slotDurationMs: beat.durationMs,
            availableRoles: availableRolesFor(beat) as never,
            alreadyCast: [],
            tags: beat.tags,
            limit: 999,
          });
          const cams = list.filter((c) => c.technique.category === 'camera').length;
          const eligibleCams = uncapped.filter((c) => c.technique.category === 'camera').length;
          counts.push(cams);
          if (eligibleCams > cams) {
            evicted.push(
              `${packDef.id} e=${energy} beat${beat.index}: ${eligibleCams} eligible → ${cams} offered ` +
                `(${eligibleCams - cams} evicted by the ${list.length}-slot cap; beat tags [${beat.tags.join(',')}])`,
            );
          }
          totalBeats++;
          if (cams === 0) zeroBeats++;
        }
        const forbidden = pack.forbidCategories?.includes('camera') ?? false;
        rows.push(
          `[A.3] ${packDef.id.padEnd(20)} e=${energy.toFixed(2)} cams/beat=[${counts.join(',')}]` +
            (forbidden ? '  (pack forbids the camera category — by design)' : ''),
        );
      }
    }
    log('\n' + rows.join('\n'));
    log(`\n[A.3 summary] beats with ZERO camera candidates: ${zeroBeats}/${totalBeats}`);
    log(
      `[A.3 eviction] beat-slots where an ELIGIBLE camera was cut by the cap: ${evicted.length}\n      ` +
        (evicted.join('\n      ') || '(none)'),
    );

    expect(totalBeats).toBeGreaterThan(0);
  });
});
