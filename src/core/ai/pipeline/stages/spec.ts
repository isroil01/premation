import type { PipelineContext } from '../PipelineContext';
import type { MotionSpecOutput } from '../types';
import { specSchema } from '../schemas/spec';
import type { CallModelFn } from './intent';

export async function runMotionIntelligenceStage(
  ctx: PipelineContext,
  callModel: CallModelFn
): Promise<MotionSpecOutput> {
  const systemPrompt = `You are the Lead Motion Style Systems Architect. Your job is to translate a high-level creative vision and intent into a highly concrete, system-level design and animation specification.
You must be extremely specific and quantitative. Do not output generic, vague descriptions like "elegant curves" or "natural pacing".
- Demand explicit cubic-bezier coordinates (e.g. cubic-bezier(0.16, 1, 0.3, 1)) for each easing intent.
- Demand specific timing ranges in milliseconds (e.g., entranceMs: { min: 450, max: 750 }).
- Define absolute typographic scales (e.g., scaleRatios: [1, 1.25, 1.5, 2.0]), explicit font weights (e.g. 700, 400), and letter tracking values.
- Designate exact HEX colors for all roles. If the user provided brand colors, you must use and integrate them.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Parsed Intent:
${JSON.stringify(ctx.intent, null, 2)}
Creative Vision Brief:
${JSON.stringify(ctx.creative, null, 2)}
Composition Context Preamble:
${ctx.compPreamble}`;

  const rawResult = await callModel({
    system: systemPrompt,
    user: userPrompt,
    responseSchema: specSchema,
    modelTier: 'strong', // Motion Intelligence is a strong tier stage
  });

  try {
    return JSON.parse(rawResult.trim()) as MotionSpecOutput;
  } catch (err) {
    throw new Error(`Failed to parse Motion Intelligence stage output as JSON: ${err}`);
  }
}
