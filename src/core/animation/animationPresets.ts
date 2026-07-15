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
  tracks: PresetTrack[];
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

export const BUILTIN_PRESETS: ReadonlyArray<AnimationPreset> = [
  {
    name: 'Fade In',
    builtin: true,
    tracks: [{ prop: 'opacity', keyframes: [kf(0, 0, 'easeOut'), kf(0.5, 100)] }],
  },
  {
    name: 'Fade Out',
    builtin: true,
    tracks: [{ prop: 'opacity', keyframes: [kf(0, 100, 'easeIn'), kf(0.5, 0)] }],
  },
  {
    name: 'Pop In',
    builtin: true,
    tracks: [
      { prop: 'scale', keyframes: [kf(0, 0, 'easeOut'), kf(0.35, 1.08), kf(0.5, 1)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.25, 100)] },
    ],
  },
  {
    name: 'Spin',
    builtin: true,
    tracks: [{ prop: 'rotation', keyframes: [kf(0, 0, 'easeInOut'), kf(1, 360)] }],
  },
  {
    name: 'Pulse',
    builtin: true,
    tracks: [{ prop: 'scale', keyframes: [kf(0, 1, 'easeInOut'), kf(0.4, 1.15), kf(0.8, 1)] }],
  },
  {
    name: 'Bounce In',
    builtin: true,
    tracks: [
      { prop: 'scale', keyframes: [kf(0, 0, 'easeOut'), kf(0.3, 1.15), kf(0.45, 0.95), kf(0.6, 1.04), kf(0.75, 1)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.2, 100)] },
    ],
  },
  {
    name: 'Slide In Left',
    builtin: true,
    tracks: [
      { prop: 'x', relative: true, keyframes: [kf(0, -400, 'easeOut'), kf(0.6, 0)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.35, 100)] },
    ],
  },
  {
    name: 'Slide In Right',
    builtin: true,
    tracks: [
      { prop: 'x', relative: true, keyframes: [kf(0, 400, 'easeOut'), kf(0.6, 0)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.35, 100)] },
    ],
  },
  {
    name: 'Rise Up',
    builtin: true,
    tracks: [
      { prop: 'y', relative: true, keyframes: [kf(0, 120, 'easeOut'), kf(0.6, 0)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.4, 100)] },
    ],
  },
  {
    name: 'Drop In',
    builtin: true,
    tracks: [
      { prop: 'y', relative: true, keyframes: [kf(0, -260, 'easeOut'), kf(0.45, 0), kf(0.6, -24, 'easeOut'), kf(0.75, 0)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.25, 100)] },
    ],
  },
  {
    name: 'Shake',
    builtin: true,
    tracks: [
      { prop: 'rotation', relative: true, keyframes: [kf(0, 0), kf(0.08, 8), kf(0.16, -7), kf(0.24, 5), kf(0.32, -3), kf(0.4, 0)] },
    ],
  },
  // ── 3D presets — applying one auto-enables the layer's 3D switch ──
  {
    name: 'Flip In 3D',
    builtin: true,
    tracks: [
      { prop: 'rotationY', keyframes: [kf(0, -90, 'easeOut'), kf(0.6, 0)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.3, 100)] },
    ],
  },
  {
    name: 'Card Flip 3D',
    builtin: true,
    tracks: [{ prop: 'rotationY', keyframes: [kf(0, 0, 'easeInOut'), kf(0.9, 180)] }],
  },
  {
    name: 'Swing In 3D',
    builtin: true,
    tracks: [
      { prop: 'rotationX', keyframes: [kf(0, -80, 'easeOut'), kf(0.5, 12, 'easeInOut'), kf(0.75, 0)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.25, 100)] },
    ],
  },
  {
    name: 'Depth Push In',
    builtin: true,
    tracks: [
      { prop: 'z', keyframes: [kf(0, 900, 'easeOut'), kf(0.8, 0)] },
      { prop: 'opacity', keyframes: [kf(0, 0), kf(0.35, 100)] },
    ],
  },
  {
    name: 'Orbit Tilt 3D',
    builtin: true,
    tracks: [
      { prop: 'rotationY', keyframes: [kf(0, 0, 'easeInOut'), kf(0.6, 28, 'easeInOut'), kf(1.2, 0)] },
      { prop: 'rotationX', keyframes: [kf(0, 0, 'easeInOut'), kf(0.6, -14, 'easeInOut'), kf(1.2, 0)] },
    ],
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
  applyPresetTracks(nodeId, preset.tracks, atTime);
  return true;
}

/** Delete a user preset (built-ins can't be deleted). */
export function deletePreset(name: string): void {
  writeUserPresets(readUserPresets().filter((p) => p.name !== name));
}
