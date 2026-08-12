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
  /** Whole-UI zoom, 0.75.. 1.5 (applied as document zoom). */
  uiScale: number;
  buttonSize: 'sm' | 'md' | 'lg';
  iconSize: 'sm' | 'md' | 'lg';
  sidebarDensity: 'compact' | 'default' | 'comfortable';
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
  /**
   * Keep the original SVG markup on a layer after Convert to Editable Shapes.
   *
   * On by default: without it, converting is a one-way door, and "convert" is
   * exactly the operation a user tries in order to see what it does. Retaining
   * also lets a future release re-run the conversion against untouched source.
   * The cost is negligible next to any raster asset.
   */
  retainOriginalSvg: boolean;
  /**
   * Draw the thin bounding box around every layer in the 3D reference overlay.
   *
   * A PREFERENCE, not view state, and the distinction is the whole reason this
   * lives here rather than next to `groundGridVisible` in the guides store.
   * Whether you want an outline around every layer is a settled personal
   * working style — someone who turns it off wants it off tomorrow too, and a
   * session-scoped toggle would make them turn it off on every launch.
   *
   * On by default: it is the existing behaviour, and the complaint was that the
   * boxes could not be turned OFF, not that they were on.
   */
  showLayerBounds: boolean;
  /**
   * Decode low-resolution proxies in the viewport (After Effects' Use Proxies).
   *
   * A PREFERENCE, not project content, and that is a deliberate choice: a proxy
   * is a fact about one machine's disk. Saved into the project it would travel
   * to a collaborator who has no proxy files, or — far worse — arrive already
   * ON, so their first render of your project would silently be low-res. Scoped
   * here it persists across sessions for the person who turned it on and means
   * nothing to anyone else.
   *
   * Off by default. Export and offline renders ignore it entirely; see
   * `@core/assets/proxy` for why that is enforced by polarity.
   */
  useProxies: boolean;
  /**
   * Asset-library item ids the user starred, across every section (Motion GFX,
   * Transitions, Sound FX, Lottie — ids are unique across all four, which
   * `libraryCatalogs.test.ts` pins).
   *
   * A PREFERENCE rather than project content: which presets you reach for is a
   * fact about you, not about the composition, and saving it into the document
   * would ship one person's shortlist to everyone who opens the file.
   */
  libraryFavorites: string[];
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
  buttonSize: 'md',
  iconSize: 'md',
  sidebarDensity: 'default',
  timelineAutoKeyframe: false,
  editorReduceMotion: false,
  confirmOnClose: true,
  timelineHeaderWidth: 460,
  retainOriginalSvg: true,
  showLayerBounds: true,
  useProxies: false,
  libraryFavorites: [],
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
      if (key === 'uiScale' || key === 'buttonSize' || key === 'iconSize' || key === 'sidebarDensity' || key === 'editorReduceMotion') applyUiPreferences();
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

/**
 * Push the document-level preferences onto the DOM.
 *
 * Only the ones the DOM is the right home for: whole-page zoom, the
 * reduced-motion class, and the density variables. `buttonSize`/`iconSize` are
 * read directly by Button, IconButton and Icon — see the note below.
 */
export function applyUiPreferences(): void {
  const { uiScale, sidebarDensity, editorReduceMotion } = usePreferenceStore.getState();
  const root = document.documentElement as HTMLElement & { style: CSSStyleDeclaration & { zoom?: string } };

  root.style.zoom = uiScale === 1 ? '' : String(uiScale);
  root.classList.toggle('reduce-motion', editorReduceMotion);

  /**
   * Density, as CSS variables the item styles read.
   *
   * `buttonSize` and `iconSize` are deliberately NOT here. They used to publish
   * `--app-button-scale` / `--app-icon-scale`, which no stylesheet ever read —
   * Button, IconButton and Icon each compute their own multiplier from the
   * preference in JS. Two mechanisms for one setting is bad enough; these two
   * had drifted to different numbers (icons scaled 0.88/1.18 here against
   * 0.82/1.25 in Icon.tsx), so whichever a reader believed was wrong half the
   * time. The JS path is the one that works, so it is the one that stays.
   */
  const padMap = { compact: '4px 8px', default: '8px 12px', comfortable: '12px 16px' };
  const fontMap = { compact: '11px', default: '12px', comfortable: '13px' };

  root.style.setProperty('--sidebar-item-padding', padMap[sidebarDensity || 'default']);
  root.style.setProperty('--sidebar-item-font-size', fontMap[sidebarDensity || 'default']);

  window.dispatchEvent(new Event('resize'));
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
