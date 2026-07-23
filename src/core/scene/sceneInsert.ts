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
import type { LightType } from './light';
import { flattenScene, readNodeKind } from './sceneDerive';
import { getTimelineController } from '@core/timeline/TimelineController';
import { COMP_REF_PROP, wouldCreateCompCycle } from './compInstance';
import { DEFAULT_PARTICLE_CONFIG } from '@core/particles/particleSim';
import { detectImageSequence } from '@core/scene/imageSequence';


let seq = 0;

export { activeCompRootId } from './activeComp';
import { activeCompRootId } from './activeComp';

/** Build a fresh scene node of `kind` with sensible default components. */
export function makeNode(kind: SceneKind, name: string): SceneNode {
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
                width: 280,
                height: 280,
              },
            },
            { id: `${id}_m`, type: 'group', props: { [SCENE_KIND_PROP]: kind } },
          ]
        : kind === 'image' || kind === 'video'
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
                width: 100,
                height: 100,
              },
            },
            { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
          ]
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

import { useInfoStore } from '@stores/infoStore';

/**
 * Places an inserted node under the active pointer cursor (or comp center if off-canvas),
 * and assigns a prominent, scene-proportional width/height/fontSize so elements are
 * visibly clear, large, and easy to edit across any composition resolution (HD, 4K, Reel, etc.).
 */
export function placeInComp(
  node: SceneNode,
  opts?: { customW?: number; customH?: number; customFontSize?: number }
): void {
  const activeTabId = useProjectStore.getState().activeTabId;
  const activeTab = useProjectStore.getState().tabs[activeTabId ?? ''];
  const compId = activeTab?.compositionId ?? 'comp_root';
  const comp = useProjectStore.getState().comps[compId] ?? useCompositionStore.getState();

  // Target size ~28% of shorter comp edge (min 240px, max 960px)
  const compMinDim = Math.min(comp.width, comp.height);
  const targetSize = Math.max(240, Math.min(960, Math.round(compMinDim * 0.28)));

  let width = opts?.customW && opts.customW > 0 ? opts.customW : targetSize;
  let height = opts?.customH && opts.customH > 0 ? opts.customH : targetSize;

  // Scale up small custom dimensions (e.g. 24px - 180px) so elements match scene scale
  if (width < 220 && height < 220) {
    const aspect = (width / height) || 1;
    if (aspect >= 1) {
      width = targetSize;
      height = Math.round(targetSize / aspect);
    } else {
      height = targetSize;
      width = Math.round(targetSize * aspect);
    }
  }

  const info = useInfoStore.getState();
  const px = info.present ? info.x : comp.width / 2;
  const py = info.present ? info.y : comp.height / 2;

  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = px;
    t.props.y = py;
    t.props.width = width;
    t.props.height = height;
  }

  const textComp = node.components.find((c) => c.type === 'Text');
  if (textComp) {
    const proportionalFontSize = opts?.customFontSize || Math.max(48, Math.round(comp.height * 0.065));
    textComp.props.fontSize = proportionalFontSize;
  }

  node.transform.position.x = px;
  node.transform.position.y = py;
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

/**
 * Insert an SVG as ONE editable, movable icon: a group of shape/text layers,
 * scaled to a comfortable size and centered (or dropped at x/y), with the parts
 * positioned RELATIVE to the group so it behaves as a single body. Only the
 * GROUP is selected, so a drag moves the whole thing (mirrors the cursor lib).
 *
 * Returns the new group id, or null when the SVG has no vector geometry (caller
 * should fall back to a faithful image).
 */
