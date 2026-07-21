import type { PipelineContext } from '../PipelineContext';
import type { ScenePlanOutput } from '../types';
import { sceneSchema } from '../schemas/scene';
import type { CallModelFn } from './intent';

export async function runScenePlanStage(
  ctx: PipelineContext,
  beatId: string,
  beatIndex: number,
  callModel: CallModelFn
): Promise<ScenePlanOutput> {
  const targetBeat = ctx.storyboard?.beats.find((b) => b.id === beatId);
  if (!targetBeat) {
    throw new Error(`Storyboard beat with ID ${beatId} not found in context.`);
  }

  const systemPrompt = `You are the Lead Art Director and Composition Layout Composer. Your job is to define the exact layout, spacing, composition, and copy text for a single storyboard beat.
You must name every layer by a semantic, descriptive role name (e.g. "hero_title", "feature_card_2", "bg_gradient"). NEVER guess layer IDs or nodeIds.
Provide final text copy (not lorem ipsum placeholders).
Ensure layout positions (x, y) adhere to the visual spec's grid margins, aspect ratio guidelines, and safe zones.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Storyboard Beat to Plan:
${JSON.stringify(targetBeat, null, 2)}
(Beat Index: ${beatIndex + 1} of ${ctx.storyboard?.beats.length})

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
    responseSchema: sceneSchema,
    modelTier: 'strong', // Scene planning is critical and defaults to strong
  });

  try {
    const parsed = JSON.parse(rawResult.trim()) as ScenePlanOutput;
    // Safety check: force beatId to match what we requested
    parsed.beatId = beatId;
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse Scene Planner stage output as JSON: ${err}`);
  }
}
