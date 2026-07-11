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
  uiScale: number;            // 0.75 .. 1.5
  showStatusBar: boolean;
  showToolbar: boolean;
  timelineSnapToGrid: boolean;
  timelineFrameRate: number; // future timeline engine reads this
  timelineAutoKeyframe: boolean;
  editorReduceMotion: boolean;
  confirmOnClose: boolean;
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
  showStatusBar: true,
  showToolbar: true,
  timelineSnapToGrid: true,
  timelineFrameRate: 60,
  timelineAutoKeyframe: false,
  editorReduceMotion: false,
  confirmOnClose: true,
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
    },

    setMany: (values) => {
      set((s) => {
        for (const [k, v] of Object.entries(values)) {
          (s as unknown as Record<string, unknown>)[k] = v;
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

/** Apply persisted preferences to the document (theme attribute, etc.). */
export async function applyPreferencesToDocument(): Promise<void> {
  const stored = await backend.read();
  if (stored) {
    usePreferenceStore.getState().setMany(stored);
  }
  const { theme } = usePreferenceStore.getState();
  document.documentElement.setAttribute('data-theme', theme as unknown as string);
}
