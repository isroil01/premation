/**
 * Animation presets. Capture a layer's animation as a named preset, then
 * re-apply it to any other layer — anchored at the playhead, as one undoable
 * command, so "everything stays editable and reversible" is literally true.
 *
 * The architectural point, and the reason this file is small: a preset is NOT a
 * special object type. It is a serialized set of property values, keyframes and
 * text animators, applied on top of a layer. Nothing is hidden and nothing is
 * baked — after applying, every keyframe is an ordinary keyframe the user can
 * drag. That is true in AE too (apply a preset, press U, and you see exactly
 * what its designer did), and it is why the entire preset system costs almost
 * nothing once properties are tracks. The library CONTENT is the product.
 *
 * Two things are stored relative rather than absolute:
 *   • TIMES, relative to the preset's start (t = 0); applying adds the playhead.
 *   • VALUES, relative to the comp / layer / font size — see presetUnits.ts for
 *     why baking pixels is the one thing not to copy from AE.
 */

import {  type AnimationEngine, type Keyframe, type PropPath } from '@motion/animation';
import { getSettingsManager } from '@core/services/coreServices';
import { documentMirror, hasDocumentMirror } from '@stores/documentMirror';
import { storedStaticNumber } from '@core/mirror/trackIndex';
import {    type EffectParams, type EffectType } from '@core/effects/effects';
import {
  unitPositions,
  type TextAnimatorData,
} from '@core/text/textAnimators';
import {
  resolveUnitTime,
  resolveUnitValue,
  type PresetContext,
  type PresetTimeUnit,
  type PresetUnit,
} from './presetUnits';
import { TEXT_PRESETS } from './textPresets';
import { BEHAVIOR_PRESETS } from './behaviorPresets';
import { SCENERY_PRESETS } from './sceneryPresets';
import { FILM_LOOK_PRESETS } from './filmLookPresets';
import { CAMERA_PRESETS } from './cameraPresets';

export interface PresetTrack {
  prop: PropPath;
  keyframes: Keyframe[];
  /** Relative tracks store OFFSETS from the layer's current value — applying
   *  adds the layer's base value to every keyframe (how "Slide In Left" works
   *  on a layer at any position). Absolute tracks replay exact values. */
  relative?: boolean;
  /** What this track's numbers are measured in. Omitted = 'abs', which is what
   *  every pre-units preset meant, so old data replays unchanged. */
  unit?: PresetUnit;
}

export interface AnimationPreset {
  name: string;
  builtin?: boolean;
  /** Slash-separated location in the library tree, e.g. `Text/Animate In`.
   *  Falls back to `category` for presets written before the tree existed. */
  folder?: string;
  category?: string;
  /** One line for the panel and the tooltip. */
  description?: string;
  /** What this preset needs to do anything. A text-animator preset applied to a
   *  rectangle is a no-op, and the panel should say so rather than pretend.
   *  `camera` presets keyframe props only a camera layer reads (orbit, focal
   *  length), and on an ordinary layer would flip its 3D switch besides. */
  requires?: 'text' | 'camera' | 'any';
  tracks: PresetTrack[];
  /**
   * Text animators the preset installs before its tracks run. This is what lets
   * a per-character preset be DATA rather than a hand-written applier — the
   * animator rig is just more serialized state, and its `ta.*` prop-paths are
   * ordinary tracks in the list above.
   */
  animators?: TextAnimatorData[];
  /**
   * BEHAVIOURS: expressions installed on properties instead of keyframes.
   *
   * A keyframed preset states what happens at fixed times, so it has a fixed
   * length and must be retimed by hand when the layer's does not match. A
   * behaviour states a RULE — "fade over the first and last fifteen percent",
   * "drift continuously" — and therefore adapts to the composition on its own
   * and never ends. That is a different product from a preset, not a variant of
   * one, and it is why these are declared separately rather than smuggled in
   * through `applier`.
   *
   * Data, not a callback, for the same reason preset tracks are: it can be
   * inspected, previewed, and round-tripped without executing anything.
   */
  expressions?: Array<{ prop: PropPath; expr: string }>;
  /**
   * Effects the preset installs, appended to the layer's existing stack.
   *
   * Ids here are the preset's OWN namespace (`fx0`, `fx1`, …) and are rewritten
   * to unique ones on apply, with the preset's `effect.<id>.<param>` tracks
   * re-pointed to match — same problem and same solution as animator indices.
   * Without it, applying a transition to a layer that already has effects would
   * keyframe whichever effect happened to share the id.
   */
  effects?: Array<{ id: string; type: EffectType; params?: EffectParams }>;
  /** How `keyframes[].t` is measured. Omitted = seconds. */
  timeUnit?: PresetTimeUnit;
  /**
   * Escape hatch for rigs that genuinely need code, by NAME (the code is in
   * `PRESET_APPLIERS`, run by `applyPreset`). Prefer data.
   */
  applier?: 'dollyZoom';
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
    ...t,
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
    return { ...t, keyframes: t.keyframes.map((k) => ({ ...k, value: base + k.value })) };
  });
}

