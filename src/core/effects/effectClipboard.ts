/**
 * Copy / paste effects between layers, and save a configured stack as a preset.
 *
 * An effect is plain JSON, so both operations are mostly about IDENTITY rather
 * than data: a pasted effect must get a FRESH id, because ids key the keyframe
 * prop paths (`effect.<id>.<param>`) and the renderer's per-effect caching.
 * Pasting a stack that kept its source ids would make two layers' effects share
 * one animation track — edit one, both move.
 *
 * Keyframed parameters come along. The tracks live on the SOURCE node under the
 * source effect's id, so they are copied out and re-keyed onto the target's new
 * id; without that, pasting a pulsing glow lands a static one and the animation
 * silently disappears.
 */

import { defaultAnimation, type Keyframe } from '@motion/animation';
import { getNodeEffects, writeNodeEffects, effectPropPath, type Effect } from './effects';

export interface CopiedEffect {
  effect: Effect;
  /** Keyframe tracks for this effect, keyed by the param suffix after its id. */
  tracks: Record<string, Keyframe[]>;
}

let clipboard: CopiedEffect[] = [];

/** True when at least one effect has been copied this session. */
export function hasEffectClipboard(): boolean {
  return clipboard.length > 0;
}

/** How many effects are on the clipboard (for menu labels). */
export function effectClipboardSize(): number {
  return clipboard.length;
}

/**
 * Collect an effect plus every keyframe track belonging to it.
 *
 * Track paths are `effect.<id>.<param>`, so the portable part is everything
 * after the id — that is what gets re-prefixed on paste.
 */
export function captureEffect(nodeId: string, effect: Effect): CopiedEffect {
  const prefix = `${effectPropPath(effect.id)}.`;
  const tracks: Record<string, Keyframe[]> = {};
  for (const track of defaultAnimation.tracksFor(nodeId)) {
    if (!track.prop.startsWith(prefix)) continue;
    const kfs = defaultAnimation.getTrackKeyframes(nodeId, track.prop);
    if (kfs && kfs.length) tracks[track.prop.slice(prefix.length)] = kfs;
  }
  // The legacy single-scalar track is `effect.<id>` with no param suffix.
  const legacy = defaultAnimation.getTrackKeyframes(nodeId, effectPropPath(effect.id));
  if (legacy && legacy.length) tracks[''] = legacy;
  return { effect: structuredClone(effect), tracks };
}

/** Copy specific effects off a layer (order preserved). */
export function copyEffects(nodeId: string, effectIds: readonly string[]): void {
  const wanted = new Set(effectIds);
  const picked = getNodeEffects(nodeId).filter((e) => wanted.has(e.id));
  if (picked.length) clipboard = picked.map((e) => captureEffect(nodeId, e));
}

/** Copy a layer's ENTIRE effect stack. */
export function copyAllEffects(nodeId: string): void {
  const all = getNodeEffects(nodeId);
  if (all.length) clipboard = all.map((e) => captureEffect(nodeId, e));
}

let pasteSeq = 0;

/**
 * Paste the clipboard onto each target layer, appending to whatever is already
 * there (AE appends too — a paste that replaced the stack would be a
 * destructive surprise).
 *
 * Returns the number of effects pasted per layer, or 0 when the clipboard is
 * empty.
 */
export function pasteEffects(targetNodeIds: readonly string[]): number {
  if (clipboard.length === 0 || targetNodeIds.length === 0) return 0;

  for (const nodeId of targetNodeIds) {
    const existing = getNodeEffects(nodeId);
    const added: Effect[] = [];
    for (const item of clipboard) {
      // A FRESH id per paste per target — see the file docblock.
      const id = `fx_paste_${(pasteSeq += 1)}`;
      added.push({ ...structuredClone(item.effect), id });
      for (const [suffix, kfs] of Object.entries(item.tracks)) {
        const prop = suffix === '' ? effectPropPath(id) : `${effectPropPath(id)}.${suffix}`;
        defaultAnimation.setTrackKeyframes(nodeId, prop, kfs.map((k) => ({ ...k })));
      }
    }
    writeNodeEffects(nodeId, [...existing, ...added]);
  }
  return clipboard.length;
}

/** Forget the clipboard (used by tests; there is no UI for it). */
export function clearEffectClipboard(): void {
  clipboard = [];
}

// ── Presets ────────────────────────────────────────────────────────

const PRESET_KEY = 'motion-editor.effectPresets.v1';

export interface EffectPreset {
  name: string;
  /** The captured stack, ids and all — re-keyed on apply exactly like a paste. */
  items: CopiedEffect[];
}

function readPresets(): EffectPreset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as EffectPreset[]) : [];
  } catch {
    return [];
  }
}

function writePresets(list: EffectPreset[]): void {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list));
  } catch {
    /* quota / private mode — presets are a convenience, not project data */
  }
}

/** Every saved preset, newest last. */
export function listEffectPresets(): EffectPreset[] {
  return readPresets();
}

/**
 * Save a layer's whole effect stack under `name`, replacing any preset of the
 * same name. Returns false when the layer has no effects to save.
 */
export function saveEffectPreset(nodeId: string, name: string): boolean {
  const all = getNodeEffects(nodeId);
  if (all.length === 0) return false;
  const items = all.map((e) => captureEffect(nodeId, e));
  writePresets([...readPresets().filter((p) => p.name !== name), { name, items }]);
  return true;
}

/** Apply a saved preset to layers, appending like a paste. Returns false when
 *  the preset is missing. */
export function applyEffectPreset(name: string, targetNodeIds: readonly string[]): boolean {
  const preset = readPresets().find((p) => p.name === name);
  if (!preset) return false;
  const previous = clipboard;
  clipboard = preset.items;
  pasteEffects(targetNodeIds);
  clipboard = previous;
  return true;
}

export function deleteEffectPreset(name: string): void {
  writePresets(readPresets().filter((p) => p.name !== name));
}
