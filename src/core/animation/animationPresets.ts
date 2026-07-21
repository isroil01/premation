/**
 * Animation presets (Prompt E8). Capture a layer's animation (all its keyframed
 * tracks) as a named preset, then re-apply it to any other layer — anchored at
 * the current playhead. Generalises the old hardcoded AI suggestion picker into
 * a real, saveable system. Presets persist via the SettingsManager and apply as
 * one undoable command (through runAnimEdit), so "everything stays editable and
 * reversible" is literally true.
 *
 * Keyframe TIMES are stored relative to the preset's start (t=0); applying adds
 * the playhead time. Keyframe VALUES are stored as captured (absolute) — replay
 * is exact. (Value-relative application is a documented follow-up.)
 */

import { defaultAnimation, type AnimationEngine, type Keyframe, type PropPath } from '@motion/animation';
import { runAnimEdit } from '@core/animation/animationCommands';
import { getSettingsManager } from '@core/services/coreServices';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { is3DEnabled, set3DEnabled, THREE_D_PROPS } from '@core/scene/threeD';
import { readNodeKind } from '@core/scene/sceneDerive';
import {
  applyTypewriter,
  applyBounceInWords,
  applySpinFadeCharacters,
  applyTrackingReveal,
} from './keyframeAssistants';

export interface PresetTrack {
  prop: PropPath;
  keyframes: Keyframe[];
  /** Relative tracks store OFFSETS from the layer's current value — applying
   *  adds the layer's base value to every keyframe (how "Slide In Left" works
   *  on a layer at any position). Absolute tracks replay exact values. */
  relative?: boolean;
}

export interface AnimationPreset {
  name: string;
  builtin?: boolean;
  category?: string;
  tracks: PresetTrack[];
  /** Custom application function for complex rigs (e.g. text animators) */
  applyFn?: (nodeId: string, atTime: number, engine?: any) => boolean;
}

// ── Pure time maths (the tested core) ────────────────────────────────

/** The earliest keyframe time across all tracks (0 when empty). */
export function minTime(tracks: ReadonlyArray<PresetTrack>): number {
  let min = Infinity;
  for (const t of tracks) for (const k of t.keyframes) min = Math.min(min, k.t);
  return Number.isFinite(min) ? min : 0;
}

/** Rebase all keyframe times so the earliest is 0 (values untouched). Pure. */
export function normalizeTracks(tracks: ReadonlyArray<PresetTrack>): PresetTrack[] {
  const base = minTime(tracks);
  return tracks.map((t) => ({
    prop: t.prop,
    keyframes: t.keyframes.map((k) => ({ ...k, t: k.t - base })),
  }));
}

/** Shift all keyframe times by `dt` (e.g. to the playhead). Pure. */
export function offsetTracks(tracks: ReadonlyArray<PresetTrack>, dt: number): PresetTrack[] {
  return tracks.map((t) => ({
    ...t,
    keyframes: t.keyframes.map((k) => ({ ...k, t: k.t + dt })),
  }));
}

/**
 * Resolve relative tracks against the layer's base values: each relative
 * keyframe value becomes `base + offset`. Absolute tracks pass through. Pure —
 * `baseOf` supplies the layer's current value per property.
 */
export function resolveRelativeTracks(
  tracks: ReadonlyArray<PresetTrack>,
  baseOf: (prop: PropPath) => number | undefined,
): PresetTrack[] {
  return tracks.map((t) => {
    if (!t.relative) return t;
    const base = baseOf(t.prop) ?? DEFAULT_BASE[t.prop] ?? 0;
    return { prop: t.prop, keyframes: t.keyframes.map((k) => ({ ...k, value: base + k.value })) };
  });
}

/** Sensible base values when a layer doesn't carry the property explicitly. */
const DEFAULT_BASE: Record<string, number> = { scale: 1, rotation: 0, opacity: 100, x: 0, y: 0 };

// ── Capture / apply through the engine ───────────────────────────────