export function insertSvgShapeGroup(
  svgText: string,
  name: string,
  opts?: { x?: number; y?: number; targetSize?: number },
): string | null {
  const shapes = parseSvgToShapes(svgText);
  if (shapes.length === 0) return null;

  const rootId = activeCompRootId();
  const comp = useCompositionStore.getState();
  const info = useInfoStore.getState();
  const px = opts?.x ?? (info.present ? info.x : comp.width / 2);
  const py = opts?.y ?? (info.present ? info.y : comp.height / 2);

  // Union bounding box of every part (SVG user space) → overall center + size.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    minX = Math.min(minX, s.centerX - s.width / 2);
    minY = Math.min(minY, s.centerY - s.height / 2);
    maxX = Math.max(maxX, s.centerX + s.width / 2);
    maxY = Math.max(maxY, s.centerY + s.height / 2);
  }
  const svgCx = (minX + maxX) / 2;
  const svgCy = (minY + maxY) / 2;
  const svgW = Math.max(1, maxX - minX);
  const svgH = Math.max(1, maxY - minY);

  // Scale so UI components and SVG groups land at a prominent, scene-proportional size.
  const compMinDim = Math.min(comp.width, comp.height);
  const proportionalTarget = Math.max(280, Math.min(960, Math.round(compMinDim * 0.32)));
  const target = opts?.targetSize ? Math.max(opts.targetSize, proportionalTarget) : proportionalTarget;
  const k = target / Math.max(svgW, svgH);

  const group = makeNode('group', name);
  group.transform.position.x = px;
  group.transform.position.y = py;
  defaultSceneGraph.addChild(rootId, group);

  for (const s of shapes) {
    const pathId = `shape_${(seq += 1)}_${Math.random().toString(36).slice(2, 6)}`;
    // Part offset from the group center, scaled — keeps every part in register.
    const relX = (s.centerX - svgCx) * k;
    const relY = (s.centerY - svgCy) * k;
    const transform = { position: { x: relX, y: relY }, rotation: 0, scale: { x: 1, y: 1 } };

    if (s.textContent) {
      const components: SceneNode['components'] = [
        { id: `${pathId}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text', x: relX, y: relY, rotation: 0, width: s.width * k, height: s.height * k } },
        { id: `${pathId}_txt`, type: 'Text', props: { content: s.textContent, fontSize: (s.fontSize ?? 14) * k, fill: s.fill && s.fill !== 'none' ? s.fill : '#ffffff', opacity: 100 } },
      ];
      defaultSceneGraph.addChild(group.id, { id: pathId, name: s.name, parent: group.id, children: [], transform, visible: true, locked: false, components });
    } else {
      const scaledPoints = s.points.map((p) => ({ x: p.x * k, y: p.y * k, inX: p.inX * k, inY: p.inY * k, outX: p.outX * k, outY: p.outY * k }));
      const components: SceneNode['components'] = [
        { id: `${pathId}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: relX, y: relY, rotation: 0, width: s.width * k, height: s.height * k } },
        {
          id: `${pathId}_s`,
          type: 'Style',
          props: {
            opacity: 100,
            fill: s.fill,
            ...(s.strokeColor ? { stroke: { color: s.strokeColor, width: (s.strokeWidth ?? 2) * k, opacity: 1, cap: 'butt', join: 'miter', align: 'center', dash: [] } } : {}),
          },
        },
        { id: `${pathId}_g`, type: 'Geometry', props: { points: scaledPoints, ...(s.closed ? {} : { open: true }) } },
      ];
      defaultSceneGraph.addChild(group.id, { id: pathId, name: s.name, parent: group.id, children: [], transform, visible: true, locked: false, components });
    }
  }

  // Select ONLY the group — the icon is one selectable/movable body.
  useSelectionStore.getState().set([group.id]);
  bumpScene();
  return group.id;
}

