/**
 * Pasteboard (canvas surround) colour — the void AROUND the composition. It's a
 * theme token (`--color-workspace`) by default; this lets the user override it
 * with a custom colour, persisted via the existing SettingsManager (Prompt E1).
 *
 * An empty string clears the override and falls back to the active theme token.
 */

import { getSettingsManager } from '@core/services/coreServices';

const SETTINGS_KEY = 'pasteboardColor';
const CSS_VAR = '--color-workspace';

/** Read the persisted override ('' when none / using the theme default). */
export function getPasteboardColor(): string {
  try {
    return getSettingsManager().get<string>(SETTINGS_KEY, '');
  } catch {
    return '';
  }
}

/** Apply an override to the document root (or clear it when empty). Pure DOM. */
function applyToRoot(color: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (color) root.style.setProperty(CSS_VAR, color);
  else root.style.removeProperty(CSS_VAR);
}

/** Persist + apply a pasteboard colour override ('' clears it). */
export function setPasteboardColor(color: string): void {
  try {
    getSettingsManager().set<string>(SETTINGS_KEY, color);
  } catch {
    /* settings not booted — the caller still gets the live DOM change below */
  }
  applyToRoot(color);
}

/** Apply the persisted override at boot (called from Providers, like the theme). */
export function applyPasteboardColor(): void {
  applyToRoot(getPasteboardColor());
}
