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
import { makeNode } from '@core/scene/sceneInsert';
import { activeCompRootId } from '@core/scene/activeComp';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readGeometry } from '@core/workspace/geometry';
import type { SceneNode } from '@core/types';
import { getTimelineController, compToKeyframeTime } from '@core/timeline/TimelineController';
import { addEffect, getNodeEffects, effectPropPath } from '@core/effects/effects';
import { setNodeMotionBlur } from '@core/effects/motionBlur';
import { addMaskPath, setMaskPoints, keyframeMask, ellipseMask, getNodeMask } from '@core/effects/mask';
import { liveKf, addRoot, addShape, type Ease } from '@core/template/templates/builders';
import { mountPreview } from '@core/template/previewController';
import { previewChoreography } from './insertPreview';

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
  { id: 'tr-slide-diag',   name: 'Diagonal Slide', cat: 'slide',  a: '#a78bfa', b: '#1a1a2e', duration: 0.7 },
  { id: 'tr-drop-settle',  name: 'Drop & Settle',  cat: 'slide',  a: '#facc15', b: '#1a1a2e', duration: 0.8 },
  { id: 'tr-flip-card',    name: 'Card Flip',      cat: 'zoom',   a: '#34d399', b: '#1a1a2e', duration: 0.65 },
  { id: 'tr-shake-cut',    name: 'Shake Cut',      cat: 'glitch', a: '#f87171', b: '#1a1a2e', duration: 0.45, motionBlur: true },
  { id: 'tr-columns',      name: 'Column Wipe',    cat: 'wipe',   a: '#c084fc', b: '#1a1a2e', duration: 0.9, solidOnly: true, solidCount: 6 },
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
  /** The animated value — what a recipe restores to. */
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  width: number;
  height: number;
  /**
   * Where the layer APPEARS, relative to `x`/`y`. Zero for an ordinary layer,
   * whose box is centred on its own position; non-zero for a group, which sits
   * at its origin while its content is somewhere else entirely. Only the
   * off-frame targets consult this — the restore targets stay `x`/`y`, or a
   * group would be teleported onto its own content's centre.
   */
  offsetX?: number;
  offsetY?: number;
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
  // These are DISPLACEMENTS added to the animated value (`home + off`), so the
  // frame edges have to be measured from where the layer APPEARS — its own
  // position plus the content offset. For an ordinary layer the offset is 0 and
  // these reduce to exactly what they were; for a group, whose position and
  // content are in different places, ignoring it is what made "slide off left"
  // resolve to a 90px nudge that never left the screen.
  const cx = pose.x + (pose.offsetX ?? 0);
  const cy = pose.y + (pose.offsetY ?? 0);
  const offL = -(cx + halfW) - 40;           // fully left of frame
  const offR = comp.width - cx + halfW + 40; // fully right of frame
  const offU = -(cy + halfH) - 40;
  const offD = comp.height - cy + halfH + 40;
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

    case 'tr-slide-diag':
      // Corner-to-corner: both axes move together, which reads as one diagonal
      // rather than two separate slides.
      if (enter) {
        return [
          K('x', 0, offL), K('x', d, pose.x),
          K('y', 0, offU), K('y', d, pose.y),
          K('opacity', 0, 0), K('opacity', d * 0.4, 100),
        ];
      }
      return exitFrom(pose, d, [
        K('x', 0, pose.x, 'easeIn'), K('x', d * 0.85, offR, 'easeIn'),
        K('y', 0, pose.y, 'easeIn'), K('y', d * 0.85, offD, 'easeIn'),
      ]);

    case 'tr-drop-settle': {
      // Falls in fast, overshoots past the pose, then settles — the squash on
      // the landing beat is what sells the weight.
      const over = Math.max(10, pose.height * Math.abs(pose.scaleY) * 0.07);
      if (enter) {
        return [
          K('y', 0, offU, 'easeIn'),
          K('y', d * 0.55, pose.y + over, 'easeIn'),
          K('y', d * 0.78, pose.y - over * 0.4, 'easeOut'),
          K('y', d, pose.y, 'easeInOut'),
          K('scaleY', 0, pose.scaleY, 'linear'),
          K('scaleY', d * 0.55, pose.scaleY * 0.86, 'easeOut'),
          K('scaleY', d * 0.78, pose.scaleY * 1.06, 'easeOut'),
          K('scaleY', d, pose.scaleY, 'easeInOut'),
          K('opacity', 0, 0), K('opacity', d * 0.3, 100),
        ];
      }
      return exitFrom(pose, d, [
        K('y', 0, pose.y, 'easeIn'),
        K('y', d * 0.2, pose.y - over * 1.6, 'easeOut'),
        K('y', d * 0.85, offD, 'easeIn'),
      ]);
    }

    case 'tr-flip-card':
      // A card flip read through horizontal scale: the layer squeezes to zero
      // width (edge-on), then opens out again. Negative scaleX would mirror the
      // content, so the enter half stays positive on the way back out.
      if (enter) {
        return [
          K('scaleX', 0, 0, 'easeIn'),
          K('scaleX', d * 0.7, pose.scaleX * 1.08, 'easeOut'),
          K('scaleX', d, pose.scaleX, 'easeInOut'),
          K('scaleY', 0, pose.scaleY * 0.86, 'easeOut'),
          K('scaleY', d, pose.scaleY, 'easeInOut'),
          K('opacity', 0, 0), K('opacity', d * 0.25, 100),
        ];
      }
      return exitFrom(pose, d, [
        K('scaleX', 0, pose.scaleX, 'easeIn'),
        K('scaleX', d * 0.85, 0, 'easeIn'),
        K('scaleY', 0, pose.scaleY, 'easeIn'),
        K('scaleY', d * 0.85, pose.scaleY * 0.86, 'easeIn'),
      ], 0.85);

    case 'tr-shake-cut': {
      // A camera-knock: a decaying horizontal/rotational shake around the pose.
      const amp = Math.max(14, comp.width * 0.016);
      const beats = 7;
      const shake: RecipeKf[] = [];
      for (let i = 1; i <= beats; i++) {
        const t = (d * i) / (beats + 1);
        const decay = 1 - i / (beats + 1);
        const dir = i % 2 === 0 ? 1 : -1;
        shake.push(K('x', t, pose.x + dir * amp * decay, 'easeInOut'));
        shake.push(K('rotation', t, pose.rotation + dir * 2.2 * decay, 'easeInOut'));
      }
      if (enter) {
        return [
          K('x', 0, pose.x, 'easeInOut'), K('rotation', 0, pose.rotation, 'easeInOut'),
          K('opacity', 0, 0, 'linear'), K('opacity', d * 0.12, 100, 'linear'),
          ...shake,
          K('x', d, pose.x, 'easeInOut'), K('rotation', d, pose.rotation, 'easeInOut'),
        ];
      }
      return exitFrom(pose, d, [
        K('x', 0, pose.x, 'easeInOut'), K('rotation', 0, pose.rotation, 'easeInOut'),
        ...shake,
      ], 0.9);
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
  // The panel is comp-SIZED and positioned by its CENTRE, in comp coordinates
  // whose origin is the top-left. So `cx`/`cy` is "covering the frame", and one
  // full width/height either side of that is "entirely off-frame".
  //
  // These offsets used to be written around 0 — `-W → 0 → W` — which is only
  // right if the origin is the comp centre. It never showed, because the panel
  // was inserted as a pinned `fx.solid` whose position the renderer discards.
  // The moment the panel became a real moving layer, the old numbers put the
  // "fully covering" moment at the LEFT EDGE and left the wipe still half
  // across the frame when it was supposed to have gone: a wipe that covers half
  // the screen and stops. Anchored properly, a wipe now enters clean, covers
  // completely at the midpoint, and leaves clean.
  const cx = W / 2;
  const cy = H / 2;
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
      return [K('x', 0, cx + W, 'easeInOut'), K('x', d / 2, cx, 'easeInOut'), K('x', d, cx - W, 'easeInOut')];
    case 'tr-wipe-down':
      return [K('y', 0, cy - H, 'easeInOut'), K('y', d / 2, cy, 'easeInOut'), K('y', d, cy + H, 'easeInOut')];
    case 'tr-wipe-up':
      return [K('y', 0, cy + H, 'easeInOut'), K('y', d / 2, cy, 'easeInOut'), K('y', d, cy - H, 'easeInOut')];
    case 'tr-venetian': {
      // `count` horizontal bars, each 1/count of the frame tall, sweeping in
      // with a stagger and back out the other side — a real venetian blind.
      const n = Math.max(1, count);
      const barY = cy + (index - (n - 1) / 2) * (H / n);
      const stag = (index % 2 === 0 ? index : n - index) * (d * 0.06);
      const tIn = Math.min(d * 0.45, d * 0.28 + stag);
      const tOut = Math.min(d, d * 0.72 + stag);
      return [
        K('scaleY', 0, 1 / n, 'linear'), K('scaleY', d, 1 / n, 'linear'),
        K('y', 0, barY, 'linear'), K('y', d, barY, 'linear'),
        K('x', 0, cx - W, 'easeInOut'),
        K('x', tIn, cx, 'easeInOut'),
        K('x', tOut * 0.98, cx, 'easeInOut'),
        K('x', tOut, cx + W * 0.02, 'easeIn'),
        K('x', d, cx + W, 'easeIn'),
      ];
    }
    case 'tr-columns': {
      // Venetian's vertical twin: `count` columns, each 1/count of the frame
      // wide, dropping in with a stagger and continuing down out of frame.
      const n = Math.max(1, count);
      const colX = cx + (index - (n - 1) / 2) * (W / n);
      // Alternating stagger so the columns interleave instead of sweeping in
      // one direction like a wipe already does.
      const stag = (index % 2 === 0 ? index : n - index) * (d * 0.05);
      const tIn = Math.min(d * 0.45, d * 0.26 + stag);
      const tOut = Math.min(d, d * 0.7 + stag);
      return [
        K('scaleX', 0, 1 / n, 'linear'), K('scaleX', d, 1 / n, 'linear'),
        K('x', 0, colX, 'linear'), K('x', d, colX, 'linear'),
        K('y', 0, cy - H, 'easeInOut'),
        K('y', tIn, cy, 'easeInOut'),
        K('y', tOut * 0.98, cy, 'easeInOut'),
        K('y', tOut, cy + H * 0.02, 'easeIn'),
        K('y', d, cy + H, 'easeIn'),
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
        K('x', 0, cx - W, 'easeInOut'),
        K('x', d / 2, cx, 'easeInOut'),
        K('x', d, cx + W, 'easeInOut'),
      ];
  }
}

