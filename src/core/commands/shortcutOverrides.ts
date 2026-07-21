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

/**
 * The default preset mirrors After Effects' toolbar keymap, so a user arriving
 * with AE muscle memory finds the tools where their hand expects them.
 *
 * `A` is deliberately left to the reveal-anchor-point shortcut (AE's meaning);
 * Direct Selection moves to Shift+V rather than taking it.
 *
 * Only list genuine overrides. `rehydrateFromRegistry` walks the REGISTRY, so
 * an entry naming a command that doesn't exist binds nothing — it just reads
 * like a working shortcut to whoever opens this file next. ('timeline.revealAudio'
 * and 'edit.deselectAll.f2' both sat here doing exactly that; L reveals audio
 * via the reveal listener in App.tsx, not through a command.)
 */
export const AE_PRESET: ShortcutOverrides = {
  'tool.direct-select': { key: 'v', shift: true },
  'view.graphEditor': { key: 'F3', shift: true },
};

export const DEFAULT_PRESET: ShortcutOverrides = AE_PRESET;

const SETTINGS_KEY = 'shortcutOverrides';

export function getShortcutOverrides(): ShortcutOverrides {
  try {
    return getSettingsManager().get<ShortcutOverrides>(SETTINGS_KEY, DEFAULT_PRESET);
  } catch {
    return DEFAULT_PRESET;
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

export function resolveChord(
  commandId: string,
  defaultChord: KeyChord | undefined,
  overrides: ShortcutOverrides,
): KeyChord | undefined {
  const chord = commandId in overrides ? (overrides[commandId] ?? undefined) : defaultChord;
  if (!chord) return undefined;

  const isTest = typeof process !== 'undefined' && process.env.NODE_ENV === 'test';
  if (!isTest) {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    if (!isMac && chord.meta) {
      return {
        ...chord,
        ctrl: true,
        meta: false,
      };
    }
  }
  return chord;
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