/** Insert a primitive at the composition root, select it, and refresh the UI. */
export function insertPrimitive(kind: SceneKind, name: string): void {
  const rootId = activeCompRootId();
  const node = makeNode(kind, name);
  placeInComp(node);
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
export function insertShape(shape: ShapeKind, name: string, pos?: { x: number; y: number }): void {
  const rootId = activeCompRootId();
  const node = makeNode('shape', name);
  placeInComp(node);

  const transform = node.components.find((c) => c.type === 'Transform');
  const W = (transform?.props.width as number) || 280;
  const H = (transform?.props.height as number) || 280;

  if (transform) {
    transform.props.width = W;
    transform.props.height = H;
    transform.props.shapeType = shape;
    if (pos) {
      transform.props.x = Math.round(pos.x);
      transform.props.y = Math.round(pos.y);
    }
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
  placeInComp(node, { customFontSize: fontSize > 36 ? fontSize : undefined });
  if (extraProps.pos) {
    const t = node.components.find((c) => c.type === 'Transform');
    if (t) {
      t.props.x = Math.round(extraProps.pos.x);
      t.props.y = Math.round(extraProps.pos.y);
    }
  }
  const text = node.components.find((c) => c.type === 'Text');
  if (text) {
    text.props.content = name;
    text.props.fontSize = fontSize;
    text.props.fontWeight = fontWeight;
    // Map extraProps onto Text component props
    for (const [key, value] of Object.entries(extraProps)) {
      if (key !== 'fill' && key !== 'pos') {
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

/** Optional seed params for {@link insertCamera} (AE New Camera dialog).
 *  Every field defaults to the legacy silent-insert behavior. */
export interface CameraSeed {
  name?: string;
  /** Focal length in comp px (see Project3D / CameraSection). */
  focalLength?: number;
  /** Two-node camera: seed a Point of Interest at the comp centre. */
  twoNode?: boolean;
}

/** Insert a Camera layer, centred on the REAL comp and pulled back by its focal
 *  length so the comp plane renders 1:1. Position / z / focalLength are plain
 *  editable + keyframeable props (the inspector shows them automatically). */
export function insertCamera(seed: CameraSeed = {}): void {
  const rootId = activeCompRootId();
  const node = makeNode('camera', seed.name?.trim() || 'Camera 1');
  const compSize = useCompositionStore.getState();
  const cam = Project3D.defaultCamera(compSize.width, compSize.height);
  const focal = typeof seed.focalLength === 'number' && seed.focalLength > 0 ? seed.focalLength : cam.focalLength;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    // Seeded before the node enters the graph, so these become its base props.
    // z = -focalLength keeps the comp plane 1:1 for ANY chosen lens.
    t.props.x = cam.position.x;
    t.props.y = cam.position.y;
    t.props.z = -focal;
    t.props.focalLength = focal;
    if (seed.twoNode) {
      // Two-node camera: an explicit Point of Interest the camera looks at.
      t.props.poiX = compSize.width / 2;
      t.props.poiY = compSize.height / 2;
      t.props.poiZ = 0;
    }
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

/** Optional seed params for {@link insertLight} (AE New Light dialog).
 *  Every field defaults to the legacy silent-insert behavior. */
export interface LightSeed {
  name?: string;
  /** Light kind (see readNodeLight): point (default), spot, parallel, ambient. */
  type?: LightType;
  /** Light colour (hex) — stored on Style.fill. */
  color?: string;
  /** Brightness percent (default 100). */
  intensity?: number;
  /** Spot only: full cone width, degrees. */
  coneAngle?: number;
  /** Cast 2.5D drop-shadows from this light. */
  castShadows?: boolean;
}

/** Insert a Light layer */
export function insertLight(seed: LightSeed = {}): void {
  const rootId = activeCompRootId();
  const node = makeNode('light', seed.name?.trim() || 'Light 1');
  const compSize = useCompositionStore.getState();
  // Seed position + keyframeable intensity/radius; warm colour via Style.fill.
  // Radius scales with the comp so the glow reads on any size (a fixed 500px
  // was easy to miss on a 1920-wide comp over bright content).
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = compSize.width / 2;
    t.props.y = compSize.height / 2;
    t.props.intensity = typeof seed.intensity === 'number' ? seed.intensity : 100;
    t.props.radius = Math.round(Math.max(compSize.width, compSize.height) * 0.45);
    // Only write the optional props when chosen — an unseeded light keeps the
    // exact prop shape it always had (readNodeLight defaults cover the rest).
    if (seed.type && seed.type !== 'point') t.props.lightType = seed.type;
    if (seed.type === 'spot' && typeof seed.coneAngle === 'number') t.props.lightCone = seed.coneAngle;
    if (seed.castShadows) t.props.castShadows = true;
  }
  const s = node.components.find((c) => c.type === 'Style');
  if (s) s.props.fill = seed.color ?? '#fff3c0';
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/** Insert a 3D Parametric Primitive Mesh layer (AE 3D Design Space). */
export function insert3DPrimitive(type: 'cube' | 'sphere' | 'plane' | 'cylinder' = 'cube'): void {
  const rootId = activeCompRootId();
  const label = type === 'cube' ? '3D Cube' : type === 'sphere' ? '3D Sphere' : type === 'cylinder' ? '3D Cylinder' : '3D Plane';
  const node = makeNode('shape', label);
  const compSize = useCompositionStore.getState();
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = compSize.width / 2;
    t.props.y = compSize.height / 2;
    t.props.z = 0;
    t.props.rotationX = 0;
    t.props.rotationY = 0;
    t.props.width = 240;
    t.props.height = 240;
    t.props.primitiveType = type;
    t.props.castsShadows = true;
    t.props.acceptsLights = true;
    // Real extruded geometry: a Cube is a square extruded by its side length;
    // a Cylinder is an extruded ellipse (segmented side wall). Spheres stay
    // flat until real curved meshes exist. See buildSnapshot's extrusion pass.
    if (type === 'cube' || type === 'cylinder') t.props.extrusionDepth = 240;
    if (type === 'cylinder') t.props.shapeType = 'ellipse';
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  useUIStore.getState().notify({
    level: 'info',
    message: `${label} added to 3D Design Space`,
    durationMs: 3000,
  });
}
/** Insert a 3D Extruded Text layer pre-configured with solid contour volume extrusion. */
export function insert3DText(textLabel = '3D TEXT'): void {
  const rootId = activeCompRootId();
  const node = makeNode('text', textLabel);
  placeInComp(node, { customFontSize: 64 });
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.z = 0;
    t.props.rotationX = 0;
    t.props.rotationY = 0;
    t.props.is3D = true;
    t.props.extrusionDepth = 35;
    t.props.bevelDepth = 4;
    t.props.castsShadows = true;
    t.props.acceptsLights = true;
  }
  const textComp = node.components.find((c) => c.type === 'Text');
  if (textComp) {
    textComp.props.content = textLabel;
    textComp.props.fontSize = 64;
    textComp.props.fontWeight = 700;
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  useUIStore.getState().notify({
    level: 'info',
    message: '3D Extruded Text added to scene',
    durationMs: 3000,
  });
}

/** Insert a Particle emitter layer, positioned at the comp centre with a
 *  ready-to-play default fountain. The emitter follows the layer's transform. */
export function insertParticle(): void {
  const rootId = activeCompRootId();
  const node = makeNode('particle', 'Particles 1');
  const compSize = useCompositionStore.getState();
  const w = compSize.width || 1920;
  const h = compSize.height || 1080;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    t.props.x = w / 2;
    t.props.y = h / 2;
    t.props.width = w;
    t.props.height = h;
    t.props.anchorX = w / 2;
    t.props.anchorY = h / 2;
  }
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setParticle(node.id, {
    ...DEFAULT_PARTICLE_CONFIG,
    emitterWidth: Math.round(w * 0.5),
    emitterHeight: Math.round(h * 0.5),
  });
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
  placeInComp(node);
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

  // SVG routing (fidelity + editability, picking the right one automatically):
  //
  //  • SIMPLE SVGs (only flat-filled basic geometry) → editable vector shapes.
  //    These convert losslessly, so the user gets crisp, fully customizable,
  //    resolution-independent layers.
  //  • COMPLEX SVGs (gradients, text, embedded raster, <use>, filters, masks…)
  //    → faithful IMAGE. `parseSvgToShapes` can't reproduce those — it used to
  //    silently drop them and turn `url(#gradient)` fills into garbage (the
  //    "crashed" SVG). The renderer rasterizes the image faithfully instead
  //    (high-resolution, see AppTextureProvider).
  // SVG Assets: Insert as a unified, high-fidelity vector image layer.
  // This renders all SVG gradients, styles, clip-paths, and text 100% pixel-perfect
  // while ensuring the SVG icon moves as ONE solid, unbroken body on canvas.
  const kind = asset.type === 'video' ? 'video' : 'image';
  const width = asset.metadata?.width ?? 400;
  const height = asset.metadata?.height ?? 400;

  const node = makeNode(kind, asset.name);
  const transform = node.components.find(c => c.type === 'Transform');
  if (transform) {
    transform.props.src = asset.src;
    transform.props.assetId = asset.id;
  }
  placeInComp(node, { customW: width, customH: height });
  
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
}

/**
 * Insert a standalone image layer from a ready `src` (e.g. a UI Kit component's
 * inline SVG data URL). No ImportedAsset / asset library entry — the src is
 * stored directly on the layer, so it must be self-contained (a data URL) to
 * survive reload. Returns the new node id.
 */
export function insertImageNode(opts: {
  name: string;
  src: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
}): string {
  const rootId = activeCompRootId();
  const node = makeNode('image', opts.name);
  const transform = node.components.find((c) => c.type === 'Transform');
  if (transform) {
    transform.props.src = opts.src;
  }
  placeInComp(node, { customW: opts.width, customH: opts.height });
  if (opts.x !== undefined) {
    if (transform) transform.props.x = opts.x;
    node.transform.position.x = opts.x;
  }
  if (opts.y !== undefined) {
    if (transform) transform.props.y = opts.y;
    node.transform.position.y = opts.y;
  }
  defaultSceneGraph.addChild(rootId, node);
  useSelectionStore.getState().set([node.id]);
  bumpScene();
  return node.id;
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

/**
 * Group the currently selected nodes into a single master group body.
 */
export function groupSelectedNodes(groupName = 'Group Assembly'): string | null {
  const selection = useSelectionStore.getState().ids;
  if (selection.length === 0) return null;

  const rootId = activeCompRootId();
  const nodes = selection.map((id) => defaultSceneGraph.getNode(id)).filter((n): n is SceneNode => Boolean(n));
  if (nodes.length === 0) return null;

  // Calculate center of selected nodes
  let sumX = 0, sumY = 0;
  for (const n of nodes) {
    sumX += n.transform.position.x;
    sumY += n.transform.position.y;
  }
  const groupX = Math.round(sumX / nodes.length);
  const groupY = Math.round(sumY / nodes.length);

  const group = makeNode('group', groupName);
  const tComp = group.components.find((c) => c.type === 'Transform');
  if (tComp) {
    tComp.props.x = groupX;
    tComp.props.y = groupY;
  }
  group.transform.position.x = groupX;
  group.transform.position.y = groupY;

  defaultSceneGraph.addChild(rootId, group);

  // Re-parent selected nodes under the new group, offsetting position relative to group center
  for (const n of nodes) {
    defaultSceneGraph.setParent(n.id, group.id);
    const relX = n.transform.position.x - groupX;
    const relY = n.transform.position.y - groupY;
    n.transform.position.x = relX;
    n.transform.position.y = relY;
    const t = n.components.find((c) => c.type === 'Transform');
    if (t) {
      t.props.x = relX;
      t.props.y = relY;
    }
  }

  useSelectionStore.getState().set([group.id]);
  bumpScene();
  return group.id;
}

/**
 * Ungroup / Detach a group node into standalone sub-layers.
 */
export function ungroupSelectedNode(targetId?: string): string[] {
  const selection = targetId ? [targetId] : useSelectionStore.getState().ids;
  const newSelection: string[] = [];

  for (const id of selection) {
    const groupNode = defaultSceneGraph.getNode(id);
    if (!groupNode) continue;
    const children = defaultSceneGraph.getChildren(groupNode.id);
    if (children.length === 0) continue;

    const rootId = activeCompRootId();
    const gx = groupNode.transform.position.x;
    const gy = groupNode.transform.position.y;

    for (const child of children) {
      defaultSceneGraph.setParent(child.id, rootId);
      const absX = child.transform.position.x + gx;
      const absY = child.transform.position.y + gy;
      child.transform.position.x = absX;
      child.transform.position.y = absY;
      const t = child.components.find((c) => c.type === 'Transform');
      if (t) {
        t.props.x = absX;
        t.props.y = absY;
      }
      newSelection.push(child.id);
    }

    defaultSceneGraph.removeNode(groupNode.id);
  }

  if (newSelection.length > 0) {
    useSelectionStore.getState().set(newSelection);
    bumpScene();
  }
  return newSelection;
}
