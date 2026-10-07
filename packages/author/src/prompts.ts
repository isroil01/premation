/**
 * The four author prompts: design, beats, critique, revise.
 *
 * One system prompt serves design and beats, so the model writing a beat has
 * read the same rules and vocabulary as the model that planned it. The
 * critique gets its own: it judges, it does not author.
 */

import { CRAFT_RULES, NEVER_RULES } from '@motion/ai-tools';
import { formatAdvice, type AdvisorFinding } from './advisors';
import { formatRepairs } from './coerce';
import { selectAuthorExemplar } from './exemplars';
import { BEATS_SCHEMA, CRITIQUE_SCHEMA, DESIGN_SCHEMA, REVISE_SCHEMA, shapeHint, type CritiqueFinding } from './schema';
import type { Beat, BeatOutline, DesignResult, Repair, ScriptHeader } from './types';
import { vocabularyCard } from './vocabulary';

/** What the host knows about the composition and the user. */
export interface AuthorBrief {
  prompt: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  /** Direction the user set in the composer (mood, accent, light/dark). */
  direction?: { mood?: string; accent?: string; mode?: 'dark' | 'light' };
  /** Imported assets the user named or attached, as one line each. */
  assets?: readonly string[];
  /** Images are attached to the design call. */
  imageCount?: number;
}

const SCRIPT_RULES = `HOW A SCENE SCRIPT WORKS
- You write JSON, never prose. The editor compiles it to real layers, effects and keyframes exactly as written — nothing is filled in for you. A colour, size, position, font, ease or time you leave out is NOT chosen for you; the engine's bare default applies, and it will look like it.
- Positions are the layer CENTRE in composition px. Frame origin is top-left.
- Times inside a beat are BEAT-LOCAL seconds (0 = the beat's start). Globals use composition seconds.
- Layers are listed BACK TO FRONT. A beat's layers exist only during the beat unless you give inSec/outSec; extend a layer past its beat's end to carry it across a cut (that is continuity, and it is what makes a film rather than a slideshow).
- Every animated property needs at least two keys at different times. ease applies to the segment that starts at that key.
- Colours are hex or $name from your palette. Text uses a typeStyle from your type scale and may override any field.
- Use roles honestly: one hero per beat; ambient and background for atmosphere; ui only for product interface elements.
- A layer id is unique across the WHOLE script and is how parents and mattes refer to it.
- Reach for the whole engine where it serves the idea: real 3D (threeD + z + a camera), effects with animated params, text animators, trim paths, repeaters, masks, mattes, blend modes, generated imagery (kind image) and your own vectors (kind svg). A piece made only of fading rectangles is a failure of imagination, not a safe choice.`;

/** The system prompt for the design and beat calls. */
export function authorSystemPrompt(brief: Pick<AuthorBrief, 'prompt'>): string {
  const ex = selectAuthorExemplar(brief.prompt);
  return [
    'You are a senior motion designer authoring a complete motion-graphics composition for a professional animation engine. You design the whole piece — concept, palette, type, layout, staging, choreography, effects — and write it as a scene script the engine compiles exactly.',
    '',
    SCRIPT_RULES,
    '',
    CRAFT_RULES,
    '',
    NEVER_RULES,
    '',
    vocabularyCard(),
    '',
    `REFERENCE SCRIPT — "${ex.script.title}". ${ex.lesson} Take its STRUCTURE and level of finish; take none of its colours, words, sizes or timings — those belonged to its brief.`,
    JSON.stringify(ex.script),
  ].join('\n');
}

function aspectOf(w: number, h: number): string {
  const ar = w / h;
  return ar > 1.4 ? 'wide' : ar < 0.72 ? 'portrait' : ar > 0.95 && ar < 1.05 ? 'square' : 'near-square';
}

function briefLines(b: AuthorBrief): string[] {
  return [
    `Composition: ${b.width}×${b.height} (${aspectOf(b.width, b.height)}), ${b.fps} fps, ${b.durationSec}s — the user chose this; fill all of it and author nothing past it.`,
    ...(b.direction?.mood ? [`Mood the user set: ${b.direction.mood}.`] : []),
    ...(b.direction?.accent ? [`Accent the user set: ${b.direction.accent} — build the palette around it.`] : []),
    ...(b.direction?.mode ? [`The user wants a ${b.direction.mode} piece.`] : []),
    ...(b.assets?.length ? ['Media the user supplied (use it — it is why they attached it):', ...b.assets.map((a) => `  ${a}`)] : []),
  ];
}

/** Call 1: the header, the beat outline and the globals. No beat layers. */
export function designPrompt(b: AuthorBrief): string {
  return [
    `BRIEF: ${b.prompt}`,
    '',
    ...briefLines(b),
    ...(b.imageCount ? [`The attached image${b.imageCount > 1 ? 's are' : ' is'} REFERENCE for the look — read palette, type, density and mood from ${b.imageCount > 1 ? 'them' : 'it'}; do not describe ${b.imageCount > 1 ? 'them' : 'it'} back.`] : []),
    '',
    'Design the piece. Return ONE JSON object: the title, the idea in one sentence, the palette (named swatches you will reference as $name), the grid, the type scale, the globals (piece-wide layers such as a backdrop or a front grain pass, in composition seconds), and the beat outline (2–6 beats that tile the whole duration; each with a name, a purpose and notes that say what the hero is, how it is staged and what the motion idea is). Do NOT write beat layers yet.',
    `Shape: ${shapeHint(DESIGN_SCHEMA)}`,
  ].join('\n');
}

