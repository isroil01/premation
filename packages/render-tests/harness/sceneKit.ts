/**
 * Scene authoring kit for the golden-frame suite (Phase 0).
 *
 * A "scene" is a small, single-feature document built programmatically on a
 * fresh SceneGraph + AnimationEngine, plus metadata declaring the output size,
 * composition, and which frames to render. Scenes are rendered through the
 * REAL production path (createRenderBackend → buildSnapshot → renderFrame), so
 * they exercise exactly what ships — this module only builds inputs.
 */

import type SceneGraph from '@core/scene/SceneGraph';
import type { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import type { MotionBlurConfig } from '@core/effects/motionBlur';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

export interface SceneComp {
  width: number;
  height: number;
  background: string;
  transparent?: boolean;
}

export interface SceneMeta {
  /** Stable id — also the references/<id>/ folder name. Keep kebab-case. */
  id: string;
  description: string;
  /** Output frame size in device px. */
  size: { w: number; h: number };
  /** Composition size + background threaded into buildSnapshot. */
  comp: SceneComp;
  fps: number;
  /** Frame indices to render (time = index / fps). */
  frames: number[];
  /** Comp-level motion blur (buildSnapshot's 7th arg). Off when omitted. */
  motionBlur?: MotionBlurConfig;
  /** Per-scene fraction of pixels allowed to differ (default 0.005 = 0.5%). */
  tolerance?: number;
  /**
   * Which backend is the reference oracle for this scene (default 'canvas2d').
   * Use 'gpu' for features Canvas2D can't render or renders with a fundamentally
   * different algorithm (gpuOnly effects, and — as the GPU becomes the sole
   * engine — GPU-native effects/lights). For a 'gpu' scene the reference is
   * blessed from the WebGL2 output and the determinism gate compares WebGL2 vs
   * the reference (Canvas2D is not a meaningful comparison). Every 'gpu' bless
   * MUST be human-eyeballed to confirm the GPU output is actually correct.
   */
  oracle?: 'canvas2d' | 'gpu';
  /**
   * GPU parity expectation vs the Canvas2D reference:
   *   'expect-pass'      — GPU must match the reference (gates the build).
   *   'known-divergent'  — a documented gap the later phases will close; the
   *                        parity diff is reported but not gated. If it turns
   *                        green, the runner flags it so we can re-classify.
   * Defaults to 'expect-pass'.
   */
  gpuParity?: 'expect-pass' | 'known-divergent';
}

export interface Scene extends SceneMeta {
  /** Populate the graph/animation with this scene's content. Pure/deterministic. */
  build: (graph: SceneGraph, anim: AnimationEngine) => void;
}

/**
 * A bare shape node (mirrors the fixture in buildSnapshot.test.ts). Kind is
 * carried on the Transform component via SCENE_KIND_PROP so buildSnapshot sizes
 * it correctly.
 */
export function shapeNode(
  id: string,
  opts: {
    x?: number;
    y?: number;
    rotation?: number;
    fill?: string;
    opacity?: number;
  } = {},
): SceneNode {
  const { x = 0, y = 0, rotation = 0, fill = '#2b7eff', opacity = 100 } = opts;
  return {
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x, y }, rotation, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation } },
      { id: `${id}_s`, type: 'Style', props: { opacity, fill } },
    ],
  } as unknown as SceneNode;
}

type Comp = { id: string; type: string; props: Record<string, unknown> };

/**
 * Flexible node builder for any kind (shape/text/camera/light/group/…). Always
 * emits a Transform component carrying the kind + x/y/rotation; adds a Style
 * component when `style` is given, and appends any extra components verbatim.
 */
export function node(
  id: string,
  opts: {
    kind: string;
    position?: { x: number; y: number };
    rotation?: number;
    transform?: Record<string, unknown>;
    style?: Record<string, unknown>;
    components?: Comp[];
  },
): SceneNode {
  const { kind, position = { x: 0, y: 0 }, rotation = 0, transform = {}, style, components = [] } = opts;
  const comps: Comp[] = [
    {
      id: `${id}_t`,
      type: 'Transform',
      props: { [SCENE_KIND_PROP]: kind, x: position.x, y: position.y, rotation, ...transform },
    },
  ];
  if (style) comps.push({ id: `${id}_s`, type: 'Style', props: { opacity: 100, ...style } });
  comps.push(...components);
  return {
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position, rotation, scale: { x: 1, y: 1 } },
    components: comps,
  } as unknown as SceneNode;
}

/** Convenience: define a scene with defaults filled in. */
export function defineScene(scene: Scene): Scene {
  return scene;
}