/** Sensible base values when a layer doesn't carry the property explicitly. */
const DEFAULT_BASE: Record<string, number> = { scale: 1, rotation: 0, opacity: 100, x: 0, y: 0 };

/**
 * Resolve relative UNITS into concrete numbers (and times), leaving `abs`
 * tracks untouched.
 *
 * Runs BEFORE `resolveRelativeTracks`: a track can be both "a quarter of the
 * comp width" and "relative to where the layer already is", and the layer's own
 * position is already in pixels, so the fraction has to become pixels first.
 * Pure — the context is supplied.
 */
export function resolvePresetUnits(
  tracks: ReadonlyArray<PresetTrack>,
  ctx: PresetContext,
  timeUnit?: PresetTimeUnit,
): PresetTrack[] {
  return tracks.map((t) => ({
    ...t,
    unit: 'abs' as const,
    keyframes: t.keyframes.map((k) => ({
      ...k,
      t: resolveUnitTime(k.t, timeUnit, ctx),
      value: resolveUnitValue(k.value, t.unit, ctx),
    })),
  }));
}

/** The layer's current value for a property: sampled animation first, then the
 *  STATIC value the layer stores for it (stored units; read on the document
 *  mirror — its property tree must be loaded, core/engine/memberEdits.ts). */
export function nodeBaseValue(
  nodeId: string,
  prop: PropPath,
  atTime: number,
  engine: AnimationEngine,
): number | undefined {
  const sampled = engine.sample(nodeId, prop, atTime);
  if (sampled !== undefined) return sampled;
  return hasDocumentMirror() ? storedStaticNumber(documentMirror().tree(nodeId), prop) : undefined;
}

// ── Built-in presets (position-agnostic so they suit any layer) ──────

