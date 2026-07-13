/**
 * Accent colour customization (Prompt E10). Overrides the theme's primary
 * accent (`--color-primary`) with a user-chosen colour, persisted via the
 * SettingsManager — the same mechanism as the E1 pasteboard colour. An empty
 * value clears the override and falls back to the active theme token.
 */

import { getSettingsManager } from '@core/services/coreServices';

const SETTINGS_KEY = 'accentColor';
const CSS_VAR = '--color-primary';

export function getAccentColor(): string {
  try {
    return getSettingsManager().get<string>(SETTINGS_KEY, '');
  } catch {
    return '';
  }
}

function applyToRoot(color: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (color) root.style.setProperty(CSS_VAR, color);
  else root.style.removeProperty(CSS_VAR);
}

/** Persist + apply an accent override ('' clears it). */
export function setAccentColor(color: string): void {
  try {
    getSettingsManager().set<string>(SETTINGS_KEY, color);
  } catch {
    /* not booted — caller still gets the live DOM change below */
  }
  applyToRoot(color);
}

/** Apply the persisted accent at boot (called from Providers, like the theme). */
export function applyAccentColor(): void {
  applyToRoot(getAccentColor());
}