/**
 * The keyframes the inserted PANEL performs — for any item, solid-only or not.
 *
 * Solid-only items have a recipe of their own. Everything else used to fall
 * through `solidRecipe`'s `default:` arm, which is a generic wipe-right: with
 * no layer selected, Cross Fade, Glitch Cut, Zoom Through, Spin Whip and nine
 * others all inserted the SAME sweeping rectangle, distinguishable only by
 * duration. The cards kept showing their real, different motions — they call
 * `transitionRecipe` — so the panel promised one thing and delivered another,
 * which is "every transition does the same thing even though the previews are
 * all different".
 *
 * So a layer-mode item drives the panel with its OWN recipe: its entrance over
 * the first half of the window, its exit over the second. The panel arrives the
 * way that item arrives, covers the cut at the midpoint, and leaves the way that
 * item leaves — which is exactly what a transition solid is for, and is
 * different for every item.
 */
export function panelRecipe(id: string, comp: CompBox, index = 0, count = 1): RecipeKf[] {
  const item = getTransitionItem(id);
  if (!item) return [];
  if (item.solidOnly) return solidRecipe(id, comp, index, count);

  // The panel IS the frame: comp-sized, centred, unrotated.
  const pose: LayerPose = {
    x: comp.width / 2, y: comp.height / 2,
    scaleX: 1, scaleY: 1, rotation: 0,
    width: comp.width, height: comp.height,
  };
  const half = item.duration / 2;
  const enter = transitionRecipe(id, pose, comp, 'enter') ?? [];
  const exit = transitionRecipe(id, pose, comp, 'exit') ?? [];
  // Both halves are authored across the full duration, so compress each to half
  // and butt them together at the midpoint — where both agree on the pose, so
  // the seam is continuous.
  return [
    ...enter.map((k) => ({ ...k, t: k.t * 0.5 })),
    ...exit.map((k) => ({ ...k, t: half + k.t * 0.5 })),
  ];
}

