import type { PipelineContext } from '../PipelineContext';
import type { AnimationPlanOutput } from '../types';
import { animationSchema } from '../schemas/animation';
import type { CallModelFn } from './intent';

export async function runAnimationPlanStage(
  ctx: PipelineContext,
  beatId: string,
  beatIndex: number,
  callModel: CallModelFn
): Promise<AnimationPlanOutput> {
  const targetBeat = ctx.storyboard?.beats.find((b) => b.id === beatId);
  const targetScene = ctx.scenePlans?.find((s) => s.beatId === beatId);
  if (!targetBeat || !targetScene) {
    throw new Error(`Storyboard beat or Scene Plan with ID ${beatId} not found in context.`);
  }

  const systemPrompt = `You are the Lead Keyframe Choreographer and Motion Animator. Your job is to plan the exact animation values, stagger offsets, ease targets, and secondary animations for each element in the scene.
For each element:
- Reference the custom easings and timing norms from the Motion Specification.
- Define explicit start/end values, delays, and durations for opacity, scale, and translation (x, y) where appropriate.
- Configure animationOrder to stagger entrances (following spec rules).
- Apply overshoot, anticipation, and follow-through as appropriate.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Storyboard Beat:
${JSON.stringify(targetBeat, null, 2)}
Scene Plan (Elements to Animate):
${JSON.stringify(targetScene, null, 2)}
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
    responseSchema: animationSchema,
    modelTier: 'strong', // Animation planning defaults to strong
  });

  try {
    const parsed = JSON.parse(rawResult.trim()) as AnimationPlanOutput;
    parsed.beatId = beatId;
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse Animation Planner stage output as JSON: ${err}`);
  }
}
