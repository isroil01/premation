/**
 * CORPUS METRICS — the numbers every phase report is measured against.
 *
 * Runs the deterministic half of the caster over all 8 packs × 3 energies with a
 * WEAK cast (first valid candidate, seed 0, no params — the same hostile stand-in
 * `caster.test.ts` uses), and reports the linter scores and diversity metrics.
 *
 * Weak on purpose: a metric taken with a good model measures the model. The
 * point of this architecture is that the floor does not depend on one, so the
 * floor is what gets measured.
 *
 * `CORPUS_METRICS=1 npx jest corpusMetrics` prints the table.
 */

import { LOOK_PACKS, candidates as layoutCandidates } from '@motion/design-system';
import { candidates as motionCandidates } from '@motion/technique-library';
import { availableRolesFor, emitAndValidate, motionCastScope, sceneFromCalls, sequence } from './index';
import { lookPack } from '@motion/design-system';
import type { Casting, CreativeBrief } from './types';

const FRAME = { width: 1920, height: 1080, fps: 30 };
const VERBOSE = process.env.CORPUS_METRICS === '1';
const log = (...a: unknown[]): void => {

  if (VERBOSE) console.log(...a);
};

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

function briefFor(packId: string, energy: number): CreativeBrief {
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

/** The weakest plausible model: first valid candidate, seed 0, no params. */
function weakCast(brief: CreativeBrief): Casting {
  const seq = sequence(brief);
  const pack = lookPack(brief.lookPackId);
  const castSoFar: string[] = [];
  const motion: Casting['motion'] = [];
  for (const beat of seq.beats) {
    const list = motionCandidates({
      // Through the caster's own helper, not a rebuilt literal. The rebuilt
      // literal is why this harness reported healthy `uiMotionScore` numbers for
      // two packs that had never once cast a product technique.
      ...motionCastScope(pack),
      energy: brief.energy,
      slotDurationMs: beat.durationMs,
      availableRoles: availableRolesFor(beat) as never,
      alreadyCast: castSoFar,
      tags: beat.tags,
    });
    const pick = list[0];
    if (!pick) continue;
    motion.push({ beatIndex: beat.index, techniqueId: pick.technique.id, params: {}, seed: 0 });
    castSoFar.push(pick.technique.id);
  }
  return {
    layouts: seq.beats.map((b) => ({
      beatIndex: b.index,
      templateId: layoutCandidates({ packId: brief.lookPackId, content: b.content, tags: b.tags })[0]?.template.id ?? '',
      seed: 0,
    })),
    motion,
  };
}

const mean = (xs: readonly number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

describe('corpus metrics', () => {
  it('reports the deterministic floor across every pack and energy', () => {
    const design: number[] = [];
    const craft: number[] = [];
    const ui: number[] = [];
    const techDiv: number[] = [];
    const tmplDiv: number[] = [];
    const entropy: number[] = [];
    const coverage: number[] = [];
    let cameraRuns = 0;
    let runs = 0;
    const ruleCounts = new Map<string, number>();
    const rows: string[] = [];

    for (const packDef of LOOK_PACKS) {
      for (const energy of [0.2, 0.5, 0.85]) {
        const brief = briefFor(packDef.id, energy);
        const seq = sequence(brief);
        const casting = weakCast(brief);
        const { report } = emitAndValidate({
          sequence: seq,
          casting,
          lookPackId: packDef.id,
          ...FRAME,
        });
        runs++;
        design.push(report.designScore);
        craft.push(report.craftScore);
        ui.push(report.uiMotionScore);
        techDiv.push(report.metrics.techniqueDiversity);
        tmplDiv.push(report.metrics.templateDiversity);
        entropy.push(report.metrics.variantEntropy);
        coverage.push(report.metrics.techniqueCoverage);
        if (report.techniques.some((t) => t.startsWith('camera.'))) cameraRuns++;
        for (const f of report.findings) {
          ruleCounts.set(f.rule, (ruleCounts.get(f.rule) ?? 0) + 1);
        }
        rows.push(
          `${packDef.id.padEnd(20)} e=${energy.toFixed(2)}  design=${report.designScore.toFixed(3)} ` +
            `craft=${report.craftScore.toFixed(3)} ui=${report.uiMotionScore.toFixed(3)} ` +
            `findings=${report.findings.length}`,
        );
      }
    }

    log('\n' + rows.join('\n'));
    log(
      `\n── CORPUS (${runs} runs, weak cast) ──\n` +
        `designScore     ${mean(design).toFixed(4)}\n` +
        `craftScore      ${mean(craft).toFixed(4)}\n` +
        `uiMotionScore   ${mean(ui).toFixed(4)}\n` +
        `techniqueCoverage  ${mean(coverage).toFixed(4)}\n` +
        `techniqueDiversity ${mean(techDiv).toFixed(4)}\n` +
        `templateDiversity  ${mean(tmplDiv).toFixed(4)}\n` +
        `variantEntropy     ${mean(entropy).toFixed(4)}\n` +
        `camera coverage    ${cameraRuns}/${runs} runs cast a camera\n` +
        `\nfindings by rule:\n` +
        [...ruleCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `  ${r.padEnd(28)} ${n}`)
          .join('\n'),
    );

    // The floor, asserted rather than merely printed. A weak cast must still
    // clear these or the thesis does not hold.
    expect(mean(craft)).toBeGreaterThan(0.8);
    expect(mean(design)).toBeGreaterThan(0.5);
    expect(runs).toBe(24);
  });

  it('censuses what the newly-sighted linter can now actually SEE', () => {
    /**
     * Extending `sceneFromCalls` to parse trim, path ops, masks, text animators,
     * lights, layer styles, particles and real repeater geometry changed the
     * corpus scores by exactly nothing. That is a result worth explaining rather
     * than reporting as "no regression".
     *
     * Two possibilities: the rules do not consume the new fields, or the corpus
     * does not contain them. This tells them apart by counting the fields
     * directly in the parsed scene.
     */
    const tally = {
      layers: 0, trim: 0, pathOps: 0, mask: 0, textAnimator: 0,
      light: 0, layerStyle: 0, particle: 0, repeater: 0, repeaterSeparating: 0,
      nonRectShape: 0, asset: 0,
    };

    for (const packDef of LOOK_PACKS) {
      for (const energy of [0.2, 0.5, 0.85]) {
        const brief = briefFor(packDef.id, energy);
        const seq = sequence(brief);
        const { calls } = emitAndValidate({
          sequence: seq,
          casting: weakCast(brief),
          lookPackId: packDef.id,
          ...FRAME,
        });
        const layers = sceneFromCalls(calls, { width: FRAME.width, height: FRAME.height }, {});
        for (const l of layers) {
          tally.layers++;
          if (l.trim) tally.trim++;
          if (l.pathOps?.length) tally.pathOps++;
          if (l.hasMask) tally.mask++;
          if (l.textAnimators?.length) tally.textAnimator++;
          if (l.isLight) tally.light++;
          if (l.layerStyles?.length) tally.layerStyle++;
          if (l.isParticle) tally.particle++;
          if (l.repeater) {
            tally.repeater++;
            const r = l.repeater;
            if (r.copies > 1 && (Math.abs(r.offsetX) > 0.5 || (Math.abs(r.offsetRotation) > 0.5 && Math.abs(r.anchorX) > 0.5))) {
              tally.repeaterSeparating++;
            }
          }
          if (l.shape !== undefined && l.shape !== 'rect') tally.nonRectShape++;
          if (l.isAsset) tally.asset++;
        }
      }
    }

    log(
      `\n── PARSED-SCENE CENSUS (24 runs, ${tally.layers} layers) ──\n` +
        `  trim (stroke draw-on)   ${tally.trim}\n` +
        `  path operators          ${tally.pathOps}\n` +
        `  masks                   ${tally.mask}\n` +
        `  text animators          ${tally.textAnimator}\n` +
        `  lights                  ${tally.light}\n` +
        `  layer styles            ${tally.layerStyle}\n` +
        `  particles               ${tally.particle}\n` +
        `  repeaters               ${tally.repeater} (separating: ${tally.repeaterSeparating})\n` +
        `  non-rect shapes         ${tally.nonRectShape}\n` +
        `  assets                  ${tally.asset}`,
    );

    // No assertion on the counts themselves — this is a census, and pinning a
    // number here would fail every time the corpus legitimately changed. The
    // guard is that the parse produced layers at all.
    expect(tally.layers).toBeGreaterThan(0);
  });
});
