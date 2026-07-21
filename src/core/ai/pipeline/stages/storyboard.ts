import type { PipelineContext } from '../PipelineContext';
import type { StoryboardOutput } from '../types';
import { storyboardSchema } from '../schemas/storyboard';
import type { CallModelFn } from './intent';

export async function runStoryboardStage(
  ctx: PipelineContext,
  callModel: CallModelFn
): Promise<StoryboardOutput> {
  const systemPrompt = `You are the Lead Storyboard Artist. Your job is to structure the visual narrative of the motion graphics piece.
Decompose the brief into 2 to 8 distinct, chronological scenes/beats.
For each beat/scene, declare:
- A unique id (e.g. scene_1, scene_2).
- The narrative role (hook, hero, problem, solution, features, cta, or other).
- The exact message or text copy featured.
- The target duration of this beat in seconds.
- The focal visual moment or event.
- The emotional target of the beat.
DURATION IS A HARD CONSTRAINT: the Composition Context states the composition's total duration —
the user chose that length. Your beat durations MUST sum to exactly that total. Pick the number of
beats to fill it (2–4s per beat is a good rhythm; a 15s comp wants ~4–6 beats, a 5s comp 2 beats).
Never plan less than the total (dead air at the end) or more (beats that get cut off).
ASPECT IS A HARD CONSTRAINT: read the composition's width×height from the context — a portrait
(9:16) comp stacks content vertically, a square centres it, a wide comp uses horizontal thirds.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Parsed Intent:
${JSON.stringify(ctx.intent, null, 2)}
Creative Vision:
${JSON.stringify(ctx.creative, null, 2)}
Motion Spec:
${JSON.stringify(ctx.motionSpec, null, 2)}
Composition Context Preamble:
${ctx.compPreamble}`;

  const rawResult = await callModel({
    system: systemPrompt,
    user: userPrompt,
    responseSchema: storyboardSchema,
    modelTier: 'strong', // Storyboard Planner benefits from strong reasoning
  });

  try {
    return JSON.parse(rawResult.trim()) as StoryboardOutput;
  } catch (err) {
    throw new Error(`Failed to parse Storyboard stage output as JSON: ${err}`);
  }
}
