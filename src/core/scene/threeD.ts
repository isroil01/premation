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
import { renderComponentsOf } from '@core/scene/SceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { type BevelStyle, DEFAULT_BEVEL_STYLE } from '@core/scene/extrusion';

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
  /** AE Hole Bevel Depth: the chamfer on a glyph's counters (the hole of an
   *  O) as a percentage of Bevel Depth, 0–100. Absent → 100 (holes bevel
   *  like the rim — the look every existing document already has). */
  holeBevelDepth: number;
}

/** Hole Bevel Depth's default — and why it is never written to file. */
export const DEFAULT_HOLE_BEVEL_DEPTH = 100;

const ZERO_3D: Node3D = {
  z: 0, rotationX: 0, rotationY: 0,
  orientationX: 0, orientationY: 0, orientationZ: 0, anchorZ: 0,
  extrusionDepth: 0, bevelDepth: 0, bevelStyle: DEFAULT_BEVEL_STYLE,
  holeBevelDepth: DEFAULT_HOLE_BEVEL_DEPTH,
};

/**
 * Read-only: every reader here writes through `defaultSceneGraph.writeProp`,
 * never into the component, so the memoised render view is the right one.
 * `node.components` rebuilds the whole array on each read, and `is3DEnabled`
 * runs per node per frame from the viewport chrome.
 */
function transformComponent(node: SceneNode): { id: string; props: Record<string, unknown> } | undefined {
  return renderComponentsOf(node).find((c) => c.type === 'Transform') as
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
 *
 * `svg` is here for the reason `image` is: a statically-imported SVG is
 * rasterized to a texture and rides the image path end to end (buildSnapshot's
 * `kind === 'svg' ? 'image'` mapping), so 3D placement and extrusion — which
 * traces its silhouette from that same rasterized texture — already work the
 * moment the switch is allowed to light up. It was missing from this list
 * only, the same list-omission class `geometry.ts`'s `isDrawableKind` note
 * documents (svg was unclickable on canvas for the identical reason).
 */
const THREE_D_CAPABLE_KINDS = new Set(['shape', 'text', 'image', 'video', 'null', 'svg']);

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
  const kind = readNodeKind(node);
  if (kind === 'comp') {
    // A composition LAYER (AE): a SEALED one is a card — its comp renders flat
    // and the card sits in 3D (buildPrecompContainer). A COLLAPSED one is not
    // a layer that draws at all (its layers splice into the host), so it stays
    // off. Read straight off the fx component (`COMP_REF_PROP` /
    // `COMP_COLLAPSE_PROP` in compInstance.ts) to keep this module free of the
    // compInstance import chain.
    const fx = node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
    return typeof fx?.__compRef === 'string' && fx.__compRef !== '' && fx.collapseTransforms !== true;
  }
  return THREE_D_CAPABLE_KINDS.has(kind);
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
    holeBevelDepth: typeof t.props.holeBevelDepth === 'number'
      ? Math.max(0, Math.min(100, t.props.holeBevelDepth))
      : DEFAULT_HOLE_BEVEL_DEPTH,
  };
}

/** True when the node is a 3D text layer with per-character 3D enabled. */
export function isPerChar3D(node: SceneNode): boolean {
  const t = transformComponent(node);
  const props = (t?.props ?? {}) as Record<string, unknown>;
  return props.perChar3D === true;
}
