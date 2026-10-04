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

import {  type Keyframe } from '@motion/animation';
import {    type Effect } from './effects';
import { listBuiltinEffectPresets } from './builtinEffectPresets';

export interface CopiedEffect {
  effect: Effect;
  /** Keyframe tracks for this effect, keyed by the param suffix after its id. */
  tracks: Record<string, Keyframe[]>;
  /**
   * The layer it was copied from (clipboard only, never saved in a preset): a
   * paste whose source is still exactly as copied goes through the engine's
   * `copyPropertyGroups` (B3, layout/Effects/effectEdits.ts).
   */
  sourceNodeId?: string;
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
 * Hold `items` as the clipboard — captures the ENGINE made (`copyEffects`,
 * layout/Effects/effectEdits.ts); module state, never the document. An empty
 * list leaves the clipboard as it was.
 */
export function holdCopiedEffects(items: readonly CopiedEffect[]): void {
  if (items.length > 0) clipboard = items.map((it) => ({ ...it }));
}

/** What is on the clipboard (read-only view for the paste edit). */
export function readEffectClipboard(): readonly CopiedEffect[] {
  return clipboard;
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

/** Every saved preset, newest last — built-ins first, then user presets. */
export function listEffectPresets(): EffectPreset[] {
  const user = readPresets();
  const builtins = listBuiltinEffectPresets();
  // User presets with the same name override the built-in look.
  const overridden = new Set(user.map((p) => p.name));
  return [...builtins.filter((p) => !overridden.has(p.name)), ...user];
}

/**
 * Store captured effects (the engine's `copyEffects` of a whole stack) as the
 * preset `name`, replacing any of the same name — the editor's library
 * (localStorage), never the document. False when there is nothing to store.
 */
export function storeEffectPreset(name: string, items: readonly CopiedEffect[]): boolean {
  if (items.length === 0) return false;
  const clean = items.map(({ sourceNodeId: _src, ...rest }) => rest);
  writePresets([...readPresets().filter((p) => p.name !== name), { name, items: clean }]);
  return true;
}

export function deleteEffectPreset(name: string): void {
  writePresets(readPresets().filter((p) => p.name !== name));
}
