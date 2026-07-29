/**
 * Animated presets — a drop-in LIBRARY of animated text/object elements (the
 * "Canva animated text" model). Unlike full-scene templates, a preset INSERTS a
 * single self-contained animated element into the CURRENT composition (no scene
 * wipe) at the cursor/centre and the current playhead; the user then just edits
 * the text like any layer. Each preset owns a complex multi-keyframe animation.
 *
 * The choreography and the geometry are BOTH authored against a reference comp
 * height (`REF_H`) and scaled by a per-comp `unit`, so the SAME element size and
 * motion drive the live insert (into the real comp) and the isolated card
 * preview (a 16:9 preview comp). That parity is what makes an inserted preset
 * land looking exactly like its card — the earlier bug was a fixed 96px element
 * dropped into comps of any size.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { activeCompRootId } from '@core/scene/activeComp';
import { AnimationEngine } from '@motion/animation';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { bumpScene } from '@stores/sceneStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { addRoot, addText, addShape, liveKf, type SetKf } from './templates/builders';
import { animatorPropPath, type TextAnimatorData } from '@core/text/textAnimators';
import { renderThumbnail } from './templatePreview';
import { mountPreview } from './previewController';

export type { SetKf };

/** Reference comp height the presets are authored at. A preset's element size
 *  and motion offsets are all expressed at this height and multiplied by `unit`
 *  for the target comp, so they stay proportional at any resolution. */
const REF_H = 720;
/** The isolated preview comp (16:9). */
const PREVIEW_W = 1280, PREVIEW_H = 720;

const unitFor = (compH: number): number => compH / REF_H;

export interface AnimPreset {
  id: string;
  name: string;
  kind: 'text' | 'object';
  /** Build the static element (root-relative) into `g` at (x, y); `u` scales the
   *  element's authored size to the target comp. */
  build: (g: SceneGraph, id: string, parent: string, x: number, y: number, u: number) => void;
  /** The keyframe choreography, offset to start at t0 seconds; `u` scales spatial
   *  offsets to the target comp. Per-glyph presets keyframe the `ta.0.*` path. */
  animate: (set: SetKf, id: string, x: number, y: number, t0: number, u: number) => void;
  /** Per-glyph (kinetic-typography) presets: write the static text-animator data
   *  onto the built text node before animate keyframes its selector. */
  applyAnimators?: (g: SceneGraph, id: string) => void;
  /** Representative frame (seconds) for the still card preview. */
  previewTime: number;
}

/** Write the static text-animator metadata onto a built text node (Text comp id
 *  is `<id>_c`, per addText). Shared by insert and the isolated previews. */
function writeAnimatorsTo(g: SceneGraph, id: string, data: TextAnimatorData[]): void {
  g.writeProp(id, `${id}_c`, '__animators', data);
}

/** A per-glyph reveal animator: covered glyphs sit in a "before" pose (offsets);
 *  keyframing `ta.0.start` from 0→100 uncovers them left→right (crisp type-on). */
function reveal(before: Partial<TextAnimatorData>): TextAnimatorData {
  return {
    id: 'a0', basedOn: 'characters', shape: 'square',
    start: 0, end: 100, offset: 0,
    x: 0, y: 0, scale: 100, rotation: 0, opacity: 100, tracking: 0, skew: 0,
    mode: 'range', wiggleFreq: 2,
    ...before,
  };
}
const START = animatorPropPath(0, 'start');

const TEXT = { content: 'Your Text', size: 96, weight: 800, fill: '#ffffff' };

function textEl(g: SceneGraph, id: string, parent: string, x: number, y: number, u: number): void {
  addText(g, id, parent, TEXT.content, x, y, TEXT.size * u, TEXT.weight, TEXT.fill);
}