/** A compact restatement of the design for the later calls. */
function designDigest(d: DesignResult | ScriptHeader & { beats: BeatOutline[] }): string {
  const { beats, ...head } = d as DesignResult;
  return [
    `DESIGN: ${JSON.stringify(head)}`,
    'BEAT OUTLINE:',
    ...beats.map((b, i) => `  ${i}. ${b.name} (${b.startSec}–${b.endSec}s) — ${b.purpose}${b.notes ? ` Notes: ${b.notes}` : ''}`),
  ].join('\n');
}

/** Call 2..n: the layers of up to three beats. */
export function beatsPrompt(b: AuthorBrief, design: DesignResult, indices: readonly number[], written: readonly Beat[] = []): string {
  const ids = written.flatMap((w) => w.layers.map((l) => l.id));
  return [
    `BRIEF: ${b.prompt}`,
    ...briefLines(b),
    '',
    designDigest(design),
    ...(ids.length ? ['', `Layer ids already used by earlier beats (do not reuse): ${ids.join(', ')}.`] : []),
    '',
    `Write the complete layers for beat${indices.length > 1 ? 's' : ''} ${indices.join(', ')}. Every layer fully specified: geometry, paint, type, effects, keys with eases. Times are beat-local.`,
    `Return ONE JSON object: ${shapeHint(BEATS_SCHEMA)}`,
  ].join('\n');
}

/** The critic's system prompt. */
export function critiqueSystemPrompt(): string {
  return [
    'You are a creative director reviewing a junior motion designer\'s render against the brief. You are specific and you are not polite about defects: you name the beat, the layer and the fix.',
    '',
    'For each beat decide keep or revise. Revise only for defects a viewer would notice: an empty or unbalanced frame, illegible type, elements colliding or clipped, a hero that does not read as the hero, motion that is static, mechanical, simultaneous or linear where it should not be, a beat that does not serve the brief, a cut where nothing carries over. Taste you merely would have done differently is not a defect.',
    'Every finding has a problem (what you see, with the time) and a fix (what to change, concretely — which layer, which property, to roughly what).',
    `Return ONE JSON object: ${shapeHint(CRITIQUE_SCHEMA)}`,
  ].join('\n');
}

export interface CritiqueInput {
  brief: AuthorBrief;
  design: DesignResult;
  /** The rendered evidence: an overall filmstrip, velocity graphs, one strip per beat (labelled in the text). */
  evidenceNotes: readonly string[];
  /** Mechanical verification of the built scene (verify.ts), already formatted. */
  mechanical?: string | null;
  advice: readonly AdvisorFinding[];
  repairs: readonly Repair[];
}

export function critiquePrompt(c: CritiqueInput): string {
  return [
    `BRIEF: ${c.brief.prompt}`,
    '',
    designDigest(c.design),
    '',
    'EVIDENCE (the attached images, in order):',
    ...c.evidenceNotes.map((n, i) => `  ${i + 1}. ${n}`),
    ...(c.mechanical ? ['', 'MECHANICAL CHECKS (measured on the built scene):', c.mechanical] : []),
    ...(c.advice.length ? ['', 'LINTER FINDINGS (advice; confirm against the frames before you act on one):', formatAdvice(c.advice)] : []),
    ...(c.repairs.length ? ['', 'REPAIRS THE COMPILER HAD TO MAKE (the script asked for something the engine does not take):', formatRepairs(c.repairs, 15)] : []),
  ].join('\n');
}

/** One revise call for one beat. */
export function revisePrompt(b: AuthorBrief, design: DesignResult, beatIndex: number, beat: Beat, findings: readonly CritiqueFinding[], advice: readonly AdvisorFinding[], otherIds: readonly string[]): string {
  return [
    `BRIEF: ${b.prompt}`,
    '',
    designDigest(design),
    '',
    `BEAT ${beatIndex} AS BUILT: ${JSON.stringify({ name: beat.name, purpose: beat.purpose, layers: beat.layers })}`,
    '',
    'WHAT THE REVIEW FOUND:',
    ...findings.map((f) => `- ${f.problem} → ${f.fix}${f.layers?.length ? ` (layers: ${f.layers.join(', ')})` : ''}`),
    ...(advice.length ? ['', 'LINTER FINDINGS FOR THIS BEAT:', formatAdvice(advice, 10)] : []),
    '',
    `Rewrite this beat's layers to fix every finding. Keep what works; this replaces the beat entirely, so return every layer it should have. Keep the beat's time window (${beat.startSec}–${beat.endSec}s); times stay beat-local.`,
    ...(otherIds.length ? [`Ids used by other beats (do not reuse): ${otherIds.join(', ')}.`] : []),
    `Return ONE JSON object: ${shapeHint(REVISE_SCHEMA)}`,
  ].join('\n');
}