/**
 * Seconds into a solid transition at which it is most LEGIBLE: covering enough
 * of the frame to be unmistakable, but not so much that the composition
 * disappears behind it.
 *
 * There is no good static frame for a transition, and both obvious choices are
 * actively bad. Resting at the midpoint parks the user in front of a full-frame
 * block of colour ("it broke my scene"). Resting at the end leaves the panel
 * off-frame or at opacity 0, so the canvas is unchanged and a layer has quietly
 * appeared in the timeline doing nothing visible ("it added something but I
 * don't see any effect"). Both were reported, in that order.
 *
 * So: aim for roughly half-covered. A wipe rests with its edge across the
 * frame, which is unmistakably a wipe. A dip to black rests half-faded, which
 * is unmistakably a dip. Pure geometry over the recipe — no engine, no render.
 */
export function solidRestTime(id: string, comp: CompBox): number {
  const item = getTransitionItem(id);
  const d = item?.duration ?? 0.8;
  if (d <= 0) return 0;
  // The iris reveals through an animated MASK that the recipe does not model,
  // so coverage maths cannot see it. A third of the way in the aperture is
  // partly open — the one description of it that is true.
  if (item?.irisMask) return d * 0.33;

  const count = item?.solidCount ?? 1;
  const frameArea = comp.width * comp.height;
  // Per-panel keyframe tables, read the same way the engine interpolates. Must
  // be the SAME recipe apply writes, or the resting frame is chosen from a
  // choreography that never runs.
  const panels = Array.from({ length: count }, (_, i) => panelRecipe(id, comp, i, count));

  const valueAt = (kfs: RecipeKf[], prop: string, t: number, fallback: number): number => {
    const track = kfs.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t);
    if (track.length === 0) return fallback;
    if (t <= track[0]!.t) return track[0]!.value;
    if (t >= track[track.length - 1]!.t) return track[track.length - 1]!.value;
    for (let i = 1; i < track.length; i++) {
      const b = track[i]!;
      if (t <= b.t) {
        const a = track[i - 1]!;
        const span = b.t - a.t;
        return span <= 0 ? b.value : a.value + (b.value - a.value) * ((t - a.t) / span);
      }
    }
    return track[track.length - 1]!.value;
  };

  let bestT = d / 2;
  let bestScore = -1;
  const STEPS = 48;
  for (let s = 0; s <= STEPS; s++) {
    const t = (s / STEPS) * d;
    let covered = 0;
    for (const kfs of panels) {
      const x = valueAt(kfs, 'x', t, comp.width / 2);
      const y = valueAt(kfs, 'y', t, comp.height / 2);
      const sx = valueAt(kfs, 'scaleX', t, 1);
      const sy = valueAt(kfs, 'scaleY', t, 1);
      const op = valueAt(kfs, 'opacity', t, 100) / 100;
      if (op <= 0.01) continue;
      const w = comp.width * Math.abs(sx);
      const h = comp.height * Math.abs(sy);
      // The panel is comp-sized and centred on (x, y) — intersect with the frame.
      const ix = Math.max(0, Math.min(comp.width, x + w / 2) - Math.max(0, x - w / 2));
      const iy = Math.max(0, Math.min(comp.height, y + h / 2) - Math.max(0, y - h / 2));
      covered += (ix * iy * op) / frameArea;
    }
    const cov = Math.min(1, covered);
    // Peaks at half-covered; falls off towards "invisible" and "blocks everything".
    const score = 1 - Math.abs(cov - 0.5) * 2;
    // `>=` so a tie resolves to the LATER frame. A wipe is half-covered both on
    // its way in and on its way out; resting on the later one means the playhead
    // visibly advances and the transition reads as having progressed, rather
    // than sitting at t=0 where nothing appears to have happened.
    if (score >= bestScore) { bestScore = score; bestT = t; }
  }
  // A recipe that never puts anything on screen (shouldn't happen) keeps the
  // midpoint rather than resting on a frame chosen by a flat score.
  return bestScore <= 0 ? d / 2 : bestT;
}