// ── The library ──────────────────────────────────────────────────────
export const ANIM_PRESETS: readonly AnimPreset[] = [
  // ── Per-glyph kinetic typography (native text animators) ───────────
  {
    id: 'cascade-rise', name: 'Cascade Rise', kind: 'text', previewTime: 0.9,
    build: textEl,
    applyAnimators: (g, id) => writeAnimatorsTo(g, id, [reveal({ y: 110, scale: 60, opacity: 0 })]),
    animate: (set, id, _x, _y, t0) => {
      set(id, START, t0 + 0, 0, 'easeInOut');
      set(id, START, t0 + 1.1, 100, 'easeInOut');
    },
  },
  {
    id: 'tilt-reveal', name: 'Tilt Reveal', kind: 'text', previewTime: 0.9,
    build: textEl,
    applyAnimators: (g, id) => writeAnimatorsTo(g, id, [reveal({ rotation: -38, y: 60, opacity: 0 })]),
    animate: (set, id, _x, _y, t0) => {
      set(id, START, t0 + 0, 0, 'easeInOut');
      set(id, START, t0 + 1.2, 100, 'easeInOut');
    },
  },
  {
    id: 'pop-stagger', name: 'Pop Stagger', kind: 'text', previewTime: 0.8,
    build: textEl,
    applyAnimators: (g, id) => writeAnimatorsTo(g, id, [reveal({ scale: 0, opacity: 0 })]),
    animate: (set, id, _x, _y, t0) => {
      set(id, START, t0 + 0, 0, 'easeInOut');
      set(id, START, t0 + 1, 100, 'easeInOut');
    },
  },
  {
    id: 'type-fade', name: 'Type Fade', kind: 'text', previewTime: 0.7,
    build: textEl,
    applyAnimators: (g, id) => writeAnimatorsTo(g, id, [reveal({ opacity: 0 })]),
    animate: (set, id, _x, _y, t0) => {
      set(id, START, t0 + 0, 0, 'easeInOut');
      set(id, START, t0 + 0.9, 100, 'easeInOut');
    },
  },
  {
    id: 'elastic-pop', name: 'Elastic Pop', kind: 'text', previewTime: 0.5,
    build: textEl,
    animate: (set, id, _x, _y, t0) => {
      set(id, 'opacity', t0 + 0, 0, 'easeOut'); set(id, 'opacity', t0 + 0.18, 100, 'easeOut');
      const s = ['scaleX', 'scaleY'] as const;
      for (const k of s) {
        set(id, k, t0 + 0, 0, 'easeOut'); set(id, k, t0 + 0.32, 1.25, 'easeOut');
        set(id, k, t0 + 0.48, 0.9, 'easeInOut'); set(id, k, t0 + 0.62, 1.06, 'easeInOut');
        set(id, k, t0 + 0.76, 1, 'easeOut');
      }
    },
  },
  {
    id: 'spin-in', name: 'Spin In', kind: 'text', previewTime: 0.5,
    build: textEl,
    animate: (set, id, _x, _y, t0) => {
      set(id, 'rotation', t0 + 0, -200, 'easeOut'); set(id, 'rotation', t0 + 0.7, 0, 'easeOut');
      const s = ['scaleX', 'scaleY'] as const;
      for (const k of s) { set(id, k, t0 + 0, 0, 'easeOut'); set(id, k, t0 + 0.7, 1, 'easeOut'); }
      set(id, 'opacity', t0 + 0, 0, 'easeOut'); set(id, 'opacity', t0 + 0.3, 100, 'easeOut');
    },
  },
  {
    id: 'slide-reveal', name: 'Slide Reveal', kind: 'text', previewTime: 0.5,
    build: textEl,
    animate: (set, id, x, _y, t0, u) => {
      set(id, 'x', t0 + 0, x - 160 * u, 'easeOut'); set(id, 'x', t0 + 0.6, x, 'easeOut');
      set(id, 'opacity', t0 + 0, 0, 'easeOut'); set(id, 'opacity', t0 + 0.4, 100, 'easeOut');
      set(id, 'letterSpacing', t0 + 0, 20 * u, 'easeOut'); set(id, 'letterSpacing', t0 + 0.7, 2 * u, 'easeOut');
    },
  },
  {
    id: 'drop-bounce', name: 'Drop Bounce', kind: 'text', previewTime: 0.7,
    build: textEl,
    animate: (set, id, _x, y, t0, u) => {
      set(id, 'opacity', t0 + 0, 0, 'easeOut'); set(id, 'opacity', t0 + 0.12, 100, 'easeOut');
      set(id, 'y', t0 + 0, y - 240 * u, 'easeIn'); set(id, 'y', t0 + 0.42, y, 'easeIn');
      set(id, 'y', t0 + 0.58, y - 44 * u, 'easeOut'); set(id, 'y', t0 + 0.74, y, 'easeIn');
      set(id, 'y', t0 + 0.86, y - 14 * u, 'easeOut'); set(id, 'y', t0 + 0.98, y, 'easeIn');
    },
  },
  {
    id: 'zoom-in', name: 'Zoom In', kind: 'text', previewTime: 0.5,
    build: textEl,
    animate: (set, id, _x, _y, t0, u) => {
      const s = ['scaleX', 'scaleY'] as const;
      for (const k of s) { set(id, k, t0 + 0, 2.4, 'easeOut'); set(id, k, t0 + 0.7, 1, 'easeOut'); }
      set(id, 'opacity', t0 + 0, 0, 'easeOut'); set(id, 'opacity', t0 + 0.5, 100, 'easeOut');
      set(id, 'letterSpacing', t0 + 0, -18 * u, 'easeOut'); set(id, 'letterSpacing', t0 + 0.7, 0, 'easeOut');
    },
  },
  {
    id: 'bounce-dot', name: 'Bounce Dot', kind: 'object', previewTime: 0.5,
    build: (g, id, parent, x, y, u) => addShape(g, id, parent, x, y, 220 * u, 220 * u, '#635bff'),
    animate: (set, id, _x, y, t0, u) => {
      const s = ['scaleX', 'scaleY'] as const;
      for (const k of s) {
        set(id, k, t0 + 0, 0, 'easeOut'); set(id, k, t0 + 0.4, 1.25, 'easeOut');
        set(id, k, t0 + 0.56, 0.92, 'easeInOut'); set(id, k, t0 + 0.72, 1, 'easeOut');
      }
      set(id, 'opacity', t0 + 0, 0, 'easeOut'); set(id, 'opacity', t0 + 0.2, 100, 'easeOut');
      set(id, 'y', t0 + 0, y - 120 * u, 'easeIn'); set(id, 'y', t0 + 0.4, y, 'easeOut');
    },
  },
  {
    id: 'spin-square', name: 'Spin Square', kind: 'object', previewTime: 0.6,
    build: (g, id, parent, x, y, u) => addShape(g, id, parent, x, y, 200 * u, 200 * u, '#22d3ee'),
    animate: (set, id, _x, _y, t0) => {
      set(id, 'rotation', t0 + 0, 0, 'easeInOut'); set(id, 'rotation', t0 + 1.0, 360, 'easeInOut');
      const s = ['scaleX', 'scaleY'] as const;
      for (const k of s) {
        set(id, k, t0 + 0, 0, 'easeOut'); set(id, k, t0 + 0.5, 1.1, 'easeOut');
        set(id, k, t0 + 0.75, 1, 'easeOut');
      }
      set(id, 'opacity', t0 + 0, 0, 'easeOut'); set(id, 'opacity', t0 + 0.3, 100, 'easeOut');
    },
  },
];

