/**
 * Transition library — real keyframe recipes applied through the animation
 * engine (same write path the inspector and motion presets use, so they are
 * undoable and editable afterwards).
 *
 * Two modes per item:
 *   • LAYER mode — a recipe applied to every selected layer at the playhead.
 *     Each layer recipe has an ENTRANCE and an EXIT variant, and apply picks
 *     the right one per layer from its timeline clip: a clip that ENDS inside
 *     the transition window gets the exit, one that STARTS there (or has no
 *     clip edge nearby) gets the entrance. Recipes are computed from the
 *     layer's CURRENT transform and always land back exactly on that pose
 *     (exits end invisible — opacity 0 — but pose-restored, so re-trimming
 *     the clip never leaves a layer stranded offscreen).
 *   • SOLID mode — with no selection (or for the solid-only wipes) one or
 *     more self-contained full-comp colour solids are inserted whose
 *     choreography covers a cut (directional wipes, venetian bars, iris,
 *     luma flash, dip to black).
 *
 * `transitionRecipe` / `solidRecipe` are PURE (unit-tested); apply/insert are
 * the thin I/O. Two effects beyond plain transforms are wired in apply:
 *   • `@blur` recipe keyframes target a blur effect added to the layer
 *     (`effect.<id>.amount` track — the same track the Effects panel edits);
 *   • whip items flip the layer's per-track motion-blur switch on (renders
 *     when the comp's motion-blur master switch is enabled);
 *   • the iris wipe drives an animated ellipse mask on its solid.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { insertSolid } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { readNodeKind } from '@core/scene/sceneDerive';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import { addEffect, getNodeEffects, effectPropPath } from '@core/effects/effects';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { addMaskPath, setMaskPoints, keyframeMask, ellipseMask, getNodeMask } from '@core/effects/mask';
import { liveKf, type Ease } from '@core/template/templates/builders';

export type TransitionCategory = 'fade' | 'slide' | 'zoom' | 'whip' | 'glitch' | 'wipe';
export type TransitionPhase = 'enter' | 'exit';

export interface TransitionItem {
  id: string;
  name: string;
  cat: TransitionCategory;
  /** Card swatch colours (before / after). */
  a: string;
  b: string;
  /** Recipe duration in seconds. */
  duration: number;
  /** true → always inserts solids (never targets a layer). */
  solidOnly?: boolean;
  /** Number of solids the solid recipe choreographs (default 1). */
  solidCount?: number;
  /** Flip the per-layer motion-blur switch on targeted layers. */
  motionBlur?: boolean;
  /** The solid gets an animated ellipse mask (iris). */
  irisMask?: boolean;
}