/** Capture a node's animated tracks as normalized (t=0-based) preset tracks. */
export function captureAnimation(
  nodeId: string,
  engine: AnimationEngine = defaultAnimation,
): PresetTrack[] {
  const tracks: PresetTrack[] = [];
  for (const prop of engine.animatedProps(nodeId)) {
    const kfs = engine.getTrackKeyframes(nodeId, prop);
    if (kfs && kfs.length) tracks.push({ prop, keyframes: kfs });
  }
  return normalizeTracks(tracks);
}

/** The layer's current value for a property: sampled animation first, then the
 *  base scene prop (searched across the node's components, threeD.ts-style). */
export function nodeBaseValue(
  nodeId: string,
  prop: PropPath,
  atTime: number,
  engine: AnimationEngine = defaultAnimation,
): number | undefined {
  const sampled = engine.sample(nodeId, prop, atTime);
  if (sampled !== undefined) return sampled;
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return undefined;
  for (const c of node.components) {
    const v = (c.props as Record<string, unknown>)[prop];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/** Apply preset tracks to a node at `atTime`, as one undoable command.
 *  Relative tracks are resolved against the layer's current values. */
export function applyPresetTracks(
  nodeId: string,
  tracks: ReadonlyArray<PresetTrack>,
  atTime: number,
  engine: AnimationEngine = defaultAnimation,
): void {
  const resolved = resolveRelativeTracks(tracks, (prop) => nodeBaseValue(nodeId, prop, atTime, engine));
  const shifted = offsetTracks(resolved, atTime);
  // 3D presets (z / rotationX / rotationY tracks) need the layer's 3D switch on
  // to render — flip it automatically so they are one-click on any 2D layer.
  // Cameras/lights read their depth props directly and don't use the switch.
  const uses3D = tracks.some((t) => (THREE_D_PROPS as readonly string[]).includes(t.prop));
  if (uses3D) {
    const node = defaultSceneGraph.getNode(nodeId);
    const kind = node ? readNodeKind(node) : null;
    if (node && kind !== 'camera' && kind !== 'light' && !is3DEnabled(node)) {
      set3DEnabled(nodeId, true);
    }
  }
  runAnimEdit('Apply animation preset', () => {
    for (const t of shifted) {
      for (const k of t.keyframes) {
        engine.setKeyframe(nodeId, t.prop, k.t, k.value, k.easing);
        if (k.bezier) engine.setBezier(nodeId, t.prop, k.t, k.bezier);
      }
    }
  });
}

// ── Built-in presets (position-agnostic so they suit any layer) ──────

const kf = (t: number, value: number, easing?: Keyframe['easing']): Keyframe => ({ t, value, easing });

// Professional Easing Curves
const SMOOTH_EASE: [number, number, number, number] = [0.4, 0, 0.2, 1]; // Smooth AE Ease Ease
const SNAPPY_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]; // Snappy Ease Out
const OVERSHOOT_EASE: [number, number, number, number] = [0.34, 1.56, 0.64, 1]; // Pop In with settle
const ANTICIPATE_EASE: [number, number, number, number] = [0.6, -0.28, 0.735, 0.045]; // Anticipation zoom/slide
const BOUNCE_EASE: [number, number, number, number] = [0.175, 0.885, 0.32, 1.275]; // Elastic bounce

// Bezier is optional: easing lives on the keyframe that STARTS a segment, so
// a preset's final keyframe needs no handles.
const kfb = (t: number, value: number, bezier?: [number, number, number, number]): Keyframe => ({
  t,
  value,
  ...(bezier ? { easing: 'bezier' as const, bezier } : {}),
});

export const BUILTIN_PRESETS: ReadonlyArray<AnimationPreset> = [
  // ── Entrances ───────────────────────────────────────────────────────
  {
    name: 'Fade In',
    builtin: true,
    category: 'Entrances',
    tracks: [{ prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.5, 100)] }],
  },
  {
    name: 'Pop In',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'scale', keyframes: [kfb(0, 0, OVERSHOOT_EASE), kfb(0.5, 1)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: 'Bounce In',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'scale', keyframes: [kfb(0, 0, BOUNCE_EASE), kfb(0.6, 1)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: 'Slide In Left',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'x', relative: true, keyframes: [kfb(0, -400, SNAPPY_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.35, 100)] },
    ],
  },
  {
    name: 'Slide In Right',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'x', relative: true, keyframes: [kfb(0, 400, SNAPPY_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.35, 100)] },
    ],
  },
  {
    name: 'Rise Up',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'y', relative: true, keyframes: [kfb(0, 120, SNAPPY_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.4, 100)] },
    ],
  },
  {
    name: 'Drop In',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'y', relative: true, keyframes: [kfb(0, -260, BOUNCE_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.25, 100)] },
    ],
  },
  {
    name: 'Spiral Entrance',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'scale', keyframes: [kfb(0, 0, OVERSHOOT_EASE), kfb(0.6, 1)] },
      { prop: 'rotation', keyframes: [kfb(0, -180, SNAPPY_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.4, 100)] },
    ],
  },
  {
    name: 'Skid Slide In',
    builtin: true,
    category: 'Entrances',
    tracks: [
      { prop: 'x', relative: true, keyframes: [kfb(0, -300, [0.34, 1.56, 0.64, 1]), kfb(0.7, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },

  // ── Exits ──────────────────────────────────────────────────────────
  {
    name: 'Fade Out',
    builtin: true,
    category: 'Exits',
    tracks: [{ prop: 'opacity', keyframes: [kfb(0, 100, SMOOTH_EASE), kfb(0.5, 0)] }],
  },
  {
    name: 'Zoom Out Exit',
    builtin: true,
    category: 'Exits',
    tracks: [
      { prop: 'scale', keyframes: [kfb(0, 1, ANTICIPATE_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 100, SMOOTH_EASE), kfb(0.45, 0)] },
    ],
  },
  {
    name: 'Rotate Out Exit',
    builtin: true,
    category: 'Exits',
    tracks: [
      { prop: 'rotation', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.6, 360)] },
      { prop: 'scale', keyframes: [kfb(0, 1, SMOOTH_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 100, SMOOTH_EASE), kfb(0.4, 0)] },
    ],
  },

  // ── Emphases & Loops ────────────────────────────────────────────────
  {
    name: 'Spin',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [{ prop: 'rotation', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(1.0, 360)] }],
  },
  {
    name: 'Pulse',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [{ prop: 'scale', keyframes: [kfb(0, 1, SMOOTH_EASE), kfb(0.4, 1.18, SMOOTH_EASE), kfb(0.8, 1)] }],
  },
  {
    name: 'Shake',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [
      { prop: 'rotation', relative: true, keyframes: [
        kfb(0, 0, SMOOTH_EASE), 
        kfb(0.08, 8, SMOOTH_EASE), 
        kfb(0.16, -7, SMOOTH_EASE), 
        kfb(0.24, 5, SMOOTH_EASE), 
        kfb(0.32, -3, SMOOTH_EASE), 
        kfb(0.4, 0)
      ] },
    ],
  },
  {
    name: 'Heartbeat',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [
      { prop: 'scale', keyframes: [
        kfb(0, 1, [0.25, 0.8, 0.25, 1]), 
        kfb(0.14, 1.25, [0.25, 0.1, 0.25, 1]), 
        kfb(0.28, 1.05, [0.25, 0.8, 0.25, 1]), 
        kfb(0.42, 1.2, [0.25, 0.1, 0.25, 1]), 
        kfb(0.6, 1)
      ] },
    ],
  },
  {
    name: 'Elastic Float',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [
      { prop: 'y', relative: true, keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.8, -20, SMOOTH_EASE), kfb(1.6, 0)] },
    ],
  },
  {
    name: 'Jelly Wobble',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [
      { prop: 'scale', keyframes: [
        kfb(0, 1, SMOOTH_EASE), 
        kfb(0.2, 1.25, SMOOTH_EASE), 
        kfb(0.4, 0.8, SMOOTH_EASE), 
        kfb(0.6, 1.1, SMOOTH_EASE), 
        kfb(0.8, 0.95, SMOOTH_EASE), 
        kfb(1.0, 1)
      ] },
      { prop: 'rotation', relative: true, keyframes: [
        kfb(0, 0, SMOOTH_EASE), 
        kfb(0.2, 10, SMOOTH_EASE), 
        kfb(0.4, -8, SMOOTH_EASE), 
        kfb(0.6, 4, SMOOTH_EASE), 
        kfb(0.8, -2, SMOOTH_EASE), 
        kfb(1.0, 0)
      ] },
    ],
  },
  {
    name: 'Glitch Jitter',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [
      { prop: 'x', relative: true, keyframes: [kf(0, 0), kf(0.05, -6), kf(0.1, 8), kf(0.15, -4), kf(0.2, 5), kf(0.25, -2), kf(0.3, 0)] },
      { prop: 'y', relative: true, keyframes: [kf(0, 0), kf(0.05, 4), kf(0.1, -6), kf(0.15, 5), kf(0.2, -3), kf(0.25, 4), kf(0.3, 0)] },
      { prop: 'scale', keyframes: [kf(0, 1), kf(0.07, 0.95), kf(0.14, 1.08), kf(0.21, 0.97), kf(0.3, 1)] },
    ],
  },
  {
    name: 'Wiggle Drift',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [],
    applyFn: (nodeId, _atTime, engine = defaultAnimation) => {
      runAnimEdit('Apply wiggle expression', () => {
        engine.setExpression(nodeId, 'x', 'wiggle(3, 40)');
        engine.setExpression(nodeId, 'y', 'wiggle(3, 40)');
      });
      return true;
    },
  },
  {
    name: 'Wind Sway',
    builtin: true,
    category: 'Emphases & Loops',
    tracks: [],
    applyFn: (nodeId, _atTime, engine = defaultAnimation) => {
      runAnimEdit('Apply continuous sway expression', () => {
        engine.setExpression(nodeId, 'rotation', 'Math.sin(time * 3) * 6');
      });
      return true;
    },
  },

  // ── 3D Motions ─────────────────────────────────────────────────────
  {
    name: 'Flip In 3D',
    builtin: true,
    category: '3D Motions',
    tracks: [
      { prop: 'rotationY', keyframes: [kfb(0, -90, SNAPPY_EASE), kfb(0.6, 0, SMOOTH_EASE)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: 'Card Flip 3D',
    builtin: true,
    category: '3D Motions',
    tracks: [{ prop: 'rotationY', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.9, 180)] }],
  },
  {
    name: 'Swing In 3D',
    builtin: true,
    category: '3D Motions',
    tracks: [
      { prop: 'rotationX', keyframes: [kfb(0, -80, BOUNCE_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.25, 100)] },
    ],
  },
  {
    name: 'Depth Push In',
    builtin: true,
    category: '3D Motions',
    tracks: [
      { prop: 'z', keyframes: [kfb(0, 800, SNAPPY_EASE), kfb(0.8, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.35, 100)] },
    ],
  },
  {
    name: 'Orbit Tilt 3D',
    builtin: true,
    category: '3D Motions',
    tracks: [
      { prop: 'rotationY', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.6, 28, SMOOTH_EASE), kfb(1.2, 0)] },
      { prop: 'rotationX', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.6, -14, SMOOTH_EASE), kfb(1.2, 0)] },
    ],
  },
  {
    name: '3D Twirl In',
    builtin: true,
    category: '3D Motions',
    tracks: [
      { prop: 'rotationX', keyframes: [kfb(0, -180, SNAPPY_EASE), kfb(0.7, 0)] },
      { prop: 'rotationY', keyframes: [kfb(0, -180, SNAPPY_EASE), kfb(0.7, 0)] },
      { prop: 'scale', keyframes: [kfb(0, 0, OVERSHOOT_EASE), kfb(0.7, 1)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: '3D Cube Roll',
    builtin: true,
    category: '3D Motions',
    tracks: [
      { prop: 'rotationX', keyframes: [kfb(0, -90, SNAPPY_EASE), kfb(0.7, 0)] },
      { prop: 'z', keyframes: [kfb(0, 400, SNAPPY_EASE), kfb(0.7, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: 'Cinematic Pan 3D',
    builtin: true,
    category: '3D Motions',
    tracks: [
      { prop: 'rotationY', keyframes: [kfb(0, -15, SMOOTH_EASE), kfb(1.8, 15)] },
      { prop: 'rotationX', keyframes: [kfb(0, 10, SMOOTH_EASE), kfb(1.8, -5)] },
      { prop: 'z', keyframes: [kfb(0, 200, SMOOTH_EASE), kfb(1.8, -100)] },
    ],
  },

  // ── Text Animators (AE-Style) ───────────────────────────────────────
  {
    name: 'Typewriter',
    builtin: true,
    category: 'Text Animators (AE-Style)',
    tracks: [],
    applyFn: (nodeId, atTime, engine) => applyTypewriter(nodeId, atTime, 1.5, engine),
  },
  {
    name: 'Bounce In Words',
    builtin: true,
    category: 'Text Animators (AE-Style)',
    tracks: [],
    applyFn: (nodeId, atTime, engine) => applyBounceInWords(nodeId, atTime, 1.5, engine),
  },
  {
    name: 'Spin & Fade Characters',
    builtin: true,
    category: 'Text Animators (AE-Style)',
    tracks: [],
    applyFn: (nodeId, atTime, engine) => applySpinFadeCharacters(nodeId, atTime, 1.5, engine),
  },
  {
    name: 'Tracking Reveal',
    builtin: true,
    category: 'Text Animators (AE-Style)',
    tracks: [],
    applyFn: (nodeId, atTime, engine) => applyTrackingReveal(nodeId, atTime, 1.5, engine),
  },
];

// ── Persistence (user presets) ───────────────────────────────────────

const SETTINGS_KEY = 'animationPresets';

function readUserPresets(): AnimationPreset[] {
  try {
    return getSettingsManager().get<AnimationPreset[]>(SETTINGS_KEY, []);
  } catch {
    return [];
  }
}

function writeUserPresets(presets: AnimationPreset[]): void {
  try {
    getSettingsManager().set<AnimationPreset[]>(SETTINGS_KEY, presets);
  } catch {
    /* settings not booted */
  }
}

/** All presets — built-ins first, then the user's saved ones. */
export function listPresets(): AnimationPreset[] {
  return [...BUILTIN_PRESETS, ...readUserPresets()];
}

/** Save the selected node's current animation as a named user preset. */
export function saveCurrentAsPreset(nodeId: string, name: string): boolean {
  const tracks = captureAnimation(nodeId);
  if (!tracks.length) return false; // nothing animated to save
  const others = readUserPresets().filter((p) => p.name !== name);
  writeUserPresets([...others, { name, tracks }]);
  return true;
}

/** Apply a named preset to a node at `atTime` (one undoable command). */
export function applyPresetByName(nodeId: string, name: string, atTime: number): boolean {
  const preset = listPresets().find((p) => p.name === name);
  if (!preset) return false;
  if (preset.applyFn) {
    return preset.applyFn(nodeId, atTime, defaultAnimation);
  }
  applyPresetTracks(nodeId, preset.tracks, atTime);
  return true;
}

/** Delete a user preset (built-ins can't be deleted). */
export function deletePreset(name: string): void {
  writeUserPresets(readUserPresets().filter((p) => p.name !== name));
}
