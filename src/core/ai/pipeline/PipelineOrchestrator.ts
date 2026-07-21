import type { AiMessage, AiImage, ProviderId } from '@motion/ai-tools';
import { validate } from '@motion/ai-tools';
import type { GatewayProviderId } from '@core/api/client';
import type { PipelineContext } from './PipelineContext';
import { streamTurn } from '../AgentLoop';
import { runPromptOptimizerStage } from './stages/promptOptimizer';
import { runIntentStage } from './stages/intent';

import { intentSchema } from './schemas/intent';
import { runCreativeStage } from './stages/creative';
import { creativeSchema } from './schemas/creative';
import { runMotionIntelligenceStage } from './stages/spec';
import { specSchema } from './schemas/spec';
import { runStoryboardStage } from './stages/storyboard';
import { storyboardSchema } from './schemas/storyboard';
import { runScenePlanStage } from './stages/scene';
import { sceneSchema } from './schemas/scene';
import { runAnimationPlanStage } from './stages/animation';
import { animationSchema } from './schemas/animation';
import { runCameraPlanStage } from './stages/camera';
import { cameraSchema } from './schemas/camera';
import { runTimelineStage } from './stages/timeline';
import { timelineSchema } from './schemas/timeline';
import { runToolPlanStage } from './stages/toolPlan';
import { toolPlanSchema } from './schemas/toolPlan';
import { runCritiqueStage, verifyPipelineOutput } from './stages/verifier';
import type {
  IntentOutput,
  CreativeOutput,
  MotionSpecOutput,
  StoryboardOutput,
  ScenePlanOutput,
  AnimationPlanOutput,
  CameraPlanOutput,
  TimelinePlanOutput,
  ToolPlanOutput,
} from './types';

export interface PipelineEvents {
  onActivity?: (label: string) => void;
}

export interface PipelineOrchestratorOptions {
  provider: GatewayProviderId;
  dialect: ProviderId;
  model: string;
  history?: readonly AiMessage[];
  images?: readonly AiImage[];
  signal: AbortSignal;
  events?: PipelineEvents;
  existingLayerNames?: string[];
}

/** Helper to strip markdown code fences and trim JSON responses from LLMs. */
export function cleanJsonResponse(rawText: string): string {
  let s = rawText.trim();
  s = s.replace(/^```(?:json)?\s*/i, '');
  s = s.replace(/\s*```$/i, '');
  return s.trim();
}

export class PipelineOrchestrator {
  constructor(private readonly options: PipelineOrchestratorOptions) {}

  private getModelForTier(tier: 'strong' | 'fast'): string {
    const { provider, model } = this.options;
    if (tier === 'strong') return model;

    // Fast model mapping — keep in sync with MODEL_SUGGESTIONS in
    // src/stores/aiProviderStore.ts (retired ids fail at the provider).
    switch (provider) {
      case 'openai':
        return 'gpt-4o-mini';
      case 'gemini':
        return 'gemini-3.5-flash';
      case 'anthropic':
        return 'claude-haiku-4-5-20251001';
      default:
        return model;
    }
  }

  private async callModel(options: {
    system: string;
    user: string;
    responseSchema?: any;
    modelTier?: 'strong' | 'fast';
  }): Promise<string> {
    const { provider, dialect, signal } = this.options;
    const model = this.getModelForTier(options.modelTier ?? 'strong');

    const req: any = {
      model,
      system: options.system,
      messages: [{ role: 'user', content: options.user }],
      tools: [],
      temperature: 0.2, // Low temperature for design planning stages
      maxTokens: 4096,
      responseSchema: options.responseSchema,
    };

    let text = '';
    let toolCallText = '';

    for await (const ev of streamTurn(provider, dialect, model, req, signal)) {
      if (ev.type === 'text_delta') {
        text += ev.text;
      } else if (ev.type === 'tool_call') {
        if (ev.name === 'record_stage_output') {
          toolCallText = typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args);
        }
      } else if (ev.type === 'error') {
        throw new Error(`Model stream error: ${ev.message}`);
      }
    }

