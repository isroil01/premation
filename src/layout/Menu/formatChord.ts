/**
 * Format a key chord as a compact, human‑readable shortcut label (e.g. ⌘⇧K).
 * Single source of truth for the menu bar and the compact menu button.
 */

import type { KeyChord } from '@app-types/common';

export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.meta) parts.push('⌘');
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push('⌥');
  if (chord.shift) parts.push('⇧');
  parts.push(chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return parts.join('');
}
