/**
 * Pasteboard (canvas surround) colour — the area AROUND the composition. It's a
 * theme token (`--color-pasteboard`) by default; this lets the user override it
 * with a custom colour, persisted via the existing SettingsManager (Prompt E1).
 *
 * Targets `--color-pasteboard` (not `--color-workspace`) so the override only
 * affects the editor's comp surround, not other surfaces (auth, presentation)
 * that share the workspace void token.
 *
 * An empty string clears the override and falls back to the active theme token.
 */

import { getSettingsManager } from '@core/services/coreServices';

const SETTINGS_KEY = 'pasteboardColor';
const CSS_VAR = '--color-pasteboard';

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

/** Apply at boot (called from Providers, like the theme). The pasteboard is now
 *  a single fixed theme colour and is no longer user-customizable, so any legacy
 *  persisted override is intentionally ignored — clear it so the body always
 *  reads the one `--color-pasteboard` value from the active theme. */
export function applyPasteboardColor(): void {
  applyToRoot('');
}
