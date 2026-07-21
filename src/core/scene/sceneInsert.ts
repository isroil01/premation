/**
 * sceneInsert — shared "add a primitive to the composition" action, so the
 * insert controls can live anywhere (top tool bar, command palette, …) without
 * each call site re-implementing the node factory.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP, type SceneKind } from './seedDefaultScene';
import { bumpScene } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';
import type { ImportedAsset } from '@stores/assetStore';
import { parseSvgToShapes } from '../../utils/svgParser';
import { bezierCorner as corner } from '@motion/workspace';
import { useCompositionStore } from '@stores/compositionStore';
import { useUIStore } from '@stores/uiStore';
import { Project3D } from '@motion/scene';
import { is3DEnabled } from './threeD';
import { flattenScene, readNodeKind } from './sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { COMP_REF_PROP, wouldCreateCompCycle } from './compInstance';
import { DEFAULT_PARTICLE_CONFIG } from '@core/particles/particleSim';
import { detectImageSequence } from '@core/scene/imageSequence';

let seq = 0;

export { activeCompRootId } from './activeComp';
import { activeCompRootId } from './activeComp';

/** Build a fresh scene node of `kind` with sensible default components. */
function makeNode(kind: SceneKind, name: string): SceneNode {
  const id = `${kind}_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
  const transform = { position: { x: 160, y: 120 }, rotation: 0, scale: { x: 1, y: 1 } };
  const components: SceneNode['components'] =
    kind === 'text'
      ? [
          {
            id: `${id}_t`,
            type: 'Transform',
            props: {
              [SCENE_KIND_PROP]: kind,
              x: 160,
              y: 120,
              rotation: 0,
              scaleX: 1,
              scaleY: 1,
              anchorX: 0,
              anchorY: 0,
            },
          },
          { id: `${id}_c`, type: 'Text', props: { content: 'Text', fontSize: 32, opacity: 100 } },
        ]
      : kind === 'group'
        ? [{ id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: kind } }]
        : [
            {
              id: `${id}_t`,
              type: 'Transform',
              props: {
                [SCENE_KIND_PROP]: kind,
                x: 160,
                y: 120,
                rotation: 0,
                scaleX: 1,
                scaleY: 1,
                anchorX: 0,
                anchorY: 0,
                width: 100,
                height: 100,
              },
            },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
          ];
  return { id, name, parent: null, children: [], transform, visible: true, locked: false, components };
}

import { useProjectStore } from '@stores/projectStore';
import { worldMatrixOf } from './worldTransform';
import { Matrix } from '@motion/scene';

function getLocalTransformForInsert(id: string) {
  const node = defaultSceneGraph.getNode(id);
  if (!node) return null;
  const t = node.components.find((c) => c.type === 'Transform');
  return {
    x: (t?.props.x as number) ?? node.transform.position.x ?? 0,
    y: (t?.props.y as number) ?? node.transform.position.y ?? 0,
    rotation: (t?.props.rotation as number) ?? node.transform.rotation ?? 0,
    scaleX: (t?.props.scaleX as number) ?? (t?.props.scale as number) ?? node.transform.scale.x ?? 1,
    scaleY: (t?.props.scaleY as number) ?? (t?.props.scale as number) ?? node.transform.scale.y ?? 1,
  };
}

function getParentIdForInsert(id: string) {
  const node = defaultSceneGraph.getNode(id);
  return node?.parent ?? null;
}

/** Drop a freshly-made node at the centre of the REAL composition — makeNode's
 *  (160,120) default put every inserted layer in the top-left corner of a
 *  1920×1080 comp, which read as "shapes come in broken". */
function centerInComp(node: SceneNode): void {
  const activeTabId = useProjectStore.getState().activeTabId;
  const activeTab = useProjectStore.getState().tabs[activeTabId ?? ''];
  const compId = activeTab?.compositionId ?? 'comp_root';
  const comp = useProjectStore.getState().comps[compId] ?? useCompositionStore.getState();
  const cx = comp.width / 2;
  const cy = comp.height / 2;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = cx;
    t.props.y = cy;
  }
  node.transform.position.x = cx;
  node.transform.position.y = cy;
}

/**
 * Move a node's base Transform to a world point. Used by canvas drop-to-insert:
 * the insert helpers below all center in the comp and select the new node, so
 * the drop handler inserts then calls this on the fresh selection to land it
 * under the cursor instead. Bumps the scene.
 */
export function setNodeWorldPosition(nodeId: string, x: number, y: number): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  let localX = x;
  let localY = y;
  if (node.parent) {
    const pw = worldMatrixOf(node.parent, getLocalTransformForInsert, getParentIdForInsert);
    const inv = Matrix.invert(pw);
    const pt = Matrix.transformPoint(inv, { x, y });
    localX = pt.x;
    localY = pt.y;
  }
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = localX;
    t.props.y = localY;
  }
  node.transform.position.x = localX;
  node.transform.position.y = localY;
  bumpScene();
}

/** Insert a primitive at the composition root, select it, and refresh the UI. */
export function insertPrimitive(kind: SceneKind, name: string): void {
  const rootId = activeCompRootId();
  const node = makeNode(kind, name);
  centerInComp(node);
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** The distinct shapes the shape library can insert. */
export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'star' | 'polygon' | 'triangle' | 'arrow' | 'heart' | 'cross' | 'diamond' | 'crescent';

type Pt = { x: number; y: number };
type BPoint = ReturnType<typeof corner>;

/**
 * Give a closed outline Catmull-Rom bezier tangents at the indices `smoothAt`
 * marks (corners elsewhere). Curved shapes (heart, crescent) were committed as
 * straight-segment polygons — visibly faceted; the renderer draws real cubic
 * beziers, so handing it tangents is all "smooth clean shapes" needs.
 */
function withTangents(pts: readonly Pt[], smoothAt: (i: number) => boolean): BPoint[] {
  const n = pts.length;
  const k = 1 / 6;
  return pts.map((p, i) => {
    if (!smoothAt(i)) return corner(p.x, p.y);
    const prev = pts[(i - 1 + n) % n]!;
    const next = pts[(i + 1) % n]!;
    const tx = (next.x - prev.x) * k;
    const ty = (next.y - prev.y) * k;
    return { x: p.x, y: p.y, inX: p.x - tx, inY: p.y - ty, outX: p.x + tx, outY: p.y + ty };
  });
}

/** Outline points (local space, centred at 0,0, spanning ±w/2 · ±h/2) for the
 *  path-based shapes. `rect`/`ellipse` return null — they render as native SDF
 *  primitives keyed off the `shapeType` prop, no geometry needed. */
function shapeOutlinePoints(shape: ShapeKind, w: number, h: number): Array<{ x: number; y: number }> | null {
  const rx = w / 2;
  const ry = h / 2;
  const TOP = -Math.PI / 2; // start at 12 o'clock so shapes point up
  switch (shape) {
    case 'polygon': {
      // Regular hexagon.
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 6; i++) {
        const a = TOP + (i / 6) * Math.PI * 2;
        pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
      }
      return pts;
    }
    case 'triangle': {
      // Regular triangle pointing up.
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < 3; i++) {
        const a = TOP + (i / 3) * Math.PI * 2;
        pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
      }
      return pts;
    }
    case 'arrow': {
      // Clean arrow pointing up.
      return [
        { x: 0, y: -ry },
        { x: rx, y: -ry + ry * 0.9 },
        { x: rx * 0.4, y: -ry + ry * 0.9 },
        { x: rx * 0.4, y: ry },
        { x: -rx * 0.4, y: ry },
        { x: -rx * 0.4, y: -ry + ry * 0.9 },
        { x: -rx, y: -ry + ry * 0.9 },
      ];
    }
    case 'heart': {
      // Symmetric heart outline
      return [
        { x: 0, y: -ry * 0.35 },
        { x: rx * 0.35, y: -ry },
        { x: rx * 0.85, y: -ry },
        { x: rx, y: -ry * 0.45 },
        { x: rx, y: ry * 0.1 },
        { x: 0, y: ry },
        { x: -rx, y: ry * 0.1 },
        { x: -rx, y: -ry * 0.45 },
        { x: -rx * 0.85, y: -ry },
        { x: -rx * 0.35, y: -ry },
      ];
    }
    case 'cross': {
      // Clean plus / cross shape
      const cx = rx * 0.35;
      const cy = ry * 0.35;
      return [
        { x: -cx, y: -ry },
        { x: cx, y: -ry },
        { x: cx, y: -cy },
        { x: rx, y: -cy },
        { x: rx, y: cy },
        { x: cx, y: cy },
        { x: cx, y: ry },
        { x: -cx, y: ry },
        { x: -cx, y: cy },
        { x: -rx, y: cy },
        { x: -rx, y: -cy },
        { x: -cx, y: -cy },
      ];
    }
    case 'diamond': {
      // Diamond shape
      return [
        { x: 0, y: -ry },
        { x: rx, y: 0 },
        { x: 0, y: ry },
        { x: -rx, y: 0 },
      ];
    }
    case 'crescent': {
      // Crescent moon shape
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= 10; i++) {
        const pct = i / 10;
        const a = -Math.PI/2 + pct * Math.PI;
        pts.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry });
      }
      for (let i = 10; i >= 0; i--) {
        const pct = i / 10;
        const a = -Math.PI/2 + pct * Math.PI;
        pts.push({ x: Math.cos(a) * rx * 0.52 + rx * 0.32, y: Math.sin(a) * ry });
      }
      return pts;
    }
    case 'star': {
      // 5-point star: alternating outer / inner radius.
      const pts: Array<{ x: number; y: number }> = [];
      const innerRatio = 0.42;
      for (let i = 0; i < 10; i++) {
        const a = TOP + (i / 10) * Math.PI * 2;
        const r = i % 2 === 0 ? 1 : innerRatio;
        pts.push({ x: Math.cos(a) * rx * r, y: Math.sin(a) * ry * r });
      }
      return pts;
    }
    case 'line':
      // Diagonal stroke (bottom-left → top-right), matching the library icon.
      return [{ x: -rx, y: ry }, { x: rx, y: -ry }];
    default:
      return null; // rect / ellipse
  }
}

/**
 * Insert a specific shape (rectangle / ellipse / line / star / polygon) rather
 * than the generic square `insertPrimitive('shape', …)` produced for every
 * preset. `rect`/`ellipse` render as native SDF primitives; the others carry a
 * `Geometry` component so the renderer draws their real outline as a path.
 */
export function insertShape(shape: ShapeKind, name: string): void {
  const rootId = activeCompRootId();
  const node = makeNode('shape', name);
  centerInComp(node);
  const W = 220;
  const H = 220;

  const transform = node.components.find((c) => c.type === 'Transform');
  if (transform) {
    transform.props.width = W;
    transform.props.height = H;
    // Explicit shape type — buildSnapshot reads this to pick the primitive,
    // so it no longer depends on the layer's (renameable) name.
    transform.props.shapeType = shape;
  }

  const pts = shapeOutlinePoints(shape, W, H);
  if (pts) {
    // Curved shapes get real bezier tangents; angular shapes stay corners.
    // Heart: everything curves except the top notch (0) and bottom tip (5).
    // Crescent: two arcs — smooth their bellies, keep the joining tips sharp
    // (outer arc spans 0..10, inner 11..21).
    const points: BPoint[] =
      shape === 'heart'
        ? withTangents(pts, (i) => i !== 0 && i !== 5)
        : shape === 'crescent'
          ? withTangents(pts, (i) => i !== 0 && i !== 10 && i !== 11 && i !== 21)
          : pts.map((p) => corner(p.x, p.y));
    node.components.push({
      id: `${node.id}_g`,
      type: 'Geometry',
      // A line is an open stroke — flag it so the renderer doesn't close the
      // 2-point path into a degenerate loop.
      props: { points, ...(shape === 'line' ? { open: true } : {}) },
    });
  }

  if (shape === 'line') {
    // A line encloses no area, so a fill is invisible — give it a stroke.
    // The stroke must live on the `fx` component: readNodeStroke() reads only
    // fx, so a stroke stashed in Style props would never render.
    const style = node.components.find((c) => c.type === 'Style');
    if (style) style.props.fill = 'rgba(0,0,0,0)';
    node.components.push({
      id: `${node.id}_fx`,
      type: 'fx',
      props: {
        stroke: { enabled: true, color: '#2b7eff', width: 6, opacity: 1, cap: 'round', join: 'miter', align: 'center', dash: [] },
      },
    });
  }

  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/**
 * Insert a custom-outline path layer carrying a `Geometry` points component —
 * the vector primitive the generic `create('shape', …)` action can't build
 * (it only makes rects/ellipses). Used by the Lottie importer to land `ty:'sh'`
 * layers; pair with an animated `path.points` data track for a moving outline.
 * Returns the new node id. Does NOT select or centre — the importer positions
 * layers explicitly.
 */
export function insertPathNode(
  name: string,
  points: BPoint[],
  opts: { closed?: boolean; x?: number; y?: number; width?: number; height?: number } = {},
): string {
  const rootId = activeCompRootId();
  const node = makeNode('shape', name);
  const transform = node.components.find((c) => c.type === 'Transform');
  if (transform) {
    transform.props.width = opts.width ?? 0;
    transform.props.height = opts.height ?? 0;
    transform.props.shapeType = 'path';
    if (opts.x !== undefined) transform.props.x = opts.x;
    if (opts.y !== undefined) transform.props.y = opts.y;
  }
  node.components.push({
    id: `${node.id}_g`,
    type: 'Geometry',
    // `open: true` stops the renderer closing an open outline into a loop.
    props: { points, ...(opts.closed === false ? { open: true } : {}) },
  });
  defaultSceneGraph.addChild(rootId, node);
  bumpScene();
  return node.id;
}

/** Insert a text layer seeded with a preset's font size / weight, label, and style overrides. */
export function insertText(name: string, fontSize = 32, fontWeight = 400, extraProps: Record<string, any> = {}): void {
  const rootId = activeCompRootId();
  const node = makeNode('text', name);
  centerInComp(node);
  const text = node.components.find((c) => c.type === 'Text');
  if (text) {
    text.props.content = name;
    text.props.fontSize = fontSize;
    text.props.fontWeight = fontWeight;
    // Map extraProps onto Text component props
    for (const [key, value] of Object.entries(extraProps)) {
      if (key !== 'fill') {
        text.props[key] = value;
      }
    }
  }
  // Map fill color onto the Style component when present — but text nodes are
  // built with only [Transform, Text], so colored presets (Neon, Tag, Quote…)
  // silently lost their color. The renderer reads `fill` off ANY component,
  // and the inspector writes to Style ?? Text, so Text is the right fallback.
  if (extraProps.fill) {
    const target =
      node.components.find((c) => c.type === 'Style') ??
      node.components.find((c) => c.type === 'Text');
    if (target) {
      target.props.fill = extraProps.fill;
    }
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a full-frame solid colour layer (background / matte / adjustment base).
 *  It is a shape flagged `solid`, so buildSnapshot sizes it to the composition. */
export function insertSolid(color = '#2b7eff'): void {
  const rootId = activeCompRootId();
  const node = makeNode('shape', 'Solid');
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setSolid(node.id, true);
  defaultSceneGraph.setFill(node.id, { type: 'solid', color });
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a Camera layer, centred on the REAL comp and pulled back by its focal
 *  length so the comp plane renders 1:1. Position / z / focalLength are plain
 *  editable + keyframeable props (the inspector shows them automatically). */
export function insertCamera(): void {
  const rootId = activeCompRootId();
  const node = makeNode('camera', 'Camera 1');
  const compSize = useCompositionStore.getState();
  const cam = Project3D.defaultCamera(compSize.width, compSize.height);
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    // Seeded before the node enters the graph, so these become its base props.
    t.props.x = cam.position.x;
    t.props.y = cam.position.y;
    t.props.z = cam.position.z;
    t.props.focalLength = cam.focalLength;
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  // A camera only affects layers whose 3D switch is on. Inserting one into an
  // all-2D scene silently did nothing — tell the user what to do next.
  // Only CONTENT layers count — other cameras/lights carry depth props but
  // aren't layers the camera can move.
  const anyThreeD = flattenScene(defaultSceneGraph).some((n) => {
    const k = readNodeKind(n);
    return n.id !== node.id && k !== 'camera' && k !== 'light' && is3DEnabled(n);
  });
  if (!anyThreeD) {
    useUIStore.getState().notify({
      level: 'info',
      message: 'Camera added — it moves layers with the 3D switch on. Select a layer and enable 3D, then move or keyframe the camera.',
      durationMs: 9000,
    });
  }
}

/** Insert a Light layer */
export function insertLight(): void {
  const rootId = activeCompRootId();
  const node = makeNode('light', 'Light 1');
  const compSize = useCompositionStore.getState();
  // Seed position + keyframeable intensity/radius; warm colour via Style.fill.
  // Radius scales with the comp so the glow reads on any size (a fixed 500px
  // was easy to miss on a 1920-wide comp over bright content).
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = compSize.width / 2;
    t.props.y = compSize.height / 2;
    t.props.intensity = 100;
    t.props.radius = Math.round(Math.max(compSize.width, compSize.height) * 0.45);
  }
  const s = node.components.find((c) => c.type === 'Style');
  if (s) s.props.fill = '#fff3c0';
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a Particle emitter layer, positioned at the comp centre with a
 *  ready-to-play default fountain. The emitter follows the layer's transform. */
export function insertParticle(): void {
  const rootId = activeCompRootId();
  const node = makeNode('particle', 'Particles 1');
  const compSize = useCompositionStore.getState();
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = compSize.width / 2;
    t.props.y = compSize.height / 2;
  }
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setParticle(node.id, DEFAULT_PARTICLE_CONFIG);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert an Adjustment Layer */
export function insertAdjustmentLayer(): void {
  const rootId = activeCompRootId();
  const node = makeNode('adjustment', 'Adjustment Layer 1');
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setSolid(node.id, true);
  defaultSceneGraph.setFill(node.id, { type: 'solid', color: 'rgba(255,255,255,0)' });
  defaultSceneGraph.setAdjustment(node.id, true);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/**
 * Insert a COMPOSITION as a layer (AE's core organizing model): a node that
 * references another comp's root and renders its content through the precomp
 * texture path. The same comp can be placed any number of times; edits to the
 * source comp show up in every instance. Refuses reference cycles.
 * Returns the new node id, or null when refused.
 */
export function insertCompInstance(refCompId: string): string | null {
  const hostRootId = activeCompRootId();
  if (!defaultSceneGraph.getNode(refCompId)) return null;
  if (wouldCreateCompCycle(defaultSceneGraph, hostRootId, refCompId)) {
    useUIStore.getState().notify({
      level: 'warning',
      message: 'That would create a composition loop — this comp is already used inside the one you are inserting.',
      durationMs: 6000,
    });
    return null;
  }
  const refName = defaultSceneGraph.getNode(refCompId)?.name ?? 'Composition';
  const node = makeNode('comp', refName);
  centerInComp(node);
  // The instance composites its expanded content as one unit (precomp path)
  // and carries the reference the renderer expands.
  node.components.push({
    id: `${node.id}_fx`,
    type: 'fx',
    props: { precomp: true, [COMP_REF_PROP]: refCompId },
  });
  defaultSceneGraph.addChild(hostRootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  return node.id;
}

/** Group selected layers into a new Pre-composition folder */
export function precomposeSelected(): void {
  const selectionStore = useSelectionStore.getState();
  const selectedIds = selectionStore.ids;
  if (selectedIds.length === 0) return;

  // Put the precomp where the layers already are — AE replaces them in place.
  // This used to hardcode `getRoots()[0]`, which yanked nested layers up to the
  // root, and now that comps are separate roots would also drop them into
  // whichever composition happens to be first rather than the active one.
  const first = defaultSceneGraph.getNode(selectedIds[0]!);
  const parentId = first?.parent ?? activeCompRootId();

  const preCompNode = makeNode('group', 'Pre-comp 1');
  defaultSceneGraph.addChild(parentId, preCompNode);

  for (const childId of selectedIds) {
    defaultSceneGraph.setParent(childId, preCompNode.id);
  }

  // Flag it a real precomp: its subtree now composites as one unit (group
  // opacity / blend / effects apply to the nested result).
  defaultSceneGraph.setPrecomp(preCompNode.id, true);

  // The moved nodes' clips (trims / splits / positions / markers) follow them
  // into the precomp's own timeline. Without this, the next syncFromScene saw
  // them as orphans of the parent comp and silently deleted every time edit.
  getTimelineController().transferNodeClips(selectedIds, parentId, preCompNode.id);

  selectionStore.set([preCompNode.id]);
  bumpScene();
}

/**
 * Insert an audio layer (Prompt 8). Audio doesn't draw on the canvas — it
 * carries an `Audio` component (asset ref + level/trim), shows a waveform in the
 * inspector, and plays in sync with the transport via the AudioEngine.
 */
export function insertAudio(asset: ImportedAsset): void {
  const rootId = activeCompRootId();
  const duration = asset.metadata?.duration ?? 0;
  const node = makeNode('audio', asset.name);
  const transform = node.components.find((c) => c.type === 'Transform');
  node.components = [
    ...(transform ? [transform] : []),
    {
      id: `${node.id}_a`,
      type: 'Audio',
      // `__`-prefixed so the generic NodeInspector hides them — the dedicated
      // AudioControls section owns editing (level / in-out / mute / waveform).
      props: {
        __assetId: asset.id,
        __src: asset.src,
        __level: 100,
        __start: 0,
        __in: 0,
        __out: duration,
        __duration: duration,
        __muted: false,
      },
    },
  ];
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert an imported media asset (image or video) at native size */
export async function insertMedia(asset: ImportedAsset): Promise<void> {
  const rootId = activeCompRootId();
  if (asset.type === 'audio') {
    insertAudio(asset);
    return;
  }

  // Intercept SVG files and parse them into editable vector shapes
  if (asset.type === 'image' && asset.name.toLowerCase().endsWith('.svg')) {
    try {
      const res = await fetch(asset.src);
      const svgText = await res.text();
      const shapes = parseSvgToShapes(svgText);
      if (shapes.length > 0) {
        // Create a group for the SVG shapes to keep them organized
        const group = makeNode('group', asset.name);
        defaultSceneGraph.addChild(rootId, group);

        const selectionIds: string[] = [];

        for (const s of shapes) {
          const pathId = `shape_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
          const transform = { position: { x: s.centerX, y: s.centerY }, rotation: 0, scale: { x: 1, y: 1 } };
          const components: SceneNode['components'] = [
            {
              id: `${pathId}_t`,
              type: 'Transform',
              props: {
                [SCENE_KIND_PROP]: 'shape',
                x: s.centerX,
                y: s.centerY,
                rotation: 0,
                width: s.width,
                height: s.height,
              },
            },
            {
              id: `${pathId}_s`,
              type: 'Style',
              props: {
                opacity: 100,
                fill: s.fill,
                ...(s.strokeColor ? { stroke: { color: s.strokeColor, width: s.strokeWidth ?? 2, opacity: 1, cap: 'butt', join: 'miter', align: 'center', dash: [] } } : {}),
              },
            },
            {
              id: `${pathId}_g`,
              type: 'Geometry',
              // Open outlines (polyline / line / un-closed paths) must not wrap
              // the last point back to the first at render time.
              props: { points: s.points, ...(s.closed ? {} : { open: true }) },
            },
          ];

          const pathNode: SceneNode = { id: pathId, name: s.name, parent: group.id, children: [], transform, visible: true, locked: false, components };
          defaultSceneGraph.addChild(group.id, pathNode);
          selectionIds.push(pathNode.id);
        }

        useSelectionStore.getState().set([group.id, ...selectionIds]);
        bumpScene();
        return;
      }
    } catch (e) {
      console.error('[sceneInsert] failed to parse SVG asset to vector paths:', e);
      // Fallback to static image insert below on error
    }
  }

  const kind = asset.type === 'video' ? 'video' : 'image';
  const width = asset.metadata?.width ?? 400;
  const height = asset.metadata?.height ?? 400;

  const node = makeNode(kind, asset.name);
  // Add width/height and src/assetId to the transform component props
  const transform = node.components.find(c => c.type === 'Transform');
  if (transform) {
    transform.props.width = width;
    transform.props.height = height;
    transform.props.src = asset.src;
    transform.props.assetId = asset.id;
    // Center it in the REAL composition (was hardcoded to 1080p).
    const comp = useCompositionStore.getState();
    transform.props.x = comp.width / 2;
    transform.props.y = comp.height / 2;
    node.transform.position.x = transform.props.x as number;
    node.transform.position.y = transform.props.y as number;
  }
  
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/**
 * Insert an image SEQUENCE (numbered stills) as one footage layer. Detects play
 * order from the filenames, creates a blob URL per frame, and stores the ordered
 * frame list on the layer's `fx` so buildSnapshot swaps `src` to the frame for
 * the current source time. Returns false if fewer than two numbered files.
 */