// (An un-eased `kf` helper lived here. Its only users were Glitch Jitter and
// Wiggle Drift, both cut as duplicates of Shake — and un-eased keyframes are
// exactly what made them read as stuttery rather than as motion.)

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
    description: 'Gradually fade opacity from 0% to 100%.',
    category: 'Entrances',
    tracks: [{ prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.5, 100)] }],
  },
  {
    name: 'Pop In',
    builtin: true,
    description: 'Scale up with a bouncing animation.',
    category: 'Entrances',
    tracks: [
      { prop: 'scale', keyframes: [kfb(0, 0, OVERSHOOT_EASE), kfb(0.5, 1)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: 'Slide In',
    builtin: true,
    description: 'Slide into view horizontally.',
    category: 'Entrances',
    tracks: [
      { prop: 'x', relative: true, unit: 'compW', keyframes: [kfb(0, -0.21, SNAPPY_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.35, 100)] },
    ],
  },
  {
    name: 'Rise Up',
    builtin: true,
    description: 'Slide up into view from below.',
    category: 'Entrances',
    tracks: [
      { prop: 'y', relative: true, unit: 'compH', keyframes: [kfb(0, 0.11, SNAPPY_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.4, 100)] },
    ],
  },

  // ── Exits ──────────────────────────────────────────────────────────
  {
    name: 'Fade Out',
    builtin: true,
    description: 'Gradually fade opacity from 100% to 0%.',
    category: 'Exits',
    tracks: [{ prop: 'opacity', keyframes: [kfb(0, 100, SMOOTH_EASE), kfb(0.5, 0)] }],
  },
  {
    name: 'Zoom Out Exit',
    builtin: true,
    description: 'Slight scale pop, then zoom out to nothing.',
    category: 'Exits',
    tracks: [
      { prop: 'scale', keyframes: [kfb(0, 1, ANTICIPATE_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 100, SMOOTH_EASE), kfb(0.45, 0)] },
    ],
  },

  // ── Emphases & Loops ────────────────────────────────────────────────
  {
    name: 'Spin',
    builtin: true,
    description: 'Rotate 360 degrees around the anchor point.',
    category: 'Emphases & Loops',
    tracks: [{ prop: 'rotation', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(1.0, 360)] }],
  },
  {
    name: 'Pulse',
    builtin: true,
    description: 'Gently grow and shrink in scale.',
    category: 'Emphases & Loops',
    tracks: [{ prop: 'scale', keyframes: [kfb(0, 1, SMOOTH_EASE), kfb(0.4, 1.18, SMOOTH_EASE), kfb(0.8, 1)] }],
  },
  {
    name: 'Shake',
    builtin: true,
    description: 'Rapid rotation oscillations for emphasis.',
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
    name: 'Elastic Float',
    builtin: true,
    description: 'Continuous smooth vertical floating movement.',
    category: 'Emphases & Loops',
    tracks: [
      { prop: 'y', relative: true, unit: 'compH', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.8, -0.0185, SMOOTH_EASE), kfb(1.6, 0)] },
    ],
  },

  // ── 3D Motions ─────────────────────────────────────────────────────
  {
    name: 'Flip In 3D',
    builtin: true,
    description: 'Smooth entry flip around the 3D Y-axis.',
    category: '3D Motions',
    tracks: [
      { prop: 'rotationY', keyframes: [kfb(0, -90, SNAPPY_EASE), kfb(0.6, 0, SMOOTH_EASE)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: 'Swing In 3D',
    builtin: true,
    description: 'Pendulum-like swing from the top axis.',
    category: '3D Motions',
    tracks: [
      { prop: 'rotationX', keyframes: [kfb(0, -80, BOUNCE_EASE), kfb(0.6, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.25, 100)] },
    ],
  },
  {
    name: 'Depth Push In',
    builtin: true,
    description: 'Push forward from deep Z space.',
    category: '3D Motions',
    tracks: [
      { prop: 'z', unit: 'compMin', keyframes: [kfb(0, 0.74, SNAPPY_EASE), kfb(0.8, 0)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.35, 100)] },
    ],
  },
  {
    name: '3D Twirl In',
    builtin: true,
    description: 'Spin X and Y axes while scaling up into view.',
    category: '3D Motions',
    tracks: [
      { prop: 'rotationX', keyframes: [kfb(0, -180, SNAPPY_EASE), kfb(0.7, 0)] },
      { prop: 'rotationY', keyframes: [kfb(0, -180, SNAPPY_EASE), kfb(0.7, 0)] },
      { prop: 'scale', keyframes: [kfb(0, 0, OVERSHOOT_EASE), kfb(0.7, 1)] },
      { prop: 'opacity', keyframes: [kfb(0, 0, SMOOTH_EASE), kfb(0.3, 100)] },
    ],
  },
  {
    name: 'Cinematic Pan 3D',
    builtin: true,
    description: 'Gentle 3D parallax rotation and depth panning.',
    category: '3D Motions',
    tracks: [
      { prop: 'rotationY', keyframes: [kfb(0, -15, SMOOTH_EASE), kfb(1.8, 15)] },
      { prop: 'rotationX', keyframes: [kfb(0, 10, SMOOTH_EASE), kfb(1.8, -5)] },
      { prop: 'z', unit: 'compMin', keyframes: [kfb(0, 0.185, SMOOTH_EASE), kfb(1.8, -0.093)] },
    ],
  },

  // The four hand-coded text-animator presets that used to live here
  // (Typewriter, Bounce In Words, Spin & Fade Characters, Tracking Reveal) are
  // now DATA in textPresets.ts, alongside two dozen more. Keeping both would
  // have put two "Typewriter" entries in the panel, one of which ignored the
  // comp size. The `keyframeAssistants` functions they called still exist —
  // the inspector's one-click button and the AI tools use them directly.
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

/**
 * Bundle format written by {@link exportPresets} and accepted by
 * {@link importPresets}.
 *
 * Versioned from the first release, because the alternative — a bare array —
 * cannot tell "an older bundle" from "not a bundle" from "a newer bundle this
 * build should refuse". Presets are the one thing users hand to each other, so
 * the file has to survive being opened by a build that predates it.
 */
export const PRESET_BUNDLE_FORMAT = 'premation-preset-bundle';
export const PRESET_BUNDLE_VERSION = 1;

export interface PresetBundle {
  format: typeof PRESET_BUNDLE_FORMAT;
  version: number;
  presets: AnimationPreset[];
}

/** Outcome of an import, per preset, so a partial success can be reported as one. */
export interface PresetImportResult {
  added: string[];
  /** Replaced an existing user preset of the same name. */
  replaced: string[];
  /** Entries the file contained that were not usable presets. */
  rejected: number;
  error?: string;
}

/**
 * Serialize user presets to a shareable bundle.
 *
 * `names` selects a subset; omitted exports every user preset. Built-ins are
 * never exported — they ship with the app, so a bundle carrying them would
 * duplicate them on import into a build that already has them (and pin a stale
 * copy of one that has since been improved).
 */
export function exportPresets(names?: readonly string[]): string {
  const wanted = names && names.length > 0 ? new Set(names) : null;
  const presets = readUserPresets()
    .filter((p) => !p.builtin)
    .filter((p) => !wanted || wanted.has(p.name));
  const bundle: PresetBundle = {
    format: PRESET_BUNDLE_FORMAT,
    version: PRESET_BUNDLE_VERSION,
    presets,
  };
  return `${JSON.stringify(bundle, null, 2)}
`;
}

/**
 * How many presets {@link exportPresets} would actually write.
 *
 * Filtering `listPresets()` by `!p.builtin` gives the same answer today — all
 * 84 compiled-in presets carry the flag, which was measured rather than
 * assumed. But it gets there by a different route: `listPresets` concatenates
 * six shipped arrays with the user's, so that filter is only correct for as
 * long as every entry in all five stays flagged, and a new array added without
 * the flag would silently be counted as the user's.
 *
 * This shares `readUserPresets` with `exportPresets` instead, so the count is
 * correct by construction — it cannot disagree with the file.
 */
export function countUserPresets(): number {
  return readUserPresets().filter((p) => !p.builtin).length;
}

/**
 * STRUCTURAL validity of one entry from an untrusted file.
 *
 * Deliberately shallow, and worth being explicit about: it checks that an entry
 * is shaped like a preset, NOT that its tracks describe a sane animation. Deep
 * validation would mean a second copy of `PresetTrack`'s rules here, drifting
 * from the real one — the defect shape this repo keeps finding. A structurally
 * valid preset with nonsense inside applies as a no-op, which is a bad preset
 * rather than a broken editor; a structurally INVALID one is what would throw
 * somewhere far from the import.
 */
function isPresetLike(v: unknown): v is AnimationPreset {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<AnimationPreset>;
  if (typeof p.name !== 'string' || p.name.trim() === '') return false;
  if (!Array.isArray(p.tracks)) return false;
  if (p.animators !== undefined && !Array.isArray(p.animators)) return false;
  return true;
}

/**
 * Merge a bundle into the user's presets.
 *
 * Collisions overwrite BY NAME, which is not a new rule — `saveCurrentAsPreset`
 * already replaces a same-named preset rather than accumulating duplicates, and
 * an import that behaved differently from a save would make the library's
 * identity depend on how an entry got there.
 *
 * `builtin` is stripped from every imported preset. A file can claim anything,
 * and a preset that arrives marked built-in would be undeletable through the
 * panel and would shadow a real one.
 */
export function importPresets(json: string): PresetImportResult {
  const empty: PresetImportResult = { added: [], replaced: [], rejected: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ...empty, error: 'Not a valid JSON file.' };
  }
  const b = parsed as Partial<PresetBundle>;
  if (!b || typeof b !== 'object' || b.format !== PRESET_BUNDLE_FORMAT) {
    return { ...empty, error: 'Not a Premation preset bundle.' };
  }
  if (typeof b.version !== 'number' || b.version > PRESET_BUNDLE_VERSION) {
    // Refuse loudly rather than import a subset it half-understands: a newer
    // bundle may carry fields whose ABSENCE changes behaviour, and silently
    // dropping them produces a preset that is wrong rather than missing.
    return { ...empty, error: `Preset bundle version ${String(b.version)} is newer than this build understands.` };
  }
  const incoming = Array.isArray(b.presets) ? b.presets : [];
  return importPresetObjects(incoming);
}

/**
 * Merge already-parsed preset objects into the user's library.
 *
 * The object-level half of {@link importPresets}, exported on its own because
 * presets no longer arrive only as files: the cloud sync (`/v1/animations`)
 * hands back parsed JSON, and re-serialising it just to run it through the
 * file importer would launder a type error into a runtime one.
 *
 * Same rules as the file path: collisions overwrite by name, `builtin` is
 * stripped, entries that are not shaped like presets are counted as rejected.
 */
export function importPresetObjects(incoming: unknown[]): PresetImportResult {
  const empty: PresetImportResult = { added: [], replaced: [], rejected: 0 };
  const usable = incoming.filter(isPresetLike);
  if (usable.length === 0) {
    return { ...empty, rejected: incoming.length, error: 'No usable presets in that file.' };
  }

  const existing = readUserPresets();
  const byName = new Map(existing.map((p) => [p.name, p]));
  const added: string[] = [];
  const replaced: string[] = [];
  for (const p of usable) {
    const { builtin: _builtin, ...rest } = p;
    (byName.has(p.name) ? replaced : added).push(p.name);
    byName.set(p.name, { ...rest, folder: p.folder ?? USER_PRESET_FOLDER });
  }
  writeUserPresets([...byName.values()]);
  return { added, replaced, rejected: incoming.length - usable.length };
}

function writeUserPresets(presets: AnimationPreset[]): void {
  try {
    getSettingsManager().set<AnimationPreset[]>(SETTINGS_KEY, presets);
  } catch {
    /* settings not booted */
  }
}

/** Where saved presets land in the library tree. */
export const USER_PRESET_FOLDER = 'User Presets';

/** All presets — built-ins first, then the user's saved ones, then plugins'. */
export function listPresets(): AnimationPreset[] {
  return [
    ...BUILTIN_PRESETS, ...TEXT_PRESETS, ...BEHAVIOR_PRESETS, ...SCENERY_PRESETS,
    ...FILM_LOOK_PRESETS, ...CAMERA_PRESETS, ...readUserPresets(),
  ];
}

/**
 * A user preset's body as `applyPreset{body}` carries it — the engine knows only
 * the built-ins, so a preset from the user's library travels with the command.
 * Undefined for a built-in (applied by name) or an unknown name.
 */
export function userPresetBody(name: string): string | undefined {
  const p = readUserPresets().find((u) => u.name === name && !u.builtin);
  return p ? JSON.stringify(p) : undefined;
}

/** `{ body }` for a user preset, `{}` otherwise — spread into an `applyPreset` command. */
export function withUserPresetBody(name: string): { body?: string } {
  const body = userPresetBody(name);
  return body ? { body } : {};
}

/** A preset's location in the tree, falling back through the older fields so
 *  presets saved before folders existed still land somewhere sensible. */
export function presetFolder(p: AnimationPreset): string {
  return p.folder ?? p.category ?? (p.builtin ? 'Uncategorised' : USER_PRESET_FOLDER);
}

/** What `capturePresetBody` returns: an AnimationPreset without its name and place in the library. */
export type CapturedPresetBody = Pick<AnimationPreset, 'tracks' | 'animators' | 'requires' | 'effects' | 'expressions'>;

/**
 * Store a captured preset body in the user's library under `name` (a
 * same-named user preset is replaced — the import rule). The library is the
 * editor's, not the document: this writes settings, never the engine.
 */
export function saveUserPreset(name: string, body: CapturedPresetBody, folder = USER_PRESET_FOLDER): void {
  const others = readUserPresets().filter((p) => p.name !== name);
  writeUserPresets([...others, { name, folder, ...body, tracks: body.tracks ?? [] }]);
}

/**
 * Re-index `ta.<i>.…` prop-paths by `shift`.
 *
 * A preset authors its animators from index 0, but applying appends them after
 * whatever the layer already carries. Without this, a preset applied to a layer
 * that already has one animator would keyframe the WRONG animator — silently,
 * and only visibly wrong once the user looked at the first one.
 */
export function reindexAnimatorTracks(
  tracks: ReadonlyArray<PresetTrack>,
  shift: number,
): PresetTrack[] {
  if (!shift) return [...tracks];
  return tracks.map((t) => {
    const m = /^ta\.(\d+)\.(.*)$/.exec(t.prop);
    if (!m) return t;
    return { ...t, prop: `ta.${Number(m[1]) + shift}.${m[2]}` as PropPath };
  });
}

/**
 * Fit a reveal's sweep to the string it is actually being applied to.
 *
 * A reveal parks its window outside the string so the soft edge cannot bleed
 * back over the first and last characters (see textPresets.ts). How far outside
 * it NEEDS to be depends on the soft edge's width, which depends on how many
 * characters the string has — information a static preset cannot have.
 *
 * Authored conservatively enough to be correct on a two-character string, the
 * front then spends most of its travel crossing empty margin on a normal one:
 * measured, only ~30% of the duration had any stagger visible at all, and the
 * rest was dead air at both ends. That reads as a delay followed by everything
 * arriving at once — the exact opposite of the point.
 *
 * So the authored range is remapped onto the range this string actually needs.
 * Keyframe TIMES and easing are untouched; only the values move, so the
 * author's pacing survives intact. Same idea as relative units: the preset
 * declares intent, application resolves it against the real target.
 */
export function fitRevealSweeps(
  preset: AnimationPreset,
  tracks: ReadonlyArray<PresetTrack>,
  text: string | undefined,
): PresetTrack[] {
  const animators = preset.animators;
  if (!animators || !animators.length || !text) return [...tracks];
  return tracks.map((t) => {
    const m = /^ta\.(\d+)\.(start|end)$/.exec(t.prop);
    if (!m) return t;
    const sel = animators[Number(m[1])]?.selectors?.[0];
    if (!sel || sel.kind !== 'range') return t;
    const { count } = unitPositions(text, sel.basedOn);
    if (count <= 0) return t;
    // One unit spans 100/count percent, so a `smoothness` of S characters is
    // S/count of the string; the edge is centred on the boundary, so half of
    // it lies outside. The extra 2% is slack against rounding.
    const halfEdge = sel.smoothness / count / 2;
    const from = -halfEdge - 2;
    const to = 100 + halfEdge + 2;

    const values = t.keyframes.map((k) => k.value);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo;
    if (span === 0) return t;
    return {
      ...t,
      keyframes: t.keyframes.map((k) => ({
        ...k,
        value: from + ((k.value - lo) / span) * (to - from),
      })),
    };
  });
}

/** Rewrite `effect.<presetId>.<param>` track paths onto the installed ids. */
export function remapEffectTracks(
  tracks: ReadonlyArray<PresetTrack>,
  mapping: ReadonlyMap<string, string>,
): PresetTrack[] {
  if (mapping.size === 0) return [...tracks];
  return tracks.map((t) => {
    const m = /^effect\.([^.]+)\.(.*)$/.exec(t.prop);
    const real = m ? mapping.get(m[1]!) : undefined;
    return real ? { ...t, prop: `effect.${real}.${m![2]}` as PropPath } : t;
  });
}

/** Delete a user preset (built-ins can't be deleted). */
export function deletePreset(name: string): void {
  writeUserPresets(readUserPresets().filter((p) => p.name !== name));
}
