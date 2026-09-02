/**
 * Per-layer 3D (2.5D) support — app side.
 *
 * The app stores transforms as props on a node's `Transform` component
 * (x/y/rotation/scaleX/scaleY). A layer becomes "3D" when it also carries the
 * depth props below; a small inspector toggle adds/removes them. Once present
 * they behave like any other numeric prop — the NodeInspector renders a
 * keyframeable, undoable row for each automatically, so 3D values animate
 * through the exact same command path as x/y/rotation.
 *
 * The renderer (buildSnapshot) reads these via {@link readNode3D} and projects
 * the layer through a pinhole camera: +z dollies the layer away (smaller) and
 * parallaxes it toward the vanishing point; rotationX / rotationY foreshorten
 * it (tilt / flip). See `@motion/scene`'s Project3D + matrix4.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { bumpScene } from '@stores/sceneStore';
import { useCompositionStore } from '@stores/compositionStore';
import { defaultAnimation } from '@motion/animation';
import { type BevelStyle, DEFAULT_BEVEL_STYLE } from '@core/scene/extrusion';

/** A Solid layer — the renderer pins its transform to the comp box while 2D.
 *  Mirrors buildSnapshot's own `isSolid` test so the two cannot drift. */
function isSolidNode(node: SceneNode): boolean {
  return node.components.find((c) => c.type === 'fx')?.props.solid === true;
}

/**
 * Every bevel profile, in menu order. Exported because the inspector's
 * "Bevel style" dropdown builds its options from it — a second hand-written
 * list would be one more place for a new profile to be silently missing.
 */
export const BEVEL_STYLES: readonly BevelStyle[] = ['angular', 'concave', 'convex'];

/** The depth props that mark a layer as 3D-enabled. */
export const THREE_D_PROPS = ['z', 'rotationX', 'rotationY'] as const;

export interface Node3D {
  /** Depth along the view axis (0 = comp plane). */
  z: number;
  /** Degrees — rotation about the horizontal (x) axis. */
  rotationX: number;
  /** Degrees — rotation about the vertical (y) axis. */
  rotationY: number;
  /** AE Orientation: a resting 3D facing composed BEFORE the animatable
   *  rotation, in degrees. Absent → 0 (no effect). */
  orientationX: number;
  orientationY: number;
  orientationZ: number;
  /** Anchor-point depth (px). matrix4 pivots rotation/scale around it; absent →
   *  0 (the layer plane), which is why it was invisibly dropped before. */
  anchorZ: number;
  /** Extrusion depth (px, ≥ 0). When > 0 the renderer synthesizes a back cap
   *  and side walls so the layer is a REAL 3D object, not a flat plane.
   *  Keyframeable like every other Transform prop; 0 = classic flat layer. */
  extrusionDepth: number;
  /** Bevel (chamfer) depth (px, ≥ 0). When > 0 (and extruded) the renderer
   *  insets the front/back caps and bridges them to the walls with a 45°
   *  chamfer ring, so the object's edges catch light. Keyframeable; clamped to
   *  min(w,h)/2 and depth/2 at render time. 0 = hard square edges. */
  bevelDepth: number;
  /** Bevel profile. `angular` (default) is a single 45° chamfer; `concave` and
   *  `convex` are multi-segment curved profiles (see `extrudeOutline`, which
   *  raises the bevel segment count for them). */
  bevelStyle: BevelStyle;
}

const ZERO_3D: Node3D = {
  z: 0, rotationX: 0, rotationY: 0,
  orientationX: 0, orientationY: 0, orientationZ: 0, anchorZ: 0,
  extrusionDepth: 0, bevelDepth: 0, bevelStyle: DEFAULT_BEVEL_STYLE,
};

function transformComponent(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return node.components.find((c) => c.type === 'Transform') as
    | { id: string; props: Record<string, unknown> }
    | undefined;
}

/**
 * The layer kinds that can participate in 3D space.
 *
 * The four content kinds project pixels. `null` draws nothing at all and is
 * here anyway, because a 3D null is the standard way to rig a 3D scene: it is
 * a parent whose Z position and X/Y rotation drive its children. Excluding it
 * meant the one layer type people reach for first to build a 3D rig was the one
 * type that could not be made 3D — and a 2D parent cannot pass depth down.
 *
 * Everything else is either structural (group/comp — never draws and cannot
 * parent in 3D), a scene device (camera/light — they DRIVE 3D rather than
 * being 3D), non-visual (audio), or drawn outside the 3D projection path
 * (particle, adjustment). Solids are kind 'shape' and eligible — see canBe3D.
 */
const THREE_D_CAPABLE_KINDS = new Set(['shape', 'text', 'image', 'video', 'null']);

/**
 * True when this node can meaningfully take the 3D switch: content kind and
 * carries a Transform. Every 3D affordance (inspector switch, timeline cube,
 * viewport badge, "Make all 3D") gates on this ONE predicate so a switch never
 * lights up without pixels changing.
 *
 * Solids ARE eligible (AE parity — a solid is just a layer): an UN-switched
 * solid stays pinned full-comp exactly as before; flipping its 3D switch
 * un-pins it onto its own transform, so it projects/tilts like any layer.
 */
export function canBe3D(node: SceneNode): boolean {
  if (!node.components.some((c) => c.type === 'Transform')) return false;
  return THREE_D_CAPABLE_KINDS.has(readNodeKind(node));
}

/** True when the layer carries the 3D depth props (i.e. is a 3D layer). */
export function is3DEnabled(node: SceneNode): boolean {
  const t = transformComponent(node);
  if (!t) return false;
  return THREE_D_PROPS.some((p) => typeof t.props[p] === 'number');
}