export async function insertImageSequence(files: File[], fps = 30): Promise<boolean> {
  if (files.length < 2) return false;
  const detected = detectImageSequence(files.map((f) => f.name));
  if (!detected) return false;
  const byName = new Map(files.map((f) => [f.name, f]));
  const frames: string[] = [];
  for (const n of detected.frames) {
    const f = byName.get(n);
    if (f) frames.push(URL.createObjectURL(f));
  }
  if (frames.length < 2) return false;
  // First frame's native size.
  const dims = await new Promise<{ w: number; h: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.width, h: img.height });
    img.onerror = () => resolve({ w: 400, h: 400 });
    img.src = frames[0]!;
  });
  const rootId = activeCompRootId();
  const node = makeNode('image', detected.base);
  const comp = useCompositionStore.getState();
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.width = dims.w;
    t.props.height = dims.h;
    t.props.src = frames[0];
    t.props.x = comp.width / 2;
    t.props.y = comp.height / 2;
    node.transform.position.x = comp.width / 2;
    node.transform.position.y = comp.height / 2;
  }
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setImageSequence(node.id, { frames, fps });
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  return true;
}

/**
 * Delete all currently selected layers (and their descendants recursively).
 * Locked layers are skipped. Clears the selection after deletion.
 */
export function deleteSelectedLayers(): void {
  const { ids } = useSelectionStore.getState();
  if (ids.length === 0) return;

  // Filter out locked nodes and roots.
  const toDelete = ids.filter((id) => {
    const node = defaultSceneGraph.getNode(id);
    return node && !node.locked && node.parent !== null;
  });
  if (toDelete.length === 0) return;

  for (const id of toDelete) {
    defaultSceneGraph.removeNode(id);
  }
  useSelectionStore.getState().clear();
  bumpScene();
}

