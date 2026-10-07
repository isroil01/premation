/**
 * The advisors: the caster's linters over an authored composition, with each
 * finding attributed to the beat it is about.
 */

import { adviseScript, formatAdvice } from './advisors';
import { compileScript } from './compile';
import { AUTHOR_EXEMPLARS } from './exemplars';
import type { SceneScript } from './types';

const O = { width: 1920, height: 1080, fps: 30 };

const script = (over: Partial<SceneScript>): SceneScript => ({
  title: 't', intent: 'i', durationSec: 6, background: '#101014',
  palette: { accent: '#ff3355', ink: '#fafafa' },
  grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
  type: {},
  globals: [],
  beats: [],
  ...over,
});

describe('adviseScript', () => {
  it('attributes findings to the beat whose layers they name', () => {
    // Beat 1 has five things arriving on exactly the same frame — the timing
    // linter's simultaneous-entry rule — and beat 0 is clean.
    const enter = (id: string, x: number) => ({
      id, kind: 'shape' as const, name: id, shape: 'rect' as const, props: { x, y: 540, width: 120, height: 120, fill: '$accent' },
      keys: { opacity: [{ t: 0.2, v: 0, ease: 'easeOut' as const }, { t: 0.6, v: 100 }], y: [{ t: 0.2, v: 580, ease: 'easeOut' as const }, { t: 0.6, v: 540 }] },
    });
    const s = script({
      beats: [
        { name: 'calm', purpose: '', startSec: 0, endSec: 3, layers: [enter('solo', 960)] },
        { name: 'pile', purpose: '', startSec: 3, endSec: 6, layers: [enter('p1', 300), enter('p2', 600), enter('p3', 900), enter('p4', 1200), enter('p5', 1500)] },
      ],
    });
    const advice = adviseScript(s, compileScript(s), O);
    const simultaneous = advice.findings.filter((f) => f.rule === 'SIMULTANEOUS_ENTRY');
    expect(simultaneous.length).toBeGreaterThan(0);
    expect(simultaneous.every((f) => f.beatIndex === 1)).toBe(true);
    expect(advice.byBeat.get(1)?.length).toBeGreaterThan(0);
  });

  it('reports a cut nothing survives, and not one a carried layer survives', () => {
    const solid = (id: string, outSec?: number) => ({ id, kind: 'solid' as const, name: id, props: { x: 960, y: 540, width: 400, height: 400, fill: '$accent' }, ...(outSec ? { outSec } : {}) });
    const cut = script({ beats: [
      { name: 'a', purpose: '', startSec: 0, endSec: 3, layers: [solid('a')] },
      { name: 'b', purpose: '', startSec: 3, endSec: 6, layers: [solid('b')] },
    ] });
    const carried = script({ beats: [
      { name: 'a', purpose: '', startSec: 0, endSec: 3, layers: [solid('a', 4)] },
      { name: 'b', purpose: '', startSec: 3, endSec: 6, layers: [solid('b')] },
    ] });
    const rules = (s: SceneScript) => adviseScript(s, compileScript(s), O).findings.map((f) => f.rule);
    expect(rules(cut)).toContain('NO_CONTINUITY');
    expect(rules(carried)).not.toContain('NO_CONTINUITY');
  });

  it('runs over every exemplar without throwing, and formats errors first', () => {
    for (const ex of AUTHOR_EXEMPLARS) {
      const advice = adviseScript(ex.script, compileScript(ex.script), O);
      const text = formatAdvice(advice.findings);
      const firstWarn = text.indexOf('judgement call');
      const lastError = text.split('\n').map((l, i) => (l.includes('judgement call') ? -1 : i)).filter((i) => i >= 0).pop() ?? -1;
      if (firstWarn >= 0 && lastError >= 0) {
        expect(text.split('\n').findIndex((l) => l.includes('judgement call'))).toBeGreaterThan(lastError);
      }
    }
  });
});
