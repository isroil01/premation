import type { PipelineContext } from '../PipelineContext';
import type { CallModelFn } from './intent';

export async function runPromptOptimizerStage(
  ctx: PipelineContext,
  callModel: CallModelFn
): Promise<string> {
  const systemPrompt = `You are an Expert Motion Graphics Prompt Designer and Director.
Your job is to optimize and expand naive or short user prompts into highly-detailed, professional motion graphics briefs.
Analyze the user's prompt and composition context, then output a rich, descriptive visual brief that specifies:
1. Pacing & Tone (e.g. slow cinematic reveal, fast-paced energetic promo).
2. Layout structure and spacing (avoiding clutter, centering elements, vertical hierarchy).
3. Easing, overshoot physics, and stagger animations (specify exact timing and flow).
4. Styling directions (Brand reference feel like Apple/Stripe, lighting overlays, shadows, glows).
5. Interactive elements (like camera parallax dolly zooms, custom cursor spotlights, or sound FX cues).
Provide only the final optimized prompt text, no JSON wrapper.`;

  const userPrompt = `Original Prompt: "${ctx.originalPrompt}"
Composition Context Preamble:
${ctx.compPreamble}`;

  const optimizedText = await callModel({
    system: systemPrompt,
    user: userPrompt,
    modelTier: 'fast',
  });

  return optimizedText.trim() || ctx.originalPrompt;
}
