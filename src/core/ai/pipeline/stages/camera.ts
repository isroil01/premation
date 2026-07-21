import type { PipelineContext } from '../PipelineContext';
import type { CameraPlanOutput } from '../types';
import { cameraSchema } from '../schemas/camera';
import type { CallModelFn } from './intent';

export async function runCameraPlanStage(
  ctx: PipelineContext,
  beatId: string,
  beatIndex: number,
  callModel: CallModelFn
): Promise<CameraPlanOutput> {
  const targetBeat = ctx.storyboard?.beats.find((b) => b.id === beatId);
  const targetScene = ctx.scenePlans?.find((s) => s.beatId === beatId);
  if (!targetBeat || !targetScene) {
    throw new Error(`Storyboard beat or Scene Plan with ID ${beatId} not found in context.`);
  }

  const systemPrompt = `You are the Lead Cinematographer and 3D Camera Director. Your job is to plan cinematic 3D camera framing, dolly sweeps, orbit yaw/pitch moves, and parallax for a storyboard scene.
- Leverage 3D camera capabilities: keyframe camera Z (dolly push-in/pull-out e.g. z=-900 to z=-400), orbitYaw (3D pan sweep e.g. -15° to 0°), orbitPitch, focalLength (zoom), and poi (point of interest).
- Create multi-layer parallax by moving the camera over layers positioned at distinct 3D depths (background z=400..600, logo mark z=0, headline z=-100).
- Maintain cinematic elegance: smooth easeOut or continuous camera motion; avoid erratic shakes.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `User Prompt: "${ctx.originalPrompt}"
Storyboard Beat:
${JSON.stringify(targetBeat, null, 2)}
Scene Plan:
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
    responseSchema: cameraSchema,
    modelTier: 'strong', // Camera planning defaults to strong
  });

  try {
    const parsed = JSON.parse(rawResult.trim()) as CameraPlanOutput;
    parsed.beatId = beatId;
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse Camera Planner stage output as JSON: ${err}`);
  }
}