export function getAnimPreset(id: string): AnimPreset | null {
  return ANIM_PRESETS.find((p) => p.id === id) ?? null;
}

// ── Insert into the live composition ─────────────────────────────────
let seq = 0;

/** Insert an animated preset into the current comp at (x, y) — comp centre when
 *  omitted — starting at the current playhead. Element size + motion scale to
 *  the comp so the result matches the preview card. Returns the new node id. */
export function insertAnimPreset(presetId: string, x?: number, y?: number): string | null {
  const preset = getAnimPreset(presetId);
  if (!preset) return null;
  const comp = useCompositionStore.getState();
  const u = unitFor(comp.height || REF_H);
  const px = x ?? comp.width / 2;
  const py = y ?? comp.height / 2;
  const rootId = activeCompRootId();
  const id = `anim_${(seq += 1)}`;

  preset.build(defaultSceneGraph, id, rootId, px, py, u);
  preset.applyAnimators?.(defaultSceneGraph, id);

  // Start at the playhead so the animation plays from where the user is.
  const ws = useWorkspaceStore.getState();
  const t0 = (ws.activeTabId ? ws.tabs[ws.activeTabId]?.time : 0) ?? 0;
  const tc = getTimelineController();
  // t0 offsets the choreography to the playhead; liveKf maps seconds → layer time.
  preset.animate(liveKf, id, px, py, t0, u);

  useSelectionStore.getState().set([id]);
  tc.syncFromScene();
  bumpScene();
  return id;
}

// ── Card preview (isolated; samples a representative motion frame) ────
const thumbCache = new Map<string, string>();

/** Build the isolated preview graph + choreography for a preset (16:9 comp). */
function previewSpec(preset: AnimPreset): {
  build: (g: SceneGraph) => void; animate: (set: SetKf) => void;
} {
  const cx = PREVIEW_W / 2, cy = PREVIEW_H / 2;
  return {
    build: (g) => {
      addRoot(g, 'tpl_root', preset.name);
      preset.build(g, 'el', 'tpl_root', cx, cy, 1);
      preset.applyAnimators?.(g, 'el');
    },
    animate: (set) => preset.animate(set, 'el', cx, cy, 0, 1),
  };
}

export function animPresetThumbnail(preset: AnimPreset): string | null {
  const hit = thumbCache.get(preset.id);
  if (hit) return hit;
  const spec = previewSpec(preset);
  const anim = new AnimationEngine();
  spec.animate((nid, prop, time, value, ease) => anim.setKeyframe(nid, prop, time, value, ease ?? 'easeInOut'));
  const url = renderThumbnail(spec.build, PREVIEW_W, PREVIEW_H, { anim, time: preset.previewTime });
  if (url) thumbCache.set(preset.id, url);
  return url;
}

/**
 * Play a preset's animation live into `canvas`, looping continuously via the
 * shared gallery ticker. Isolated throwaway graph + preview engine, so it never
 * touches the live scene. Returns a stop that unmounts it.
 */
export function createAnimPresetPlayer(canvas: HTMLCanvasElement, preset: AnimPreset): { stop: () => void } {
  const spec = previewSpec(preset);
  return mountPreview(canvas, {
    build: spec.build,
    animate: spec.animate,
    width: PREVIEW_W,
    height: PREVIEW_H,
    background: 'rgba(0,0,0,0)',
  });
}
