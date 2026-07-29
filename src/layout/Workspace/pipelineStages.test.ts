/**
 * The progress checklist is a promise about what is happening. It stayed wrong
 * for a whole architecture: the labels described a ten-stage client pipeline
 * that had been deleted, so `matchStageIndex` returned -1 for every label the
 * run actually emitted and the panel silently never rendered.
 *
 * Nothing in the type system connects a string literal in `CasterRunner.ts` to
 * a string literal in `useAiChat.ts`, so this test connects them: it reads the
 * labels the runner emits out of the source and asserts each one lands on a
 * stage. Drift fails here rather than showing the user a blank panel.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_STAGE_LABELS, __testables } from './useAiChat';

const { matchStageIndex } = __testables;

/** Pull every `onActivity?.('…')` literal out of a source file. */
function emittedLabels(relPath: string): string[] {
  const src = readFileSync(join(__dirname, relPath), 'utf8');
  const out: string[] = [];
  const re = /onActivity\?\.\(\s*(?:[^)]*?\?\s*)?'([^']+)'(?:\s*:\s*'([^']+)')?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) out.push(m[1]);
    if (m[2]) out.push(m[2]);
  }
  return out;
}

describe('generative-run progress stages', () => {
  const labels = emittedLabels('../../core/ai/CasterRunner.ts');

  it('finds the runner labels at all (guards the regex itself)', () => {
    // If the extraction silently matched nothing, every assertion below would
    // vacuously pass — which is exactly how the original drift survived.
    expect(labels.length).toBeGreaterThanOrEqual(4);
  });

  it('maps every label the caster emits onto a stage', () => {
    const unmatched = labels.filter((l) => matchStageIndex(l) === -1);
    expect(unmatched).toEqual([]);
  });

  it('covers every declared stage — no stage the run can never reach', () => {
    const reached = new Set(labels.map((l) => matchStageIndex(l)));
    const unreachable = PIPELINE_STAGE_LABELS.map((l, i) => (reached.has(i) ? null : l)).filter(Boolean);
    expect(unreachable).toEqual([]);
  });

  it('advances monotonically in the order the runner emits them', () => {
    // 'Casting layouts' and 'Casting motion' come from one branch, so the
    // sequence is non-decreasing rather than strictly increasing.
    const indices = labels.map(matchStageIndex);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]!);
    }
  });

  it('does not match the direct loop into a generative stage', () => {
    for (const l of ['Reading the scene…', 'Thinking…', 'Connecting to Director Service…']) {
      expect(matchStageIndex(l)).toBe(-1);
    }
  });
});