// ── Apply against the live scene ───────────────────────────────────

/**
 * The pose a recipe is computed against.
 *
 * `x`/`y` are the values being ANIMATED (the node's own transform props, and
 * therefore what the recipe must restore). `offsetX`/`offsetY` carry the gap
 * between those and where the layer actually appears — which is zero for an
 * ordinary layer and very much not zero for a GROUP.
 *
 * That distinction is the whole point. A group carries no Transform component:
 * it sits at its own origin while its children are laid out in absolute comp
 * coordinates. Reading it the old way gave `x=0, y=0, width=100, height=100`
 * for a motion-graphics element spread across the middle of a 1920×1080 comp,
 * so "slide off to the left" resolved to moving it 90px — a nudge, on screen
 * the whole time — and every zoom/whip scaled the wrong box. Applying a
 * transition to an inserted element therefore just displaced it slightly and
 * left it there, which is the "I applied a transition to my scene component and
 * it broke" report.
 *
 * `readGeometry` already unions a group's descendants into a real box (that is
 * what `offsetX/offsetY/width/height` mean there), so this defers to it and
 * only falls back to the raw props when the node has no drawable geometry.
 */
function readPose(nodeId: string, comp: CompBox): LayerPose | null {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return null;
  const t = node.components.find((c) => c.type === 'Transform');
  const x = (t?.props.x as number) ?? node.transform.position.x ?? comp.width / 2;
  const y = (t?.props.y as number) ?? node.transform.position.y ?? comp.height / 2;
  const scaleX = (t?.props.scaleX as number) ?? node.transform.scale.x ?? 1;
  const scaleY = (t?.props.scaleY as number) ?? node.transform.scale.y ?? 1;
  const rotation = (t?.props.rotation as number) ?? node.transform.rotation ?? 0;

  const geo = readGeometry(node);
  if (geo && geo.width > 0 && geo.height > 0) {
    return {
      x, y, scaleX, scaleY, rotation,
      width: geo.width,
      height: geo.height,
      // Scaled, because the offset is content measured in the node's own space.
      offsetX: geo.offsetX * scaleX,
      offsetY: geo.offsetY * scaleY,
    };
  }
  return {
    x, y, scaleX, scaleY, rotation,
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
 * Marks a layer as a transition's own covering panel.
 *
 * Applying a transition SELECTS what it produced, which is right — you want to
 * nudge or retime it. But it meant the next transition you applied saw that
 * panel sitting in the selection and took the layer path, keyframing itself
 * onto the panel instead of inserting one. Apply three transitions in a row and
 * you got ONE layer with three choreographies fighting over its x and opacity
 * tracks: "only one is being added", and the first one quietly wrecked too.
 * Moving the playhead never helped, because the behaviour keys off the
 * selection, not the time.
 *
 * A panel is scenery for a cut, not content — nobody applies a transition to a
 * transition. Excluded from auto-targeting so a second apply falls through to
 * inserting its own panel, while a genuine layer stays targetable as before.
 */
const TRANSITION_PANEL_PROP = '__transitionPanel';

/** True for a layer this library inserted to cover a cut. */
function isTransitionPanel(node: SceneNode): boolean {
  return node.components.some((c) => (c.props as Record<string, unknown>)[TRANSITION_PANEL_PROP] === true);
}

/**
 * The moving panel a solid-mode transition choreographs: a comp-sized SHAPE
 * layer, NOT an AE-style "solid".
 *
 * This used to call `insertSolid`, and that is why none of the wipes ever
 * wiped. A layer carrying `fx.solid` is, in buildSnapshot's own words, "pinned
 * to comp centre at comp size, REGARDLESS OF ITS TRANSFORM" — the flag exists
 * for backgrounds and matte bases, which should ignore their transform. So
 * every wipe, venetian bar, column and iris faithfully wrote x/y/scale
 * keyframes onto a layer whose x/y/scale the renderer discards. The result was
 * a full-frame block of colour sitting motionless over the composition at every
 * frame — visible, undeniably "there", and doing nothing. Only the two
 * opacity-driven items (dip to black, luma flash) ever worked, because opacity
 * is the one channel a pinned solid still honours.
 *
 * A plain shape sized to the comp looks identical when it is centred and
 * actually moves when it is animated. Returns the new node id, or null.
 */
function insertTransitionPanel(color: string, box: CompBox, name: string): string | null {
  const rootId = activeCompRootId();
  const node = makeNode('shape', name);
  const t = node.components.find((c) => c.type === 'Transform');
  if (!t) return null;
  const p = t.props as Record<string, unknown>;
  p[TRANSITION_PANEL_PROP] = true;
  p.x = box.width / 2;
  p.y = box.height / 2;
  p.width = box.width;
  p.height = box.height;
  node.transform.position = { x: box.width / 2, y: box.height / 2 };
  defaultSceneGraph.addChild(rootId, node);
  defaultSceneGraph.setFill(node.id, { type: 'solid', color });
  return node.id;
}

/**
 * Apply a transition at the playhead. With a selection, layer-mode items
 * keyframe every selected content layer (entrance or exit picked from each
 * layer's clip edges); without one (or for solid-only wipes) choreographed
 * colour panels covering the cut are inserted and selected. Returns null for
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
      // A panel left selected by the PREVIOUS apply is not a target — see
      // TRANSITION_PANEL_PROP. Without this, transitions stack onto each other
      // instead of accumulating as separate covers.
      if (isTransitionPanel(n)) return false;
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
        // An entrance settles VISIBLE at the end; an exit settles invisible by
        // definition, so it rests at its start instead. Resting an exit on its
        // last frame would leave the user staring at the empty comp they were
        // trying not to get.
        const anyEnter = phases.some((p) => p === 'enter');
        previewChoreography({
          from: t0,
          to: t0 + item.duration,
          restAt: anyEnter ? t0 + item.duration : t0,
        });
        return { mode: 'layer', nodeIds: written, phases };
      }
    }
  }

  // Solid mode — insert comp-covering panel(s) and choreograph them over the cut.
  const count = item.solidCount ?? 1;
  const solidIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const solidId = insertTransitionPanel(item.a, box, count > 1 ? `${item.name} ${i + 1}` : item.name);
    if (!solidId) continue;
    let blurTrack: string | null | undefined;
    for (const kf of panelRecipe(transId, box, i, count)) {
      let prop = kf.prop;
      // Same `@blur` resolution as layer mode — without it Blur Through would
      // silently lose the one channel that makes it Blur Through.
      if (prop === '@blur') {
        if (blurTrack === undefined) blurTrack = ensureBlurTrack(solidId);
        if (!blurTrack) continue;
        prop = blurTrack;
      }
      liveKf(solidId, prop, t0 + kf.t, kf.value, kf.ease);
    }
    if (item.irisMask) applyIrisMask(solidId, box, t0, item.duration);
    solidIds.push(solidId);
  }
  if (solidIds.length === 0) return null;
  useSelectionStore.getState().set(solidIds);
  bumpScene();
  // Rest half-covered — see `solidRestTime`. The midpoint hides the comp behind
  // a full-frame block; the end leaves nothing on screen at all. Both of those
  // read as broken, in opposite directions.
  previewChoreography({ from: t0, to: t0 + item.duration, restAt: t0 + solidRestTime(transId, box) });
  return { mode: 'solid', nodeIds: solidIds };
}

// ── Animated card preview (isolated; the SAME recipe apply writes) ───
//
// The cards used to be two colour swatches side by side, which said nothing
// about what the item does: "Whip Pan" and "Cross Fade" were both a pair of
// rectangles, and the only way to find out which transition you wanted was to
// apply each one and undo. These replay the real recipe against an isolated
// engine, so a card shows the motion it will write.

const PREVIEW_W = 320, PREVIEW_H = 180;

/** Props the isolated preview engine can drive. `@blur` resolves to an effect
 *  track on a real layer and has no equivalent here — dropping it costs the
 *  card a little softness, not the shape of the move. */
const PREVIEWABLE = new Set(['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']);

/**
 * Play a transition onto `canvas` through the shared gallery ticker.
 *
 * Layer-mode items animate a "shot" card over a contrasting backdrop — the
 * incoming frame — so a slide really slides across something. Solid-only items
 * choreograph their own solids over that same backdrop, which is exactly what
 * they do in the comp.
 */
export function createTransitionPlayer(canvas: HTMLCanvasElement, item: TransitionItem): { stop: () => void } {
  const box: CompBox = { width: PREVIEW_W, height: PREVIEW_H };
  const cx = PREVIEW_W / 2, cy = PREVIEW_H / 2;
  const cardW = PREVIEW_W * 0.66, cardH = PREVIEW_H * 0.66;
  const pose: LayerPose = { x: cx, y: cy, scaleX: 1, scaleY: 1, rotation: 0, width: cardW, height: cardH };

  return mountPreview(canvas, {
    build: (g) => {
      addRoot(g, 'tpl_root', item.name);
      // The incoming shot, always present underneath.
      addShape(g, 'under', 'tpl_root', cx, cy, PREVIEW_W, PREVIEW_H, item.b);
      if (item.solidOnly) {
        const count = item.solidCount ?? 1;
        for (let i = 0; i < count; i++) addShape(g, `sol${i}`, 'tpl_root', cx, cy, PREVIEW_W, PREVIEW_H, item.a);
      } else {
        addShape(g, 'card', 'tpl_root', cx, cy, cardW, cardH, item.a);
      }
    },
    animate: (set) => {
      if (item.solidOnly) {
        const count = item.solidCount ?? 1;
        for (let i = 0; i < count; i++) {
          for (const kf of solidRecipe(item.id, box, i, count)) {
            if (PREVIEWABLE.has(kf.prop)) set(`sol${i}`, kf.prop, kf.t, kf.value, kf.ease);
          }
        }
        return;
      }
      // Entrance reads better on a card than the exit — it ends on the pose,
      // so the loop returns to a stable frame rather than an empty one.
      for (const kf of transitionRecipe(item.id, pose, box, 'enter') ?? []) {
        if (PREVIEWABLE.has(kf.prop)) set('card', kf.prop, kf.t, kf.value, kf.ease);
      }
    },
    // A beat of the settled pose before the loop restarts, so the card reads as
    // "arrives and lands" rather than a stutter.
    duration: item.duration + 0.45,
    width: PREVIEW_W,
    height: PREVIEW_H,
    background: '#101016',
  });
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
