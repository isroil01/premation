export interface IntentOutput {
  videoType: 'product_launch' | 'explainer' | 'logo_reveal' | 'promo' | 'social_ad' | 'title_sequence' | 'other';
  industry: string;
  audience: string;
  visualStyleSignals: string[];
  brandReferences: string[];
  explicitConstraints: {
    copyText?: string[];
    colors?: string[];
    assetsReferenced?: string[];
    aspectRatio?: string;
    duration?: number;
  };
  assumptions: string[];
}

export interface CreativeOutput {
  creativeVision: string;
  moodAndTone: string;
  emotionalArc: string;
  pacingProfile: {
    pattern: string;
    description: string;
  };
  visualHierarchyPriorities: string[];
  typographyDirection: {
    fontPreset: string;
    pairingRationale: string;
  };
  compositionPrinciples: string[];
  lightingAtmosphereDirection: string;
  transitionPhilosophy: string;
  storytellingDirection: {
    secondZero: string;
    middle: string;
    end: string;
  };
}

export interface CubicBezier {
  name: string;
  bezier: string;
}

export interface MotionSpecOutput {
  motionLanguage: {
    easings: CubicBezier[];
    durationNorms: {
      entranceMs: { min: number; max: number };
      emphasisMs: { min: number; max: number };
      exitMs: { min: number; max: number };
      transitionMs: { min: number; max: number };
    };
    staggerRules: {
      baseOffsetMs: number;
      decayRate: number;
    };
    overshootAmount: number;
    anticipationAmount: number;
    secondaryMotionPolicy: string;
    motionBlurEnabled: boolean;
  };
  typographySystem: {
    scaleRatios: number[];
    weightPairing: { header: string; body: string };
    tracking: { header: string; body: string };
    maxWordsOnScreenPerBeat: number;
  };
  colorSystem: {
    palette: {
      bg: string;
      surface: string;
      primary: string;
      accent: string;
      text: string;
    };
    roles: Record<string, string>;
  };
  hierarchyRules: {
    gridMarginsPx: { top: number; bottom: number; left: number; right: number };
    densityLimit: string;
  };
  transitionGrammar: {
    allowedTypes: string[];
    defaultDurationMs: number;
  };
  cameraLanguage: {
    allowedMoves: string[];
    amplitudeNorms: string;
  };
  animationPrinciples: string[];
  explicitAntiPatterns: string[];
}

export interface StoryboardBeat {
  id: string;
  role: 'hook' | 'hero' | 'problem' | 'solution' | 'features' | 'cta' | 'other';
  message: string;
  targetDurationSeconds: number;
  keyMoment: string;
  emotionalTarget: string;
}

export interface StoryboardOutput {
  beats: StoryboardBeat[];
}

export interface SceneObjectRole {
  roleName: string;
  kind: 'text' | 'shape' | 'solid' | 'group' | 'null' | 'camera' | 'light' | 'adjustment' | 'particle';
  copyText?: string;
  layout: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    alignment: string;
  };
}

export interface ScenePlanOutput {
  beatId: string;
  objects: SceneObjectRole[];
  interactions: string[];
  emphasisTargets: string[];
  intraSceneTimingSketch: string;
}

export interface ElementAnimation {
  roleName: string;
  animationOrder: number;
  easingName: string;
  easingBezier: string;
  anticipationMs: number;
  overshootAmount: number;
  followThroughMs: number;
  secondaryMotionDescription: string;
  blurEnabled: boolean;
  opacity: { start: number; end: number; durationMs: number; delayMs: number };
  scale?: { start: number; end: number; durationMs: number; delayMs: number };
  translation?: { startX: number; startY: number; endX: number; endY: number; durationMs: number; delayMs: number };
}

export interface AnimationPlanOutput {
  beatId: string;
  animations: ElementAnimation[];
}

export interface CameraMovePlan {
  framing: string;
  cameraMovementType: 'push_in' | 'pull_out' | 'pan' | 'tilt' | 'orbit' | 'dolly' | 'static';
  zoomDollyOrbitParallaxIntent: string;
  lensFeel: string;
  depthOfFieldIntent: string;
  startTimeSeconds: number;
  durationSeconds: number;
}

export interface CameraPlanOutput {
  beatId: string;
  cameraMoves: CameraMovePlan[];
}

export interface TimelineSceneWindow {
  beatId: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  transitionInSeconds: number;
  transitionOutSeconds: number;
  holds: { timeSeconds: number; durationSeconds: number }[];
}

export interface TimelinePlanOutput {
  totalDurationSeconds: number;
  scenes: TimelineSceneWindow[];
}

export interface ToolStep {
  stepIndex: number;
  tool: string;
  purpose: string;
  args: Record<string, any>;
  dependsOnSteps: number[];
}

export interface ToolPlanOutput {
  executionPlan: ToolStep[];
}

export interface CritiqueViolation {
  severity: 'error' | 'warning';
  stage: 'intent' | 'creative' | 'spec' | 'storyboard' | 'scene' | 'animation' | 'camera' | 'timeline' | 'tool';
  reason: string;
  remedySuggestion: string;
}

export interface CritiqueOutput {
  iteration: number;
  passesVerification: boolean;
  critiqueNotes: string[];
  violations: CritiqueViolation[];
}
