import type { PipelineContext } from '../PipelineContext';
import type { TimelinePlanOutput } from '../types';
import { timelineSchema } from '../schemas/timeline';
import type { CallModelFn } from './intent';

export async function runTimelineStage(
  ctx: PipelineContext,
  callModel: CallModelFn
): Promise<TimelinePlanOutput> {
  const systemPrompt = `You are the Lead Timeline Editor and Conformer. Your job is to compile the global composition timeline based on all preceding storyboard beats, scene structures, and camera movements.
Calculate the startSeconds and durationSeconds for each scene to ensure a continuous edit.
- Avoid accidental gaps or overlaps.
- Start the first scene at 0.0 seconds.
- Align durations with the storyboard intentions and camera movements.
- Calculate and set the final totalDurationSeconds.
- HARD CONSTRAINT: totalDurationSeconds MUST equal the composition duration stated in the
  Composition Context Preamble — the user chose that length. If the storyboard beats sum short,
  stretch holds/beats proportionally to fill it; if they sum long, compress proportionally.
  Never deliver a timeline that ends before, or runs past, the composition's end.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Storyboard Beats:
${JSON.stringify(ctx.storyboard, null, 2)}
Scene Plans:
${JSON.stringify(ctx.scenePlans, null, 2)}
Animation Plans:
${JSON.stringify(ctx.animationPlans, null, 2)}
Camera Plans:
${JSON.stringify(ctx.cameraPlans, null, 2)}

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
    responseSchema: timelineSchema,
    modelTier: 'fast', // Timeline Planner may default to fast
  });

  try {
    return JSON.parse(rawResult.trim()) as TimelinePlanOutput;
  } catch (err) {
    throw new Error(`Failed to parse Timeline stage output as JSON: ${err}`);
  }
}
