/**
 * Two vision judges for the eval harness, each with a fixed rubric.
 *
 * Scores here are MEASUREMENT, not feedback: the critique inside a run never
 * averages (a score invites converging on the mean), but comparing two modes
 * over fifteen prompts needs numbers. Two judges with different questions,
 * because one judge asked everything tends to grade one impression:
 *
 *  - craft: is it well made — type, layout, colour, finish, motion read from
 *    the frame spacing.
 *  - fit: is it the RIGHT piece — does it serve the brief, is it more than a
 *    stock template, does it use the medium.
 *
 * Every score is 1–10 with anchors in the prompt, and each judge must name
 * the single biggest problem, so a number never arrives without a reason.
 */

import type { AiImage } from '@motion/ai-tools';
import { askJson, type AskTarget } from '../../askJson';

export type JudgeId = 'craft' | 'fit';

export const JUDGE_RUBRICS: Readonly<Record<JudgeId, { criteria: readonly string[]; system: string }>> = {
  craft: {
    criteria: ['typography', 'layout', 'colour', 'motion', 'finish'],
    system:
      'You are a senior motion-design art director scoring craft. You are shown a contact sheet of frames sampled evenly across a motion piece (reading order; the bar under each frame is its position in time). Spacing between frames of a moving element is its velocity.\n' +
      'Score each criterion 1–10: 1–3 amateur or broken, 4–5 competent but generic, 6–7 professional, 8–9 distinctive studio work, 10 exceptional.\n' +
      '- typography: hierarchy, scale contrast, tracking and leading, legibility.\n' +
      '- layout: composition, balance, grid, negative space, nothing clipped or colliding.\n' +
      '- colour: a deliberate palette, contrast, mood.\n' +
      '- motion: easing, staggering and choreography as far as the frames show it; static or simultaneous is low.\n' +
      '- finish: texture, depth, polish — would this ship?\n' +
      'Return ONLY JSON: { "scores": { "typography": n, "layout": n, "colour": n, "motion": n, "finish": n }, "biggestProblem": "…", "notes": "…" }',
  },
  fit: {
    criteria: ['brief', 'originality', 'range', 'story'],
    system:
      'You are a creative director deciding whether a motion piece answers its brief. You are shown the brief and a contact sheet of frames sampled evenly across the piece (reading order).\n' +
      'Score each criterion 1–10: 1–3 misses, 4–5 literal and generic, 6–7 a good answer, 8–9 a strong idea well executed, 10 exceptional.\n' +
      '- brief: does it say what the brief asked, in the tone it asked for?\n' +
      '- originality: is it more than a stock template — could you name the template it resembles? (If you can, it is low.)\n' +
      '- range: does it use the medium — depth, light, texture, imagery, type in motion — or is it boxes and fades?\n' +
      '- story: does it have a beginning, a development and an end that lands?\n' +
      'Return ONLY JSON: { "scores": { "brief": n, "originality": n, "range": n, "story": n }, "biggestProblem": "…", "notes": "…" }',
  },
};

export interface JudgeVerdict {
  judge: JudgeId;
  scores: Record<string, number>;
  /** Mean of the criteria present (NaN when the judge returned nothing usable). */
  mean: number;
  biggestProblem: string;
  notes: string;
}

/** A verdict that is valid whatever came back: scores clamped to 1–10, missing ones absent. */
export function coerceVerdict(judge: JudgeId, raw: unknown): JudgeVerdict {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const s = o.scores && typeof o.scores === 'object' ? (o.scores as Record<string, unknown>) : {};
  const scores: Record<string, number> = {};
  for (const c of JUDGE_RUBRICS[judge].criteria) {
    const v = typeof s[c] === 'number' ? s[c] : Number(s[c]);
    if (Number.isFinite(v)) scores[c] = Math.max(1, Math.min(10, Math.round(v as number)));
  }
  const vals = Object.values(scores);
  return {
    judge,
    scores,
    mean: vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2)) : Number.NaN,
    biggestProblem: typeof o.biggestProblem === 'string' ? o.biggestProblem : '',
    notes: typeof o.notes === 'string' ? o.notes : '',
  };
}

export async function runJudge(target: AskTarget, judge: JudgeId, brief: string, sheet: AiImage): Promise<JudgeVerdict> {
  const res = await askJson(target, JUDGE_RUBRICS[judge].system, `BRIEF: ${brief}`, {
    images: [sheet],
    maxTokens: 1500,
    temperature: 0,
    path: 'author',
  });
  return coerceVerdict(judge, res.value);
}
