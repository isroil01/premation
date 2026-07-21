/**
 * Transition library — real keyframe recipes applied through the animation
 * engine (same write path the inspector and motion presets use, so they are
 * undoable and editable afterwards).
 *
 * Two modes per item:
 *   • LAYER mode — a recipe applied to every selected layer at the playhead
 *     (fade / slide-from-offscreen / scale pop / spin), computed from the
 *     layer's CURRENT transform so it always lands back exactly where it was.
 *   • SOLID mode — with no selection (or for the solid-only wipes) a
 *     self-contained full-comp colour solid is inserted whose choreography
 *     covers a cut (sweep across / dip to black).
 *
 * `transitionRecipe` is PURE (unit-tested); apply/insert are the thin I/O.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertSolid } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { readNodeKind } from '@core/scene/sceneDerive';
import { liveKf, type Ease } from '@core/template/templates/builders';

export type TransitionCategory = 'fade' | 'slide' | 'zoom' | 'wipe';

export interface TransitionItem {
  id: string;
  name: string;
  cat: TransitionCategory;
  /** Card swatch colours (before / after). */
  a: string;
  b: string;
  /** Recipe duration in seconds. */
  duration: number;
  /** true → always inserts a solid (never targets a layer). */
  solidOnly?: boolean;
}

export const TRANSITION_ITEMS: readonly TransitionItem[] = [
  { id: 'tr-fade-in',     name: 'Fade In',        cat: 'fade',  a: '#1a1a2e', b: '#8b96b8', duration: 0.5 },
  { id: 'tr-fade-out',    name: 'Fade Out',       cat: 'fade',  a: '#8b96b8', b: '#1a1a2e', duration: 0.5 },
  { id: 'tr-dip-black',   name: 'Dip to Black',   cat: 'fade',  a: '#05060a', b: '#05060a', duration: 1.0, solidOnly: true },
  { id: 'tr-slide-left',  name: 'Slide In Left',  cat: 'slide', a: '#2988ff', b: '#1a1a2e', duration: 0.6 },
  { id: 'tr-slide-right', name: 'Slide In Right', cat: 'slide', a: '#1a1a2e', b: '#2988ff', duration: 0.6 },
  { id: 'tr-slide-up',    name: 'Slide In Up',    cat: 'slide', a: '#10b981', b: '#1a1a2e', duration: 0.6 },
  { id: 'tr-slide-down',  name: 'Slide In Down',  cat: 'slide', a: '#1a1a2e', b: '#10b981', duration: 0.6 },
  { id: 'tr-scale-pop',   name: 'Scale Pop',      cat: 'zoom',  a: '#f59e0b', b: '#1a1a2e', duration: 0.6 },
  { id: 'tr-zoom-out',    name: 'Zoom Out',       cat: 'zoom',  a: '#ec4899', b: '#1a1a2e', duration: 0.6 },
  { id: 'tr-spin-in',     name: 'Spin In',        cat: 'zoom',  a: '#6366f1', b: '#f97316', duration: 0.7 },
  { id: 'tr-wipe-color',  name: 'Colour Wipe',    cat: 'wipe',  a: '#8b5cf6', b: '#38bdf8', duration: 0.8, solidOnly: true },
  { id: 'tr-wipe-split',  name: 'Split Wipe',     cat: 'wipe',  a: '#14b8a6', b: '#fb7185', duration: 0.8, solidOnly: true },
] as const;

export function getTransitionItem(id: string): TransitionItem | null {
  return TRANSITION_ITEMS.find((t) => t.id === id) ?? null;
}

// ── Pure recipe generation ─────────────────────────────────────────

export interface RecipeKf {
  prop: string;
  /** Seconds relative to the transition start. */
  t: number;
  value: number;
  ease: Ease;
}

export interface LayerPose {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  width: number;
  height: number;
}

export interface CompBox {
  width: number;
  height: number;
}

/**
 * The keyframes a LAYER-mode item writes, relative to the layer's current pose
 * — every recipe ends exactly on the pose it started from. Returns null for
 * solid-only items.
 */
