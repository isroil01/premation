import type { PipelineContext } from '../PipelineContext';
import type { CreativeOutput } from '../types';
import { creativeSchema } from '../schemas/creative';
import type { CallModelFn } from './intent';

export async function runCreativeStage(
  ctx: PipelineContext,
  callModel: CallModelFn
): Promise<CreativeOutput> {
  const systemPrompt = `You are a world-class Motion Graphics & 3D Visual Director (After Effects / Cinema4D level craft).
Given the parsed intent, brand signals, and user request, establish a committed, high-production artistic vision for a 3D motion graphics video or 3D logo reveal.
Make specific, high-end design decisions on:
- 3D spatial depth & framing (background depth, 3D focal logo/emblem mark, typography layering, camera parallax).
- Stylized lighting & looks (neon glows, gradient ramps, metallic/dark glass surfaces, drop shadows).
- Kinetic typography and 3D logo motion choreography (overshoot springs, 3D Y-axis flips, camera dolly sweeps).
- Pacing & transitions (smooth staggered reveals, motion-blurred entrances, cinematic camera push-ins).
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Parsed Intent:
${JSON.stringify(ctx.intent, null, 2)}
Composition Context Preamble:
${ctx.compPreamble}`;

  const rawResult = await callModel({
    system: systemPrompt,
    user: userPrompt,
    responseSchema: creativeSchema,
    modelTier: 'strong', // Creative Director is a strong tier stage
  });

  try {
    return JSON.parse(rawResult.trim()) as CreativeOutput;
  } catch (err) {
    throw new Error(`Failed to parse Creative Director stage output as JSON: ${err}`);
  }
}