export const TRANSITION_ITEMS: readonly TransitionItem[] = [
  { id: 'tr-fade',         name: 'Cross Fade',     cat: 'fade',   a: '#1a1a2e', b: '#8b96b8', duration: 0.5 },
  { id: 'tr-blur-through', name: 'Blur Through',   cat: 'fade',   a: '#3b4a6b', b: '#8b96b8', duration: 0.6 },
  { id: 'tr-dip-black',    name: 'Dip to Black',   cat: 'fade',   a: '#05060a', b: '#05060a', duration: 1.0, solidOnly: true },
  { id: 'tr-luma-flash',   name: 'Luma Flash',     cat: 'fade',   a: '#f4f6fb', b: '#ffffff', duration: 0.5, solidOnly: true },
  { id: 'tr-slide-left',   name: 'Slide Left',     cat: 'slide',  a: '#2988ff', b: '#1a1a2e', duration: 0.6 },
  { id: 'tr-slide-right',  name: 'Slide Right',    cat: 'slide',  a: '#1a1a2e', b: '#2988ff', duration: 0.6 },
  { id: 'tr-slide-up',     name: 'Slide Up',       cat: 'slide',  a: '#10b981', b: '#1a1a2e', duration: 0.6 },
  { id: 'tr-slide-down',   name: 'Slide Down',     cat: 'slide',  a: '#1a1a2e', b: '#10b981', duration: 0.6 },
  { id: 'tr-scale-bounce', name: 'Scale Bounce',   cat: 'zoom',   a: '#f59e0b', b: '#1a1a2e', duration: 0.7 },
  { id: 'tr-zoom-through', name: 'Zoom Through',   cat: 'zoom',   a: '#ec4899', b: '#1a1a2e', duration: 0.6 },
  { id: 'tr-spin-whip',    name: 'Spin Whip',      cat: 'zoom',   a: '#6366f1', b: '#f97316', duration: 0.7 },
  { id: 'tr-whip-pan',     name: 'Whip Pan',       cat: 'whip',   a: '#22d3ee', b: '#0e7490', duration: 0.5, motionBlur: true },
  { id: 'tr-whip-up',      name: 'Whip Vertical',  cat: 'whip',   a: '#0e7490', b: '#22d3ee', duration: 0.5, motionBlur: true },
  { id: 'tr-glitch-cut',   name: 'Glitch Cut',     cat: 'glitch', a: '#fb7185', b: '#22d3ee', duration: 0.5 },
  { id: 'tr-wipe-right',   name: 'Wipe Right',     cat: 'wipe',   a: '#8b5cf6', b: '#38bdf8', duration: 0.8, solidOnly: true },
  { id: 'tr-wipe-left',    name: 'Wipe Left',      cat: 'wipe',   a: '#38bdf8', b: '#8b5cf6', duration: 0.8, solidOnly: true },
  { id: 'tr-wipe-down',    name: 'Wipe Down',      cat: 'wipe',   a: '#14b8a6', b: '#0f766e', duration: 0.8, solidOnly: true },
  { id: 'tr-wipe-up',      name: 'Wipe Up',        cat: 'wipe',   a: '#0f766e', b: '#14b8a6', duration: 0.8, solidOnly: true },
  { id: 'tr-venetian',     name: 'Venetian Bars',  cat: 'wipe',   a: '#fb7185', b: '#1a1a2e', duration: 0.9, solidOnly: true, solidCount: 5 },
  { id: 'tr-iris',         name: 'Iris Circle',    cat: 'wipe',   a: '#05060a', b: '#38bdf8', duration: 0.9, solidOnly: true, irisMask: true },
] as const;

export function getTransitionItem(id: string): TransitionItem | null {
  return TRANSITION_ITEMS.find((t) => t.id === id) ?? null;
}

// ── Pure recipe generation ─────────────────────────────────────────

