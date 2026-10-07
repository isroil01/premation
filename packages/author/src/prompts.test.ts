/**
 * The prompts carry what the model needs and nothing that would make it copy.
 */

import { CRAFT_RULES, NEVER_RULES } from '@motion/ai-tools';
import { coerceCritique } from './schema';
import { authorSystemPrompt, beatsPrompt, critiquePrompt, designPrompt, revisePrompt } from './prompts';
import { AUTHOR_EXEMPLARS, selectAuthorExemplar } from './exemplars';
import { AUTHOR_EFFECTS, vocabularyCard } from './vocabulary';
import type { DesignResult } from './types';

const BRIEF = { prompt: 'A logo sting for NOVA, punchy', width: 1080, height: 1920, fps: 30, durationSec: 6 };

const DESIGN: DesignResult = {
  title: 'NOVA', intent: 'i', durationSec: 6, background: '#000000', palette: { hot: '#ff0055' },
  grid: { columns: 6, gutter: 16, margin: 80, baseline: 8 }, type: {}, globals: [],
  beats: [{ name: 'Draw', purpose: 'p', startSec: 0, endSec: 3 }, { name: 'Out', purpose: 'q', startSec: 3, endSec: 6, notes: 'fade' }],
};

describe('author prompts', () => {
  it('the system prompt carries the shared craft rules, the vocabulary and the closest exemplar', () => {
    const sys = authorSystemPrompt(BRIEF);
    expect(sys).toContain(CRAFT_RULES);
    expect(sys).toContain(NEVER_RULES);
    expect(sys).toContain(vocabularyCard());
    expect(sys).toContain(JSON.stringify(AUTHOR_EXEMPLARS.find((e) => e.id === 'logo_sting')!.script));
    expect(selectAuthorExemplar('a kinetic typography quote').id).toBe('kinetic_quote');
  });

  it('the vocabulary card lists every author effect with its params', () => {
    const card = vocabularyCard();
    for (const e of AUTHOR_EFFECTS) expect(card).toContain(`${e.type} (${e.label})`);
    expect(card).toContain('blurriness 0..500px');
  });

  it('the design prompt states the frame, the duration and the user\'s direction', () => {
    const p = designPrompt({ ...BRIEF, direction: { accent: '#ff0055', mode: 'dark' }, imageCount: 1 });
    expect(p).toContain('1080×1920 (portrait)');
    expect(p).toContain('6s');
    expect(p).toContain('#ff0055');
    expect(p).toContain('attached image is REFERENCE');
  });

  it('beat, critique and revise prompts carry the outline and the findings', () => {
    expect(beatsPrompt(BRIEF, DESIGN, [1], [])).toMatch(/1\. Out \(3–6s\) — q Notes: fade/);
    const c = critiquePrompt({ brief: BRIEF, design: DESIGN, evidenceNotes: ['whole piece'], mechanical: '- x is offscreen', advice: [], repairs: [{ path: 'beats[0]', message: 'dropped' }] });
    expect(c).toContain('MECHANICAL CHECKS');
    expect(c).toContain('beats[0]: dropped');
    const r = revisePrompt(BRIEF, DESIGN, 0, { ...DESIGN.beats[0]!, layers: [] }, [{ problem: 'empty', fix: 'add the mark' }], [], ['x']);
    expect(r).toContain('empty → add the mark');
    expect(r).toContain('(0–3s)');
  });
});

describe('coerceCritique', () => {
  it('keeps unmentioned beats, refuses a revise with nothing to fix, ignores out-of-range indices', () => {
    const c = coerceCritique({
      overall: 'ok',
      beats: [
        { index: 0, verdict: 'revise', findings: [{ problem: 'type collides', fix: 'move it' }] },
        { index: 1, verdict: 'revise', findings: [] },
        { index: 9, verdict: 'revise', findings: [{ problem: 'x', fix: 'y' }] },
      ],
    }, 3);
    expect(c.beats.map((b) => b.verdict)).toEqual(['revise', 'keep', 'keep']);
    expect(coerceCritique(undefined, 2).beats.map((b) => b.verdict)).toEqual(['keep', 'keep']);
  });
});