/**
 * Duplicate all currently selected layers, offsetting each copy by +20px/+20px
 * (classic AE behaviour). The copies are added adjacent to the originals.
 */
export function duplicateSelectedLayers(): void {
  const { ids } = useSelectionStore.getState();
  if (ids.length === 0) return;

  const newIds: string[] = [];

  for (const id of ids) {
    const original = defaultSceneGraph.getNode(id);
    if (!original || original.parent === null) continue;

    // Deep-clone the node with a new id.
    const dupId = `${id}_dup_${Math.random().toString(36).slice(2, 6)}`;
    const dupComponents = original.components.map((c) => ({
      ...c,
      id: `${dupId}_${c.type}`,
      props: { ...c.props },
    }));

    const dupNode = {
      id: dupId,
      name: `${original.name ?? 'Layer'} copy`,
      parent: null as string | null,
      children: [] as string[],
      transform: {
        position: {
          x: original.transform.position.x + 20,
          y: original.transform.position.y + 20,
        },
        rotation: original.transform.rotation,
        scale: { ...original.transform.scale },
      },
      visible: original.visible,
      locked: false,
      components: dupComponents,
    };

    defaultSceneGraph.addChild(original.parent!, dupNode as Parameters<typeof defaultSceneGraph.addChild>[1]);
    // Apply the x/y offset on the Transform component too.
    const tComp = dupComponents.find((c) => c.type === 'Transform');
    if (tComp && typeof tComp.props.x === 'number') {
      tComp.props.x = (tComp.props.x as number) + 20;
      tComp.props.y = (tComp.props.y as number) + 20;
      defaultSceneGraph.setLocalTransform(dupId, {
        x: tComp.props.x as number,
        y: tComp.props.y as number,
        rotation: (tComp.props.rotation as number) ?? 0,
      });
    }
    newIds.push(dupId);
  }

  if (newIds.length > 0) {
    useSelectionStore.getState().set(newIds);
    bumpScene();
  }
}

