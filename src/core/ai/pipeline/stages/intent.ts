import type { PipelineContext } from '../PipelineContext';
import type { IntentOutput } from '../types';
import { intentSchema } from '../schemas/intent';

export type CallModelFn = (options: {
  system: string;
  user: string;
  responseSchema?: any;
  modelTier?: 'strong' | 'fast';
}) => Promise<string>;

export async function runIntentStage(
  ctx: PipelineContext,
  callModel: CallModelFn
): Promise<IntentOutput> {
  const systemPrompt = `You are the Lead Creative Planner. Analyze the user's motion design prompt and extract the high-level intent, brand references, explicit visual constraints, and audience details.
If dimensions, durations, or aspect ratios are unspecified, record your explicit assumptions inside 'assumptions[]'.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Composition Context Preamble:
${ctx.compPreamble}`;

  const rawResult = await callModel({
    system: systemPrompt,
    user: userPrompt,
    responseSchema: intentSchema,
    modelTier: 'fast',
  });

  try {
    return JSON.parse(rawResult.trim()) as IntentOutput;
  } catch (err) {
    throw new Error(`Failed to parse Intent stage output as JSON: ${err}`);
  }
}
