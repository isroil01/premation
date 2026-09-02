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
import type { SsaoConfig } from '@core/rendering/RenderBackend';

export interface SceneComp {
  width: number;
  height: number;
  background: string;
  transparent?: boolean;
  /**
   * Render only this root's subtree. Needed by scenes that hold MORE than one
   * root comp — a host plus a comp it places (see `precomp-collapse`). Without
   * it buildSnapshot flattens every root and the referenced comp draws twice:
   * once as itself, once through the instance.
   */
  rootId?: string;
  /** Referenced-comp size resolver for placed compositions (COMP_REF_PROP) —
   *  the same hook the editor passes (see compSizes.ts). */
  compSizeOf?: (id: string) => { width: number; height: number } | undefined;
  /**
   * Composition Settings > World > Ambient Occlusion, threaded straight into
   * `buildSnapshot` like every other field here.
   *
   * Optional and absent everywhere else, which is the point: SSAO is a comp
   * setting, so the only way a scene can exercise it is to author one, and
   * the only way every OTHER scene can prove it is untouched is for this to
   * stay absent there.
   */
  ssao?: SsaoConfig;
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
   *   'expect-pass' — GPU must match the reference (gates the build).
   *   'known-divergent' — a documented gap the later phases will close; the
   *                        parity diff is reported but not gated. If it turns
   *                        green, the runner flags it so we can re-classify.
   * Defaults to 'expect-pass'.
   */
  gpuParity?: 'expect-pass' | 'known-divergent';
  /**
   * Why this scene is allowed to diverge — REQUIRED for 'known-divergent'.
   *
   * A label with no stated cause is indistinguishable from "nobody looked", and
   * that is not hypothetical here: `effect-gradient-ramp` sat in this bucket
   * while the effect rendered SOLID BLACK, in 2D and 3D, because the
   * suppression is what stopped anyone asking. `effect-stroke` sat in the
   * failure column for months over a stale reference. Two of twenty-three.
   *
   * The runner rejects a 'known-divergent' scene that omits this, so the gap
   * cannot be widened by adding a label — only by writing down a mechanism,
   * which is much harder to do falsely than it is to leave a flag.
   */
  divergence?: {
    /**
     * The MECHANISM, specifically. Not "antialiasing differs" but which two
     * things compute what differently. If you cannot name it, you have not
     * finished diagnosing and the scene is not ready to be suppressed.
     */
    why: string;
    /**
     * What would make this scene match — the condition under which this entry
     * should be deleted. An accepted gap with no exit is a permanent one.
     */
    wouldMatchWhen: string;
    /**
     * Where the divergence is ASSERTED rather than merely tolerated: a test
     * that pins the property the pixels cannot. Optional, because some gaps are
     * genuinely "two rasterizers, same shape"; when it is present the claim is
     * checked somewhere instead of only described.
     */
    proof?: string;
  };
  /**
   * Scene id whose rendered output is this scene's FIDELITY ORACLE.
   *
   * A committed reference PNG is blessed from our own output, so it can only
   * catch regressions from whatever we blessed — if a transform were wrong
   * today, we would bless the wrong pixels and guard them forever. A twin is a
   * second scene rendering the same content by an independent route (for SVG
   * layers: the untouched source file), so the diff answers "did our pipeline
   * change the pixels?" on the very first run, with nothing to eyeball.
   *
   * Gated separately from, and in addition to, the reference comparison.
   */
  fidelityTwin?: string;
  /** Fraction of pixels allowed to differ from the twin (default 1%, per §10). */
  fidelityTolerance?: number;
  /** Why this scene needs a raised `fidelityTolerance`. Printed in the report. */
  fidelityException?: string;
  /**
   * This scene exists only to be some other scene's `fidelityTwin`. It is
   * rendered, but has no committed reference and is excluded from the reference
   * gate and the parity dashboard — otherwise every oracle would need a blessed
   * PNG whose only job is to duplicate the scene it is checking.
   */
  fidelityOnly?: boolean;
  /**
   * This scene's frames MUST NOT be identical to each other.
   *
   * The assertion for keyframeable properties, and the one that was missing
   * everywhere: a scene declares two frames with two clearly different
   * keyframed values, and the runner requires the rendered pixels to differ.
   * Not that the track exists, not that sampling returns the right number —
   * those hold in every version of the "it doesn't animate" bug. Only a
   * frame-to-frame pixel diff says the chain reached the compositor.
   *
   * Pairs naturally with `fidelityOnly`: the claim is about this scene's own
   * two frames, so it needs no blessed reference to check.
   */
  animates?: boolean;
  /** Fraction of pixels that must CHANGE between consecutive frames for an
   *  `animates` scene (default 0.002 = 0.2%). Raise for a property whose visible
   *  effect is genuinely small; never lower it to nothing. */
  animatesMinChange?: number;
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
