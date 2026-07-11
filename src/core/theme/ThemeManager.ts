/**
 * ThemeManager — single authority for the editor's visual theme.
 *
 * Owns the theme *mode* ('light' | 'dark' | 'system'), resolves 'system' via
 * `prefers-color-scheme`, applies `data-theme` to the document root, reacts to
 * OS theme changes while in system mode, persists the mode via SettingsManager,
 * and announces changes on the EventBus. Concrete themes remain CSS-only
 * (themes/dark.css, themes/light.css) — this just flips the attribute.
 */

import type { SettingsManager } from '@core/settings/SettingsManager';
import { getEventBus } from '@core/events/EventBus';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const SETTINGS_KEY = 'theme.mode';

export interface ThemeManagerOptions {
  settings: SettingsManager;
  defaultMode?: ThemeMode;
  /** Called with the resolved theme whenever it changes (e.g. to mirror into a store). */
  onResolved?: (theme: ResolvedTheme) => void;
}

export class ThemeManager {
  private mode: ThemeMode;
  private resolved: ResolvedTheme;
  private mql: MediaQueryList | null = null;
  private readonly settings: SettingsManager;
  private readonly onResolved?: (theme: ResolvedTheme) => void;
  private readonly listeners = new Set<(t: ResolvedTheme) => void>();

  constructor(opts: ThemeManagerOptions) {
    this.settings = opts.settings;
    this.onResolved = opts.onResolved;
    this.mode = this.settings.get<ThemeMode>(SETTINGS_KEY, opts.defaultMode ?? 'dark');
    this.resolved = this.computeResolved();

    if (typeof window !== 'undefined' && window.matchMedia) {
      this.mql = window.matchMedia('(prefers-color-scheme: dark)');
      this.mql.addEventListener('change', this.handleSystemChange);
    }
  }

  /** Apply the current resolved theme to the document. Call once at boot. */
  apply(): void {
    this.resolved = this.computeResolved();
    this.applyToDocument(this.resolved);
  }

  getMode(): ThemeMode { return this.mode; }
  getResolvedTheme(): ResolvedTheme { return this.resolved; }

  setMode(mode: ThemeMode): void {
    if (mode === this.mode) return;
    const prev = this.resolved;
    this.mode = mode;
    this.settings.set(SETTINGS_KEY, mode);
    this.resolved = this.computeResolved();
    this.applyToDocument(this.resolved);
    if (this.resolved !== prev) this.announce(prev);
  }

  /** Cycle dark → light → system → dark (for a toolbar toggle). */
  cycle(): void {
    const order: ThemeMode[] = ['dark', 'light', 'system'];
    const next = order[(order.indexOf(this.mode) + 1) % order.length]!;
    this.setMode(next);
  }

  /** Toggle strictly between light and dark (ignores system). */
  toggle(): void {
    this.setMode(this.resolved === 'dark' ? 'light' : 'dark');
  }

  subscribe(listener: (t: ResolvedTheme) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.mql?.removeEventListener('change', this.handleSystemChange);
    this.listeners.clear();
  }

  private computeResolved(): ResolvedTheme {
    if (this.mode !== 'system') return this.mode;
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  }

  private applyToDocument(theme: ResolvedTheme): void {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
    }
    this.onResolved?.(theme);
    for (const l of this.listeners) {
      try { l(theme); } catch { /* isolate */ }
    }
  }

  private announce(prev: ResolvedTheme): void {
    getEventBus().emit('ThemeChanged', { from: prev, to: this.resolved });
  }

  private handleSystemChange = (): void => {
    if (this.mode !== 'system') return;
    const prev = this.resolved;
    this.resolved = this.computeResolved();
    if (this.resolved !== prev) {
      this.applyToDocument(this.resolved);
      this.announce(prev);
    }
  };
}