// ── Layer actions (operate on the current selection) ──────────────────

/** Wrap the selected layers in a new plain Group and select it. */
export function groupSelectedLayers(): void {
  const sel = useSelectionStore.getState();
  const ids = sel.ids;
  if (ids.length === 0) return;
  // Group in place, like precompose — a selection inside a precomp should not
  // be yanked up to the comp root.
  const first = defaultSceneGraph.getNode(ids[0]!);
  const rootId = first?.parent ?? activeCompRootId();
  const group = makeNode('group', 'Group');
  defaultSceneGraph.addChild(rootId, group);
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (node && node.parent !== null) defaultSceneGraph.setParent(id, group.id);
  }
  sel.set([group.id]);
  bumpScene();
}

/** Dissolve the selected group(s): reparent their children up, remove the group. */
export function ungroupSelected(): void {
  const sel = useSelectionStore.getState();
  const ids = sel.ids;
  if (ids.length === 0) return;
  const rootId = activeCompRootId();
  const freed: string[] = [];
  let changed = false;
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (!node) continue;
    const isGroup = node.components.some((c) => c.props[SCENE_KIND_PROP] === 'group' || c.type === 'group');
    if (!isGroup) continue;
    const parentId = node.parent ?? rootId;
    for (const child of defaultSceneGraph.getChildren(id)) {
      defaultSceneGraph.setParent(child.id, parentId);
      freed.push(child.id);
    }
    defaultSceneGraph.removeNode(id);
    changed = true;
  }
  if (changed) {
    sel.set(freed);
    bumpScene();
  }
}

/** Toggle a boolean layer flag across the whole selection (all follow the
 *  first node's inverse, so one click flips them together). */
function toggleSelectionFlag(flag: 'locked' | 'solo' | 'visible'): void {
  const ids = useSelectionStore.getState().ids;
  if (ids.length === 0) return;
  const first = defaultSceneGraph.getNode(ids[0]!);
  if (!first) return;
  if (flag === 'visible') {
    // hidden = visible:false; flip the whole selection to match !first.
    const newVisible = first.visible === false;
    for (const id of ids) {
      const node = defaultSceneGraph.getNode(id);
      if (node) node.visible = newVisible;
    }
  } else {
    const target = !first[flag];
    for (const id of ids) {
      const node = defaultSceneGraph.getNode(id);
      if (node) node[flag] = target;
    }
  }
  bumpScene();
}

export const toggleSelectedLocked = (): void => toggleSelectionFlag('locked');
export const toggleSelectedSolo = (): void => toggleSelectionFlag('solo');
export const toggleSelectedVisible = (): void => toggleSelectionFlag('visible');

