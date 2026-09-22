/**
 * Format a key chord as a compact, human‑readable shortcut label.
 * Single source of truth for the menu bar, the context menus, the command
 * palette, the tool tooltips and the shortcuts dialog.
 *
 * Two spellings, because the two keyboards are labelled differently:
 *
 *   Mac              ⌃⌥⇧⌘K      glyphs, run together, Apple's modifier order
 *   Windows / Linux  Ctrl+Alt+Shift+K   the words printed on the keycaps
 *
 * The glyphs used to be emitted everywhere, so a Windows menu read "Ctrl⌥⇧L"
 * and a tooltip "Text Tool (CtrlT)" — ⌥ and ⇧ are printed on no PC keyboard,
 * and with no separator "CtrlT" reads as one word.
 *
 * This follows the KEYBOARD, not the chrome: `PREMATION_UI_PLATFORM=mac` on a
 * Windows machine draws a Mac bar that still answers to Ctrl (see
 * `core/config/uiPlatform.ts`), so its labels must still say Ctrl.
 */

import type { KeyChord } from '@app-types/common';

/** Read per call, not at module load, so a test can swap `navigator.platform`. */
export function isMacKeyboard(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

/** The chord's keys in display order — one entry per keycap. */
export function chordKeys(chord: KeyChord, mac: boolean = isMacKeyboard()): string[] {
  const keys: string[] = [];
  if (mac) {
    if (chord.ctrl) keys.push('⌃');
    if (chord.alt) keys.push('⌥');
    if (chord.shift) keys.push('⇧');
    if (chord.meta) keys.push('⌘');
  } else {
    if (chord.ctrl) keys.push('Ctrl');
    if (chord.alt) keys.push('Alt');
    if (chord.shift) keys.push('Shift');
    if (chord.meta) keys.push('Win');
  }
  keys.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return keys;
}

export function formatChord(chord: KeyChord, mac: boolean = isMacKeyboard()): string {
  return chordKeys(chord, mac).join(mac ? '' : '+');
}