export function transitionRecipe(id: string, pose: LayerPose, comp: CompBox): RecipeKf[] | null {
  const item = getTransitionItem(id);
  if (!item || item.solidOnly) return null;
  const d = item.duration;
  const halfW = (pose.width * Math.abs(pose.scaleX)) / 2;
  const halfH = (pose.height * Math.abs(pose.scaleY)) / 2;
  const offL = -(pose.x + halfW) - 40;         // fully left of frame
  const offR = comp.width - pose.x + halfW + 40; // fully right of frame
  const offU = -(pose.y + halfH) - 40;
  const offD = comp.height - pose.y + halfH + 40;

  switch (id) {
    case 'tr-fade-in':
      return [
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d, value: 100, ease: 'easeOut' },
      ];
    case 'tr-fade-out':
      return [
        { prop: 'opacity', t: 0, value: 100, ease: 'easeIn' },
        { prop: 'opacity', t: d, value: 0, ease: 'easeIn' },
      ];
    case 'tr-slide-left':
      return [
        { prop: 'x', t: 0, value: pose.x + offL, ease: 'easeOut' },
        { prop: 'x', t: d, value: pose.x, ease: 'easeOut' },
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d * 0.6, value: 100, ease: 'easeOut' },
      ];
    case 'tr-slide-right':
      return [
        { prop: 'x', t: 0, value: pose.x + offR, ease: 'easeOut' },
        { prop: 'x', t: d, value: pose.x, ease: 'easeOut' },
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d * 0.6, value: 100, ease: 'easeOut' },
      ];
    case 'tr-slide-up':
      return [
        { prop: 'y', t: 0, value: pose.y + offD, ease: 'easeOut' },
        { prop: 'y', t: d, value: pose.y, ease: 'easeOut' },
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d * 0.6, value: 100, ease: 'easeOut' },
      ];
    case 'tr-slide-down':
      return [
        { prop: 'y', t: 0, value: pose.y + offU, ease: 'easeOut' },
        { prop: 'y', t: d, value: pose.y, ease: 'easeOut' },
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d * 0.6, value: 100, ease: 'easeOut' },
      ];
    case 'tr-scale-pop':
      return [
        { prop: 'scaleX', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'scaleY', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'scaleX', t: d * 0.65, value: pose.scaleX * 1.15, ease: 'easeOut' },
        { prop: 'scaleY', t: d * 0.65, value: pose.scaleY * 1.15, ease: 'easeOut' },
        { prop: 'scaleX', t: d, value: pose.scaleX, ease: 'easeInOut' },
        { prop: 'scaleY', t: d, value: pose.scaleY, ease: 'easeInOut' },
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d * 0.4, value: 100, ease: 'easeOut' },
      ];
    case 'tr-zoom-out':
      return [
        { prop: 'scaleX', t: 0, value: pose.scaleX * 2.4, ease: 'easeOut' },
        { prop: 'scaleY', t: 0, value: pose.scaleY * 2.4, ease: 'easeOut' },
        { prop: 'scaleX', t: d, value: pose.scaleX, ease: 'easeOut' },
        { prop: 'scaleY', t: d, value: pose.scaleY, ease: 'easeOut' },
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d * 0.5, value: 100, ease: 'easeOut' },
      ];
    case 'tr-spin-in':
      return [
        { prop: 'rotation', t: 0, value: pose.rotation - 200, ease: 'easeOut' },
        { prop: 'rotation', t: d, value: pose.rotation, ease: 'easeOut' },
        { prop: 'scaleX', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'scaleY', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'scaleX', t: d, value: pose.scaleX, ease: 'easeOut' },
        { prop: 'scaleY', t: d, value: pose.scaleY, ease: 'easeOut' },
        { prop: 'opacity', t: 0, value: 0, ease: 'easeOut' },
        { prop: 'opacity', t: d * 0.45, value: 100, ease: 'easeOut' },
      ];
    default:
      return null;
  }
}

