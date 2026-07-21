import type { AiMessage, AiImage } from '@motion/ai-tools';
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
  CritiqueOutput,
} from './types';

export interface PipelineContext {
  originalPrompt: string;
  compPreamble: string;
  history: readonly AiMessage[];
  images?: readonly AiImage[];

  // Accumulated stage outputs
  intent?: IntentOutput;
  creative?: CreativeOutput;
  motionSpec?: MotionSpecOutput;
  storyboard?: StoryboardOutput;
  scenePlans?: ScenePlanOutput[];      // Parallel results, length matches storyboard beats
  animationPlans?: AnimationPlanOutput[]; // Parallel results, length matches storyboard beats
  cameraPlans?: CameraPlanOutput[];      // Parallel results, length matches storyboard beats
  timeline?: TimelinePlanOutput;
  toolPlan?: ToolPlanOutput;
  critiqueHistory?: CritiqueOutput[];
}