    const raw = toolCallText || text;
    return cleanJsonResponse(raw);
  }

  private async invokeModelStream(req: any): Promise<string> {
    const { provider, dialect, signal } = this.options;
    let text = '';
    let toolCallText = '';
    for await (const ev of streamTurn(provider, dialect, req.model, req, signal)) {
      if (ev.type === 'text_delta') {
        text += ev.text;
      } else if (ev.type === 'tool_call') {
        if (ev.name === 'record_stage_output') {
          toolCallText = typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args);
        }
      } else if (ev.type === 'error') {
        throw new Error(`Model stream error: ${ev.message}`);
      }
    }
    const raw = toolCallText || text;
    return cleanJsonResponse(raw);
  }

  private async executeStageWithValidation<T>(
    stageName: string,
    schema: any,
    runFn: (callModel: (opts: {
      system: string;
      user: string;
      responseSchema?: any;
      modelTier?: 'strong' | 'fast';
    }) => Promise<string>) => Promise<T>
  ): Promise<T> {
    try {
      // 1. Initial attempt
      const result = await runFn((opts) => this.callModel(opts));

      // 2. Validate
      const validation = validate(schema, result);
      if (validation.ok) {
        return validation.value as T;
      }

      // 3. Auto-repair retry
      this.options.events?.onActivity?.(`Repairing ${stageName} output schema…`);
      const repairCallModel = async (opts: {
        system: string;
        user: string;
        responseSchema?: any;
        modelTier?: 'strong' | 'fast';
      }) => {
        const originalUser = opts.user;
        const invalidAssistant = JSON.stringify(result, null, 2);
        const correctionUser = `The previous JSON output failed validation against the requested schema with the following errors:\n${validation.errors.map((e) => `- ${e}`).join('\n')}\n\nPlease correct these violations and output the complete corrected JSON conformant to the schema.`;

        const req: any = {
          model: this.getModelForTier(opts.modelTier ?? 'strong'),
          system: opts.system,
          messages: [
            { role: 'user', content: originalUser },
            { role: 'assistant', content: invalidAssistant },
            { role: 'user', content: correctionUser },
          ],
          tools: [],
          temperature: 0.1, // Even lower temperature for schema repairs
          maxTokens: 4096,
          responseSchema: opts.responseSchema,
        };

        return this.invokeModelStream(req);
      };

      const repairedResult = await runFn(repairCallModel);
      const secondValidation = validate(schema, repairedResult);
      if (secondValidation.ok) {
        return secondValidation.value as T;
      }
      throw new Error(`Stage ${stageName} failed validation after repair: ${secondValidation.errors.join(', ')}`);
    } catch (err) {
      throw new Error(`Stage ${stageName} execution failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Run the entire motion director pipeline */
  async execute(prompt: string, compPreamble: string): Promise<PipelineContext> {
    const { events, signal } = this.options;
    
    // 1. Initialize Context
    const context: PipelineContext = {
      originalPrompt: prompt,
      compPreamble,
      history: this.options.history ?? [],
      images: this.options.images,
    };

    if (signal.aborted) throw new Error('Cancelled');

    // 1.5. Stage 0: Prompt Optimizer
    events?.onActivity?.('Optimizing prompt…');
    context.optimizedPrompt = await runPromptOptimizerStage(context, (opts) => this.callModel(opts));
    // Override originalPrompt internally so subsequent stages run on the optimized brief
    context.originalPrompt = context.optimizedPrompt;

    // 2. Stage 1: Intent Analyzer
    events?.onActivity?.('Analyzing intent…');
    context.intent = await this.runIntentStage(context);


    // 3. Stage 2: Creative Director
    events?.onActivity?.('Directing creative visual…');
    context.creative = await this.runCreativeStage(context);

    // 4. Stage 3: Motion Intelligence
    events?.onActivity?.('Generating motion spec…');
    context.motionSpec = await this.runMotionIntelligenceStage(context);

    // 5. Stage 4: Storyboard Planner
    events?.onActivity?.('Storyboarding scene…');
    context.storyboard = await this.runStoryboardStage(context);

    const beats = context.storyboard.beats;

    // 6. Stage 5: Scene Planner (Parallel Fan-out)
    events?.onActivity?.(`Planning ${beats.length} scene(s) in parallel…`);
    context.scenePlans = await Promise.all(
      beats.map((beat, idx) => this.runScenePlanStage(context, beat.id, idx))
    );

    // 7. Stage 6a & 6b: Animation & Camera Planners (Parallel)
    events?.onActivity?.('Planning cameras & animations in parallel…');
    const [animationPlans, cameraPlans] = await Promise.all([
      Promise.all(beats.map((beat, idx) => this.runAnimationPlanStage(context, beat.id, idx))),
      Promise.all(beats.map((beat, idx) => this.runCameraPlanStage(context, beat.id, idx))),
    ]);
    context.animationPlans = animationPlans;
    context.cameraPlans = cameraPlans;

    // 8. Stage 7: Timeline Planner
    events?.onActivity?.('Merging global timeline…');
    context.timeline = await this.runTimelineStage(context);

    // 9. Stage 8: Tool Planner
    events?.onActivity?.('Authoring tool plan steps…');
    context.toolPlan = await this.runToolPlanStage(context);

    // 10. Stage 9: Critique & Verification (Phase 12)
    events?.onActivity?.('Reviewing production plan…');
    const existingNames = new Set((this.options.existingLayerNames ?? []).map((n) => n.toLowerCase()));
    const verification = verifyPipelineOutput(context, existingNames);
    
    if (!verification.valid) {
      events?.onActivity?.('Critique auditing plan repair…');
      context.toolPlan = await this.executeStageWithValidation<ToolPlanOutput>(
        'Plan Critique',
        toolPlanSchema,
        (callModel) => runCritiqueStage(context, verification.errors, callModel)
      );
      
      const secondVerification = verifyPipelineOutput(context, existingNames);
      if (!secondVerification.valid) {
        throw new Error(`Plan Critique repair failed to resolve verifier issues: ${secondVerification.errors.join(', ')}`);
      }
    }

    return context;
  }

  // --- Stage Stubs (Implemented to be completed in future phases) ---

  private async runIntentStage(ctx: PipelineContext): Promise<IntentOutput> {
    return this.executeStageWithValidation<IntentOutput>(
      'Intent Analyzer',
      intentSchema,
      (callModel) => runIntentStage(ctx, callModel)
    );
  }

  private async runCreativeStage(ctx: PipelineContext): Promise<CreativeOutput> {
    return this.executeStageWithValidation<CreativeOutput>(
      'Creative Director',
      creativeSchema,
      (callModel) => runCreativeStage(ctx, callModel)
    );
  }

  private async runMotionIntelligenceStage(ctx: PipelineContext): Promise<MotionSpecOutput> {
    return this.executeStageWithValidation<MotionSpecOutput>(
      'Motion Intelligence',
      specSchema,
      (callModel) => runMotionIntelligenceStage(ctx, callModel)
    );
  }

  private async runStoryboardStage(ctx: PipelineContext): Promise<StoryboardOutput> {
    return this.executeStageWithValidation<StoryboardOutput>(
      'Storyboard Planner',
      storyboardSchema,
      (callModel) => runStoryboardStage(ctx, callModel)
    );
  }

  private async runScenePlanStage(ctx: PipelineContext, beatId: string, idx: number): Promise<ScenePlanOutput> {
    return this.executeStageWithValidation<ScenePlanOutput>(
      `Scene Planner [Scene ${idx + 1}]`,
      sceneSchema,
      (callModel) => runScenePlanStage(ctx, beatId, idx, callModel)
    );
  }

  private async runAnimationPlanStage(ctx: PipelineContext, beatId: string, idx: number): Promise<AnimationPlanOutput> {
    return this.executeStageWithValidation<AnimationPlanOutput>(
      `Animation Planner [Scene ${idx + 1}]`,
      animationSchema,
      (callModel) => runAnimationPlanStage(ctx, beatId, idx, callModel)
    );
  }

  private async runCameraPlanStage(ctx: PipelineContext, beatId: string, idx: number): Promise<CameraPlanOutput> {
    return this.executeStageWithValidation<CameraPlanOutput>(
      `Camera Planner [Scene ${idx + 1}]`,
      cameraSchema,
      (callModel) => runCameraPlanStage(ctx, beatId, idx, callModel)
    );
  }

  private async runTimelineStage(ctx: PipelineContext): Promise<TimelinePlanOutput> {
    return this.executeStageWithValidation<TimelinePlanOutput>(
      'Timeline Planner',
      timelineSchema,
      (callModel) => runTimelineStage(ctx, callModel)
    );
  }

  private async runToolPlanStage(ctx: PipelineContext): Promise<ToolPlanOutput> {
    return this.executeStageWithValidation<ToolPlanOutput>(
      'Tool Planner',
      toolPlanSchema,
      (callModel) => runToolPlanStage(ctx, callModel)
    );
  }
}