/** The keyframes a SOLID-mode item writes on its inserted full-comp solid. */
export function solidRecipe(id: string, comp: CompBox): RecipeKf[] {
  const item = getTransitionItem(id);
  const d = item?.duration ?? 0.8;
  const W = comp.width;
  switch (id) {
    case 'tr-wipe-split':
      // One solid sweeping in from the left and straight out the right —
      // paired with a duplicate (offset by the user) it reads as a split.
      return [
        { prop: 'x', t: 0, value: -W, ease: 'easeInOut' },
        { prop: 'x', t: d / 2, value: 0, ease: 'easeInOut' },
        { prop: 'x', t: d, value: W, ease: 'easeInOut' },
        { prop: 'scaleY', t: 0, value: 0.5, ease: 'linear' },
        { prop: 'scaleY', t: d, value: 0.5, ease: 'linear' },
      ];
    case 'tr-dip-black':
      return [
        { prop: 'opacity', t: 0, value: 0, ease: 'easeInOut' },
        { prop: 'opacity', t: d / 2, value: 100, ease: 'easeInOut' },
        { prop: 'opacity', t: d, value: 0, ease: 'easeInOut' },
      ];
    default:
      // Colour wipe (also the fallback for layer items with no selection):
      // sweep across the frame covering the cut at the midpoint.
      return [
        { prop: 'x', t: 0, value: -W, ease: 'easeInOut' },
        { prop: 'x', t: d / 2, value: 0, ease: 'easeInOut' },
        { prop: 'x', t: d, value: W, ease: 'easeInOut' },
      ];
  }
}

// ── Apply against the live scene ───────────────────────────────────

function readPose(nodeId: string, comp: CompBox): LayerPose | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const t = node.components.find((c) => c.type === 'Transform');
  return {
    x: (t?.props.x as number) ?? node.transform.position.x ?? comp.width / 2,
    y: (t?.props.y as number) ?? node.transform.position.y ?? comp.height / 2,
    scaleX: (t?.props.scaleX as number) ?? node.transform.scale.x ?? 1,
    scaleY: (t?.props.scaleY as number) ?? node.transform.scale.y ?? 1,
    rotation: (t?.props.rotation as number) ?? node.transform.rotation ?? 0,
    width: (t?.props.width as number) ?? 100,
    height: (t?.props.height as number) ?? 100,
  };
}

export interface ApplyTransitionResult {
  mode: 'layer' | 'solid';
  /** Layers the recipe was keyframed onto, or the inserted solid. */
  nodeIds: string[];
}

/**
 * Apply a transition at the playhead. With a selection, layer-mode items
 * keyframe every selected content layer; without one (or for solid-only wipes)
 * a colour solid carrying the sweep is inserted and selected. Returns null for
 * an unknown id.
 */
export function applyTransitionItem(transId: string): ApplyTransitionResult | null {
  const item = getTransitionItem(transId);
  if (!item) return null;
  const comp = useCompositionStore.getState();
  const box: CompBox = { width: comp.width || 1920, height: comp.height || 1080 };
  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;

  if (!item.solidOnly) {
    // Content layers only — cameras/lights/audio have no visual transition.
    const targets = useSelectionStore.getState().ids.filter((id) => {
      const n = defaultSceneGraph.getNode(id);
      if (!n) return false;
      const k = readNodeKind(n);
      return k !== 'camera' && k !== 'light' && k !== 'audio';
    });
    if (targets.length > 0) {
      const written: string[] = [];
      for (const nodeId of targets) {
        const pose = readPose(nodeId, box);
        if (!pose) continue;
        const recipe = transitionRecipe(transId, pose, box);
        if (!recipe) continue;
        for (const kf of recipe) liveKf(nodeId, kf.prop, t0 + kf.t, kf.value, kf.ease);
        written.push(nodeId);
      }
      if (written.length > 0) {
        bumpScene();
        return { mode: 'layer', nodeIds: written };
      }
    }
  }

  // Solid mode — insert a full-comp solid and choreograph it over the cut.
  insertSolid(item.a);
  const solidId = useSelectionStore.getState().ids[0];
  if (!solidId) return null;
  const node = defaultSceneGraph.getNode(solidId);
  if (node) node.name = item.name;
  for (const kf of solidRecipe(transId, box)) liveKf(solidId, kf.prop, t0 + kf.t, kf.value, kf.ease);
  bumpScene();
  return { mode: 'solid', nodeIds: [solidId] };
}
