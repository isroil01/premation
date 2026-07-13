/**
 * Customizable keyboard shortcuts (Prompt E10). Users can rebind or disable any
 * command's chord; the overrides persist via the SettingsManager and are applied
 * over the command registry's defaults by the ShortcutManager.
 *
 * An override value of `null` means "disabled" (the command keeps no chord). A
 * missing entry means "use the command's default". The conflict detector is a
 * pure function so the editor UI can warn before committing a rebind.
 */

import type { KeyChord } from '@app-types/common';
import { chordKey } from '@core/commands/Command';
import { getSettingsManager } from '@core/services/coreServices';

/** commandId → chord (rebind) or null (disabled). Absent = use default. */
export type ShortcutOverrides = Record<string, KeyChord | null>;

const SETTINGS_KEY = 'shortcutOverrides';

export function getShortcutOverrides(): ShortcutOverrides {
  try {
    return getSettingsManager().get<ShortcutOverrides>(SETTINGS_KEY, {});
  } catch {
    return {};
  }
}

function persist(overrides: ShortcutOverrides): void {
  try {
    getSettingsManager().set<ShortcutOverrides>(SETTINGS_KEY, overrides);
  } catch {
    /* settings not booted — DOM/apply side still runs via the caller */
  }
}

/** Set (or, with null, disable) a command's chord. */
export function setShortcutOverride(commandId: string, chord: KeyChord | null): void {
  persist({ ...getShortcutOverrides(), [commandId]: chord });
}

/** Remove a command's override (revert to its default chord). */
export function clearShortcutOverride(commandId: string): void {
  const next = { ...getShortcutOverrides() };
  delete next[commandId];
  persist(next);
}

/** Clear ALL overrides (reset shortcuts to defaults). */
export function clearAllShortcutOverrides(): void {
  persist({});
}

/**
 * The effective chord for a command given its default and the override map:
 *   override present → that chord (null = disabled → no chord)
 *   override absent  → the default chord
 */
export function resolveChord(
  commandId: string,
  defaultChord: KeyChord | undefined,
  overrides: ShortcutOverrides,
): KeyChord | undefined {
  if (commandId in overrides) return overrides[commandId] ?? undefined;
  return defaultChord;
}

/**
 * Find a command that already uses `chord` (other than `commandId`). Returns the
 * conflicting commandId, or null when the chord is free. Pure — the editor calls
 * this to warn before assigning. `resolved` is the list of currently-effective
 * (commandId, chord) bindings.
 */
export function findChordConflict(
  chord: KeyChord,
  commandId: string,
  resolved: ReadonlyArray<{ commandId: string; chord: KeyChord | undefined }>,
): string | null {
  const target = chordKey(chord);
  for (const b of resolved) {
    if (b.commandId === commandId) continue;
    if (b.chord && chordKey(b.chord) === target) return b.commandId;
  }
  return null;
}