/** Read a node's 3D values (0 for any prop that is absent). */
export function readNode3D(node: SceneNode): Node3D {
  const t = transformComponent(node);
  if (!t) return ZERO_3D;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    z: n(t.props.z),
    rotationX: n(t.props.rotationX),
    rotationY: n(t.props.rotationY),
    orientationX: n(t.props.orientationX),
    orientationY: n(t.props.orientationY),
    orientationZ: n(t.props.orientationZ),
    anchorZ: n(t.props.anchorZ),
    extrusionDepth: Math.max(0, n(t.props.extrusionDepth)),
    bevelDepth: Math.max(0, n(t.props.bevelDepth)),
    bevelStyle: BEVEL_STYLES.includes(t.props.bevelStyle as BevelStyle)
      ? (t.props.bevelStyle as BevelStyle)
      : DEFAULT_BEVEL_STYLE,
  };
}

/**
 * Set a layer's extrusion depth (px). Stored only when > 0 so classic flat
 * layers add nothing to file; renders through buildSnapshot's geometry
 * synthesis. Keyframe tracks on 'extrusionDepth' beat this static value.
 */
export function setNodeExtrusionDepth(nodeId: string, depth: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;
  const v = Math.max(0, Math.min(1000, depth));
  defaultSceneGraph.writeProp(nodeId, t.id, 'extrusionDepth', v > 0 ? v : undefined);
  bumpScene();
}

/**
 * Set a layer's bevel (chamfer) depth (px). Stored only when > 0 so square-edge
 * layers add nothing to file. Clamped to 0–200 here; the renderer clamps again
 * to the geometry-safe max (min(w,h)/2, depth/2). Keyframe tracks on
 * 'bevelDepth' beat this static value.
 */
export function setNodeBevelDepth(nodeId: string, depth: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;
  const v = Math.max(0, Math.min(200, depth));
  defaultSceneGraph.writeProp(nodeId, t.id, 'bevelDepth', v > 0 ? v : undefined);
  bumpScene();
}

/**
 * Enable/disable per-character 3D on a TEXT layer (AE's "Enable Per-character
 * 3D"). When on, buildSnapshot emits one 3D plane per glyph instead of a single
 * plane for the whole string, so glyphs intersect, light, and animate in 3D
 * individually. Stored only when true — off costs nothing and renders exactly
 * as a plain 3D text layer.
 */
export function setNodePerChar3D(nodeId: string, enabled: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;
  defaultSceneGraph.writeProp(nodeId, t.id, 'perChar3D', enabled ? true : undefined);
  bumpScene();
}

/** True when the node is a 3D text layer with per-character 3D enabled. */
export function isPerChar3D(node: SceneNode): boolean {
  const t = transformComponent(node);
  const props = (t?.props ?? {}) as Record<string, unknown>;
  return props.perChar3D === true;
}

/**
 * Set a layer's bevel profile. Stored only when non-default (`angular`) so
 * existing layers add nothing to file.
 */
export function setNodeBevelStyle(nodeId: string, style: BevelStyle): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;
  const valid = BEVEL_STYLES.includes(style) ? style : DEFAULT_BEVEL_STYLE;
  defaultSceneGraph.writeProp(nodeId, t.id, 'bevelStyle', valid !== DEFAULT_BEVEL_STYLE ? valid : undefined);
  bumpScene();
}

/**
 * Turn a layer's 3D on/off. Enabling seeds the depth props at 0 (so the
 * inspector shows Z / X-rotation / Y-rotation rows and nothing moves until
 * edited); disabling removes them and drops any animation tracks on them.
 */
export function set3DEnabled(nodeId: string, on: boolean): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const t = transformComponent(node);
  if (!t) return;

  // Solids need their pinned 2D placement written into the transform BEFORE the
  // 3D switch flips.
  //
  // While a solid is 2D the renderer overrides its transform — it draws at
  // comp-centre, unrotated, unscaled, at comp size (buildSnapshot's
  // `isSolid && !is3D` branch). Those overrides drop away the instant the layer
  // becomes 3D, revealing whatever the transform actually holds — and
  // `insertSolid` never wrote x/y, so it is still `makeNode`'s default
  // (160, 120) with a top-left anchor. Net effect: making a 1920×1080 background
  // 3D teleported it so its corner sat at (160, 120). Seeding the values the
  // renderer was already using makes the switch visually a no-op, which is what
  // "make this layer 3D" should be.
  if (on && isSolidNode(node)) {
    const comp = useCompositionStore.getState();
    const seed: Record<string, number> = {
      x: comp.width / 2,
      y: comp.height / 2,
      width: comp.width,
      height: comp.height,
      anchorX: comp.width / 2,
      anchorY: comp.height / 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
    };
    for (const [prop, value] of Object.entries(seed)) {
      defaultSceneGraph.writeProp(nodeId, t.id, prop, value);
    }
  }

  // The plain-view components are rebuilt on read, so props must be persisted
  // through the graph's writeProp, not mutated in place.
  for (const p of THREE_D_PROPS) {
    defaultSceneGraph.writeProp(nodeId, t.id, p, on ? (typeof t.props[p] === 'number' ? t.props[p] : 0) : undefined);
  }

  // Turning 3D OFF must also drop the depth ANIMATION, not just the base props.
  // A leftover `z` track kept feeding a moving depth into the painter sort of a
  // layer that is nominally 2D again, and re-enabling 3D resurrected an animation
  // the user thought they had removed. (This is what the doc comment above always
  // claimed happened.)
  if (!on) {
    for (const p of THREE_D_PROPS) {
      if (defaultAnimation.isAnimated(nodeId, p)) defaultAnimation.removeTrack(nodeId, p);
    }
  }

  bumpScene();
}