export interface RecipeKf {
  /** A transform/opacity prop, or the `@blur` sentinel (apply resolves it to
   *  the layer's blur-effect amount track). */
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

const K = (prop: string, t: number, value: number, ease: Ease = 'easeOut'): RecipeKf => ({ prop, t, value, ease });

/**
 * An EXIT built from motion `out` keyframes: the layer performs the outgoing
 * move while fading, then — already invisible — glides back onto its original
 * pose at the very end. The pose-restore invariant holds for every prop, so a
 * re-trimmed clip can never strand the layer offscreen, yet nothing of the
 * return trip is visible (opacity hits 0 well before it).
 */
function exitFrom(pose: LayerPose, d: number, out: RecipeKf[], fadeBy = 0.7): RecipeKf[] {
  const restore: Record<string, number> = {
    x: pose.x, y: pose.y, scaleX: pose.scaleX, scaleY: pose.scaleY, rotation: pose.rotation,
  };
  const props = [...new Set(out.map((k) => k.prop))].filter((p) => p in restore);
  return [
    ...out,
    K('opacity', 0, 100, 'easeIn'),
    K('opacity', d * fadeBy, 0, 'easeIn'),
    ...props.map((p) => K(p, d, restore[p]!, 'linear')),
  ];
}

/**
 * The keyframes a LAYER-mode item writes, relative to the layer's current pose
 * — every recipe ends exactly on the pose it started from (exits end opacity 0,
 * and enter-phase `@blur` ends 0). Returns null for solid-only items.
 */
export function transitionRecipe(id: string, pose: LayerPose, comp: CompBox, phase: TransitionPhase = 'enter'): RecipeKf[] | null {
  const item = getTransitionItem(id);
  if (!item || item.solidOnly) return null;
  const d = item.duration;
  const halfW = (pose.width * Math.abs(pose.scaleX)) / 2;
  const halfH = (pose.height * Math.abs(pose.scaleY)) / 2;
  const offL = -(pose.x + halfW) - 40;           // fully left of frame
  const offR = comp.width - pose.x + halfW + 40; // fully right of frame
  const offU = -(pose.y + halfH) - 40;
  const offD = comp.height - pose.y + halfH + 40;
  const enter = phase === 'enter';

  /** Directional slide with a small settle-overshoot on the way in. */
  const slide = (prop: 'x' | 'y', off: number): RecipeKf[] => {
    const home = prop === 'x' ? pose.x : pose.y;
    if (enter) {
      return [
        K(prop, 0, home + off),
        K(prop, d * 0.78, home - Math.sign(off) * Math.min(24, Math.abs(off) * 0.03)),
        K(prop, d, home, 'easeInOut'),
        K('opacity', 0, 0),
        K('opacity', d * 0.55, 100),
      ];
    }
    return exitFrom(pose, d, [
      K(prop, 0, home, 'easeIn'),
      K(prop, d * 0.8, home + off, 'easeIn'),
    ]);
  };

  switch (id) {
    case 'tr-fade':
      return enter
        ? [K('opacity', 0, 0), K('opacity', d, 100)]
        : [K('opacity', 0, 100, 'easeIn'), K('opacity', d, 0, 'easeIn')];

    case 'tr-blur-through':
      if (enter) {
        return [
          K('@blur', 0, 24),
          K('@blur', d, 0),
          K('scaleX', 0, pose.scaleX * 1.06), K('scaleY', 0, pose.scaleY * 1.06),
          K('scaleX', d, pose.scaleX), K('scaleY', d, pose.scaleY),
          K('opacity', 0, 0), K('opacity', d * 0.45, 100),
        ];
      }
      return exitFrom(pose, d, [
        K('@blur', 0, 0, 'easeIn'), K('@blur', d * 0.85, 24, 'easeIn'),
        K('scaleX', 0, pose.scaleX, 'easeIn'), K('scaleY', 0, pose.scaleY, 'easeIn'),
        K('scaleX', d * 0.85, pose.scaleX * 1.06, 'easeIn'), K('scaleY', d * 0.85, pose.scaleY * 1.06, 'easeIn'),
      ], 0.8);

    case 'tr-slide-left':  return slide('x', offL);
    case 'tr-slide-right': return slide('x', offR);
    case 'tr-slide-up':    return slide('y', offD);
    case 'tr-slide-down':  return slide('y', offU);

    case 'tr-scale-bounce': {
      if (enter) {
        // A real overshoot chain: 0 → 1.12 → 0.95 → 1.03 → 1.
        const beats: Array<[number, number, Ease]> = [
          [0, 0, 'easeOut'], [0.5, 1.12, 'easeOut'], [0.72, 0.95, 'easeInOut'], [0.88, 1.03, 'easeInOut'], [1, 1, 'easeInOut'],
        ];
        return [
          ...beats.flatMap(([f, m, e]) => [
            K('scaleX', d * f, pose.scaleX * m, e),
            K('scaleY', d * f, pose.scaleY * m, e),
          ]),
          K('opacity', 0, 0), K('opacity', d * 0.35, 100),
        ];
      }
      return exitFrom(pose, d, [
        K('scaleX', 0, pose.scaleX, 'easeIn'), K('scaleY', 0, pose.scaleY, 'easeIn'),
        K('scaleX', d * 0.25, pose.scaleX * 1.1, 'easeOut'), K('scaleY', d * 0.25, pose.scaleY * 1.1, 'easeOut'),
        K('scaleX', d * 0.85, 0, 'easeIn'), K('scaleY', d * 0.85, 0, 'easeIn'),
      ], 0.8);
    }

    case 'tr-zoom-through':
      if (enter) {
        return [
          K('scaleX', 0, pose.scaleX * 2.4), K('scaleY', 0, pose.scaleY * 2.4),
          K('scaleX', d, pose.scaleX), K('scaleY', d, pose.scaleY),
          K('opacity', 0, 0), K('opacity', d * 0.5, 100),
        ];
      }
      return exitFrom(pose, d, [
        K('scaleX', 0, pose.scaleX, 'easeIn'), K('scaleY', 0, pose.scaleY, 'easeIn'),
        K('scaleX', d * 0.85, pose.scaleX * 2.6, 'easeIn'), K('scaleY', d * 0.85, pose.scaleY * 2.6, 'easeIn'),
      ]);

    case 'tr-spin-whip':
      if (enter) {
        return [
          K('rotation', 0, pose.rotation - 200),
          K('rotation', d * 0.85, pose.rotation + 6),
          K('rotation', d, pose.rotation, 'easeInOut'),
          K('scaleX', 0, 0), K('scaleY', 0, 0),
          K('scaleX', d, pose.scaleX), K('scaleY', d, pose.scaleY),
          K('opacity', 0, 0), K('opacity', d * 0.45, 100),
        ];
      }
      return exitFrom(pose, d, [
        K('rotation', 0, pose.rotation, 'easeIn'),
        K('rotation', d * 0.85, pose.rotation + 200, 'easeIn'),
        K('scaleX', 0, pose.scaleX, 'easeIn'), K('scaleY', 0, pose.scaleY, 'easeIn'),
        K('scaleX', d * 0.85, 0, 'easeIn'), K('scaleY', d * 0.85, 0, 'easeIn'),
      ], 0.8);

    case 'tr-whip-pan': {
      const throwX = comp.width * 1.2;
      if (enter) {
        return [
          K('x', 0, pose.x - throwX),
          K('x', d * 0.7, pose.x + comp.width * 0.035),
          K('x', d, pose.x, 'easeInOut'),
          K('opacity', 0, 0, 'linear'), K('opacity', d * 0.25, 100, 'linear'),
        ];
      }
      return exitFrom(pose, d, [
        K('x', 0, pose.x, 'easeIn'),
        K('x', d * 0.8, pose.x + throwX, 'easeIn'),
      ], 0.75);
    }

    case 'tr-whip-up': {
      const throwY = comp.height * 1.2;
      if (enter) {
        return [
          K('y', 0, pose.y + throwY),
          K('y', d * 0.7, pose.y - comp.height * 0.035),
          K('y', d, pose.y, 'easeInOut'),
          K('opacity', 0, 0, 'linear'), K('opacity', d * 0.25, 100, 'linear'),
        ];
      }
      return exitFrom(pose, d, [
        K('y', 0, pose.y, 'easeIn'),
        K('y', d * 0.8, pose.y - throwY, 'easeIn'),
      ], 0.75);
    }

    case 'tr-glitch-cut': {
      // Jitter bursts (dense linear keys ≈ hold steps) + opacity flicker.
      const jit = [1, -0.8, 1.2, -0.5, 0.7, -0.3];
      const amp = Math.max(18, comp.width * 0.02);
      const kfs: RecipeKf[] = [];
      jit.forEach((j, i) => {
        const t = d * (0.08 + i * 0.13);
        kfs.push(K('x', t, pose.x + j * amp, 'linear'));
        kfs.push(K('y', t, pose.y - j * amp * 0.4, 'linear'));
        kfs.push(K('opacity', t, i % 2 ? 100 : 45, 'linear'));
      });
      if (enter) {
        return [
          K('x', 0, pose.x, 'linear'), K('y', 0, pose.y, 'linear'),
          K('opacity', 0, 0, 'linear'),
          ...kfs,
          K('x', d, pose.x), K('y', d, pose.y),
          K('opacity', d, 100, 'linear'),
        ];
      }
      return [
        K('x', 0, pose.x, 'linear'), K('y', 0, pose.y, 'linear'),
        K('opacity', 0, 100, 'linear'),
        ...kfs,
        K('x', d, pose.x), K('y', d, pose.y),
        K('opacity', d, 0, 'linear'),
      ];
    }

    default:
      return null;
  }
}

/**
 * The keyframes a SOLID-mode item writes on solid `index` of `count` inserted
 * full-comp solids (both default 0/1 — only Venetian inserts several).
 */
export function solidRecipe(id: string, comp: CompBox, index = 0, count = 1): RecipeKf[] {
  const item = getTransitionItem(id);
  const d = item?.duration ?? 0.8;
  const W = comp.width;
  const H = comp.height;
  switch (id) {
    case 'tr-dip-black':
      return [
        K('opacity', 0, 0, 'easeInOut'),
        K('opacity', d / 2, 100, 'easeInOut'),
        K('opacity', d, 0, 'easeInOut'),
      ];
    case 'tr-luma-flash':
      // A hard white hit that decays slowly — cut under the peak.
      return [
        K('opacity', 0, 0, 'easeOut'),
        K('opacity', d * 0.25, 100, 'easeOut'),
        K('opacity', d, 0, 'easeIn'),
      ];
    case 'tr-wipe-left':
      return [K('x', 0, W, 'easeInOut'), K('x', d / 2, 0, 'easeInOut'), K('x', d, -W, 'easeInOut')];
    case 'tr-wipe-down':
      return [K('y', 0, -H, 'easeInOut'), K('y', d / 2, 0, 'easeInOut'), K('y', d, H, 'easeInOut')];
    case 'tr-wipe-up':
      return [K('y', 0, H, 'easeInOut'), K('y', d / 2, 0, 'easeInOut'), K('y', d, -H, 'easeInOut')];
    case 'tr-venetian': {
      // `count` horizontal bars, each 1/count of the frame tall, sweeping in
      // with a stagger and back out the other side — a real venetian blind.
      const n = Math.max(1, count);
      const barY = (index - (n - 1) / 2) * (H / n);
      const stag = (index % 2 === 0 ? index : n - index) * (d * 0.06);
      const tIn = Math.min(d * 0.45, d * 0.28 + stag);
      const tOut = Math.min(d, d * 0.72 + stag);
      return [
        K('scaleY', 0, 1 / n, 'linear'), K('scaleY', d, 1 / n, 'linear'),
        K('y', 0, barY, 'linear'), K('y', d, barY, 'linear'),
        K('x', 0, -W, 'easeInOut'),
        K('x', tIn, 0, 'easeInOut'),
        K('x', tOut * 0.98, 0, 'easeInOut'),
        K('x', tOut, W * 0.02, 'easeIn'),
        K('x', d, W, 'easeIn'),
      ];
    }
    case 'tr-iris':
      // The reveal itself is the animated ellipse mask (wired in apply);
      // the solid just guards full coverage for the whole window.
      return [K('opacity', 0, 100, 'linear'), K('opacity', d, 100, 'linear')];
    default:
      // Wipe right (also the fallback for layer items with no selection):
      // sweep across the frame covering the cut at the midpoint.
      return [
        K('x', 0, -W, 'easeInOut'),
        K('x', d / 2, 0, 'easeInOut'),
        K('x', d, W, 'easeInOut'),
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

/**
 * Which variant a layer should get, from its timeline clips: a clip edge
 * inside the transition window decides — clip END → exit, clip START →
 * entrance. No edge in the window defaults to entrance.
 */
export function detectPhase(
  clips: ReadonlyArray<{ start: number; end: number }>, startFrame: number, endFrame: number,
): TransitionPhase {
  for (const c of clips) {
    if (c.end > startFrame && c.end <= endFrame) return 'exit';
  }
  for (const c of clips) {
    if (c.start >= startFrame && c.start < endFrame) return 'enter';
  }
  return 'enter';
}

/** Resolve a `@blur` recipe onto a real blur effect's amount track (adds the
 *  effect when the layer has none yet). Returns the track prop path. */
function ensureBlurTrack(nodeId: string): string | null {
  let fx = getNodeEffects(nodeId).find((e) => e.type === 'blur');
  if (!fx) {
    addEffect(nodeId, 'blur');
    fx = getNodeEffects(nodeId).find((e) => e.type === 'blur');
  }
  return fx ? effectPropPath(fx.id, 'amount') : null;
}

export interface ApplyTransitionResult {
  mode: 'layer' | 'solid';
  /** Layers the recipe was keyframed onto, or the inserted solid(s). */
  nodeIds: string[];
  /** Variant chosen per layer (layer mode only). */
  phases?: TransitionPhase[];
}

/**
 * Apply a transition at the playhead. With a selection, layer-mode items
 * keyframe every selected content layer (entrance or exit picked from each
 * layer's clip edges); without one (or for solid-only wipes) choreographed
 * colour solids covering the cut are inserted and selected. Returns null for
 * an unknown id.
 */
export function applyTransitionItem(transId: string): ApplyTransitionResult | null {
  const item = getTransitionItem(transId);
  if (!item) return null;
  const comp = useCompositionStore.getState();
  const box: CompBox = { width: comp.width || 1920, height: comp.height || 1080 };
  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
  const controller = getTimelineController();

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
      const phases: TransitionPhase[] = [];
      for (const nodeId of targets) {
        const pose = readPose(nodeId, box);
        if (!pose) continue;
        const fps = controller.fpsForNode(nodeId);
        const phase = detectPhase(
          controller.getLayersForNode(nodeId),
          Math.round(t0 * fps),
          Math.round((t0 + item.duration) * fps),
        );
        const recipe = transitionRecipe(transId, pose, box, phase);
        if (!recipe) continue;
        let blurTrack: string | null | undefined;
        for (const kf of recipe) {
          let prop = kf.prop;
          if (prop === '@blur') {
            if (blurTrack === undefined) blurTrack = ensureBlurTrack(nodeId);
            if (!blurTrack) continue; // no effect stack → drop blur keys, keep the rest
            prop = blurTrack;
          }
          liveKf(nodeId, prop, t0 + kf.t, kf.value, kf.ease);
        }
        if (item.motionBlur) setNodeMotionBlur(nodeId, true);
        written.push(nodeId);
        phases.push(phase);
      }
      if (written.length > 0) {
        bumpScene();
        return { mode: 'layer', nodeIds: written, phases };
      }
    }
  }

  // Solid mode — insert full-comp solid(s) and choreograph them over the cut.
  const count = item.solidCount ?? 1;
  const solidIds: string[] = [];
  for (let i = 0; i < count; i++) {
    insertSolid(item.a);
    const solidId = useSelectionStore.getState().ids[0];
    if (!solidId) continue;
    const node = defaultSceneGraph.getNode(solidId);
    if (node) node.name = count > 1 ? `${item.name} ${i + 1}` : item.name;
    for (const kf of solidRecipe(transId, box, i, count)) {
      liveKf(solidId, kf.prop, t0 + kf.t, kf.value, kf.ease);
    }
    if (item.irisMask) applyIrisMask(solidId, box, t0, item.duration);
    solidIds.push(solidId);
  }
  if (solidIds.length === 0) return null;
  useSelectionStore.getState().set(solidIds);
  bumpScene();
  return { mode: 'solid', nodeIds: solidIds };
}

/**
 * Iris: an animated ellipse mask on the solid — tiny at the edges of the
 * window, past-full-frame at the midpoint, so the solid irises in over the
 * outgoing shot and irises out to reveal the incoming one.
 */
function applyIrisMask(solidId: string, box: CompBox, t0: number, duration: number): void {
  const small = ellipseMask(12, 12);
  const bigD = Math.hypot(box.width, box.height) * 1.05;
  const big = ellipseMask(bigD, bigD);
  addMaskPath(solidId, small);
  const paths = getNodeMask(solidId).paths;
  const pathId = paths[paths.length - 1]?.id;
  if (!pathId) return;
  const kt = (sec: number): number => compToKeyframeTime(solidId, sec);
  keyframeMask(solidId, kt(t0)); // seed the animation with the tiny circle
  setMaskPoints(solidId, pathId, big.points, kt(t0 + duration / 2));
  setMaskPoints(solidId, pathId, small.points, kt(t0 + duration));
}
