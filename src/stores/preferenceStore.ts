/**
 * Preference store — user-visible settings that persist across sessions.
 *
 * Storage backend is intentionally abstracted via the `preferenceBackend`
 * interface so we can swap localStorage / IndexedDB / a config file without
 * touching components.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ThemeId } from '@app-types/common';
import { asThemeId } from '@app-types/common';
import { getEventBus } from '@core/events/EventBus';

export interface Preferences {
  theme: ThemeId;
  /** Whole-UI zoom, 0.75 .. 1.5 (applied as document zoom). */
  uiScale: number;
  timelineAutoKeyframe: boolean;
  /** Disables UI transitions/animations (accessibility / low-power). */
  editorReduceMotion: boolean;
  /** Ask before discarding unsaved changes on New/Open/Close. */
  confirmOnClose: boolean;
  /**
   * Width of the timeline's track-header column, px.
   *
   * A preference, not view state: how much room the property names and their
   * value fields need is a per-person, per-monitor decision, and re-dragging it
   * on every launch would undo the point of the control.
   */
  timelineHeaderWidth: number;
}

interface PreferenceActions {
  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void;
  setMany(values: Partial<Preferences>): void;
  reset(): void;
}

export type PreferenceStore = Preferences & PreferenceActions;

export const DEFAULT_PREFERENCES: Preferences = {
  theme: asThemeId('dark'),
  uiScale: 1,
  timelineAutoKeyframe: false,
  editorReduceMotion: false,
  confirmOnClose: true,
  timelineHeaderWidth: 460,
};

/** Pluggable persistence backend. */
export interface PreferenceBackend {
  read(): Promise<Partial<Preferences> | null>;
  write(values: Preferences): Promise<void>;
}

/** localStorage backend (default). */
export const localStorageBackend: PreferenceBackend = {
  async read() {
    try {
      const raw = window.localStorage.getItem('motion-editor.preferences');
      if (!raw) return null;
      return JSON.parse(raw) as Partial<Preferences>;
    } catch {
      return null;
    }
  },
  async write(values) {
    try {
      window.localStorage.setItem('motion-editor.preferences', JSON.stringify(values));
    } catch {
      // ignore quota errors
    }
  },
};

let backend: PreferenceBackend = localStorageBackend;

export function setPreferenceBackend(b: PreferenceBackend): void {
  backend = b;
}

export const usePreferenceStore = create<PreferenceStore>()(
  immer((set, get) => ({
    ...DEFAULT_PREFERENCES,

    set: (key, value) => {
      set((s) => {
        (s as Preferences)[key] = value;
      });
      const next = { ...get() } as Preferences;
      // Strip actions when persisting.
      delete (next as unknown as { set?: unknown }).set;
      delete (next as unknown as { setMany?: unknown }).setMany;
      delete (next as unknown as { reset?: unknown }).reset;
      void backend.write(next);

      if (key === 'theme') {
        getEventBus().emit('ThemeChanged', {
          from: 'previous',
          to: value as unknown as string,
        });
      }
      // Document-level prefs take effect immediately.
      if (key === 'uiScale' || key === 'editorReduceMotion') applyUiPreferences();
    },

    setMany: (values) => {
      set((s) => {
        for (const [k, v] of Object.entries(values)) {
          // Only known preference keys — stale persisted fields (from removed
          // prefs) must not resurrect as dead state.
          if (k in DEFAULT_PREFERENCES) (s as unknown as Record<string, unknown>)[k] = v;
        }
      });
      void backend.write({ ...get() } as Preferences);
    },

    reset: () => {
      set((s) => Object.assign(s, DEFAULT_PREFERENCES));
      void backend.write(DEFAULT_PREFERENCES);
    },
  })),
);

/** Push the document-level preferences (zoom + reduced motion) onto the DOM. */
export function applyUiPreferences(): void {
  const { uiScale, editorReduceMotion } = usePreferenceStore.getState();
  const root = document.documentElement as HTMLElement & { style: CSSStyleDeclaration & { zoom?: string } };
  root.style.zoom = uiScale === 1 ? '' : String(uiScale);
  root.classList.toggle('reduce-motion', editorReduceMotion);
}

/** Apply persisted preferences to the document (theme attribute, zoom, etc.). */
export async function applyPreferencesToDocument(): Promise<void> {
  const stored = await backend.read();
  if (stored) {
    usePreferenceStore.getState().setMany(stored);
  }
  const { theme } = usePreferenceStore.getState();
  document.documentElement.setAttribute('data-theme', theme as unknown as string);
  applyUiPreferences();
}
