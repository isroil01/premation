import type { PipelineContext } from '../PipelineContext';
import type { ToolPlanOutput } from '../types';
import { toolPlanSchema } from '../schemas/toolPlan';
import type { CallModelFn } from './intent';

export interface VerificationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Deterministically check constraints on the compiled plan:
 * 1. Easing alignment (animations use easings declared in the Spec)
 * 2. Role reference resolution (all "role:..." references are created or pre-exist)
 * 3. Timeline continuity (no gaps between scenes, matches totalDurationSeconds)
 */
export function verifyPipelineOutput(
  ctx: PipelineContext,
  existingLayerNames: Set<string>
): VerificationResult {
  const errors: string[] = [];

  const spec = ctx.motionSpec;
  const storyboard = ctx.storyboard;
  const scenePlans = ctx.scenePlans;
  const animationPlans = ctx.animationPlans;
  const timeline = ctx.timeline;
  const toolPlan = ctx.toolPlan;

  if (!spec || !storyboard || !scenePlans || !animationPlans || !timeline || !toolPlan) {
    return { valid: false, errors: ['Missing core stage plans in context.'] };
  }

  // 1. Easing validation
  const allowedEasings = new Set(spec.motionLanguage.easings.map((e) => e.name.toLowerCase()));
  allowedEasings.add('linear');
  allowedEasings.add('step');
  allowedEasings.add('ease');
  allowedEasings.add('easein');
  allowedEasings.add('easeout');
  allowedEasings.add('easeinout');
  allowedEasings.add('bezier');
  allowedEasings.add('hold');

  for (const animPlan of animationPlans) {
    for (const anim of animPlan.animations) {
      if (!allowedEasings.has(anim.easingName.toLowerCase())) {
        errors.push(
          `Animation for role "${anim.roleName}" in beat "${animPlan.beatId}" uses undefined easing name "${anim.easingName}". Easing must match one defined in the Motion Spec.`
        );
      }
    }
  }

  // 2. Role resolution validation
  const createdRoles = new Set<string>();
  for (const step of toolPlan.executionPlan) {
    if (step.tool === 'create_layer' && step.args && typeof step.args.name === 'string') {
      createdRoles.add(step.args.name.toLowerCase());
    }
  }

  const isRoleResolved = (val: string): boolean => {
    const name = val.toLowerCase();
    return createdRoles.has(name) || existingLayerNames.has(name);
  };

  const checkValueForRoles = (val: any, path: string) => {
    if (typeof val === 'string') {
      if (val.startsWith('role:')) {
        const role = val.slice(5);
        if (!isRoleResolved(role)) {
          errors.push(
            `Action step "${path}" references unresolved role "${role}". Make sure a create_layer step exists for this role name.`
          );
        }
      }
    } else if (Array.isArray(val)) {
      val.forEach((item, idx) => checkValueForRoles(item, `${path}[${idx}]`));
    } else if (val && typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) {
        checkValueForRoles(v, `${path}.${k}`);
      }
    }
  };

  for (const step of toolPlan.executionPlan) {
    checkValueForRoles(step.args, `Step ${step.stepIndex} (${step.tool})`);
  }

  // 3. Timeline continuity validation
  let timelinePointer = 0;
  const sortedScenes = [...timeline.scenes].sort((a, b) => a.startSeconds - b.startSeconds);
  for (const scene of sortedScenes) {
    if (Math.abs(scene.startSeconds - timelinePointer) > 0.05) {
      errors.push(
        `Timeline continuity gap or overlap: scene for beat "${scene.beatId}" starts at ${scene.startSeconds}s, expected around ${timelinePointer}s.`
      );
    }
    timelinePointer = scene.startSeconds + scene.durationSeconds;
  }
  if (Math.abs(timeline.totalDurationSeconds - timelinePointer) > 0.05) {
    errors.push(
      `Timeline total duration mismatch: spec total is ${timeline.totalDurationSeconds}s, but scenes sum to ${timelinePointer}s.`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * If the verifier finds issues, execute a Plan Critique stage using the fast model
 * to repair the toolPlan.
 */
export async function runCritiqueStage(
  ctx: PipelineContext,
  errors: string[],
  callModel: CallModelFn
): Promise<ToolPlanOutput> {
  const systemPrompt = `You are the Lead Conformer and Plan Critique Auditor. The proposed motion graphics execution plan has failed verification checks.
Analyze the verification errors, correct all mismatches, resolve any missing layer creations, fix timing gaps, and produce a corrected Tool Plan.
Do not call tools. Produce your final output strictly conforming to the requested schema.`;

  const userPrompt = `Verification Errors:
${errors.map((e) => `- ${e}`).join('\n')}

Original Tool Plan:
${JSON.stringify(ctx.toolPlan, null, 2)}

Full Context:
Parsed Intent:
${JSON.stringify(ctx.intent, null, 2)}
Creative Vision:
${JSON.stringify(ctx.creative, null, 2)}
Motion Spec:
${JSON.stringify(ctx.motionSpec, null, 2)}
Storyboard:
${JSON.stringify(ctx.storyboard, null, 2)}
Scene Plans:
${JSON.stringify(ctx.scenePlans, null, 2)}
Animation Plans:
${JSON.stringify(ctx.animationPlans, null, 2)}
Camera Plans:
${JSON.stringify(ctx.cameraPlans, null, 2)}
Timeline Plan:
${JSON.stringify(ctx.timeline, null, 2)}

Original User Brief: "${ctx.originalPrompt}"`;

  const rawResult = await callModel({
    system: systemPrompt,
    user: userPrompt,
    responseSchema: toolPlanSchema,
    modelTier: 'fast', // Critique may default to fast
  });

  try {
    return JSON.parse(rawResult.trim()) as ToolPlanOutput;
  } catch (err) {
    throw new Error(`Critique repair failed to parse: ${err}`);
  }
}
