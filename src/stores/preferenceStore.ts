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
  /**
   * How generated motion should feel: the duration, travel, stagger and easing
   * that Animate In/Out and the beat-synced commands use together.
   *
   * A preference rather than a parameter on each command, for two reasons. The
   * four values multiply against ten choreography commands and five beat ones,
   * which is a palette nobody can read; and "how motion feels in this project"
   * is a taste decision made once, not re-made per gesture. Per-property
   * tuning still lives in the graph editor afterwards.
   */
  motionFeel: 'snappy' | 'smooth' | 'bouncy';
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
   * While the editor is idle, cache the whole WORK AREA rather than a few
   * seconds ahead of the playhead.
   *
   * On by default, because it is what makes a preview real-time: After Effects
   * fills the work area for the same reason, and a five-second look-ahead only
   * ever helps the first press of play. The pass yields on a time budget,
   * stands down on any interaction, and runs once per invalidation rather than
   * continuously — but it is still real GPU work, and someone on a laptop who
   * would rather it stayed quiet should be able to say so.
   */
  idleCacheWorkArea: boolean;
  /**
   * Disk budget for the preview frame cache, in GIGABYTES.
   *
   * A PREFERENCE because it is a statement about this machine, not about any
   * project: how much of your disk you are willing to spend on not re-rendering
   * is the same answer for every comp you open, and it is the one cache setting
   * whose right value the app cannot guess. A laptop with 60 GB free and a
   * workstation with 4 TB want different numbers and neither is wrong.
   *
   * Clamped on read (`previewDiskCacheBytes`) rather than trusted: this is
   * persisted JSON, so it can come back as anything.
   */
  previewDiskCacheGb: number;
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
   * ON by default (the optimized-media default every mature editor ships):
   * heavy camera footage — 4K long-GOP phone video above all — cannot be
   * frame-accurately previewed at realtime on typical hardware, and the cost
   * of NOT proxying is broken-feeling playback, which users blame on the app.
   * Generation still only happens where ffmpeg exists (desktop) and only for
   * footage large enough to need it; export and offline renders ignore the
   * flag entirely — see `@core/assets/proxy` for why that is enforced by
   * polarity.
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
  /**
   * Effect type ids the user starred in Effects & Presets.
   * Preference (not project data) — same rationale as libraryFavorites.
   */
  effectFavorites: string[];
  /**
   * Which Inspector property sections the user has explicitly opened or
   * closed, by section id (`transform`, `appearance`, `time`, …).
   *
   * A PREFERENCE, and a sparse one on purpose. The Inspector's open/closed
   * state used to be component-local `useState`, so it reset every time the
   * panel unmounted — switching tabs, or clearing the selection — and Transform
   * sprang back open no matter how many times you collapsed it. Which sections
   * you want expanded is settled personal working style, exactly like
   * `timelineHeaderWidth`.
   *
   * Sparse (only ids the user actually toggled) rather than a list of open
   * ids: a section never touched must keep following its own `defaultOpen`, so
   * selecting a layer KIND for the first time still opens the section that
   * made you select it.
   */
  inspectorSections: Record<string, boolean>;
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
  motionFeel: 'smooth',
  editorReduceMotion: false,
  confirmOnClose: true,
  timelineHeaderWidth: 460,
  retainOriginalSvg: true,
  idleCacheWorkArea: true,
  // The previous hardcoded budget, so nobody's cache changes size by upgrading.
  previewDiskCacheGb: 4,
  showLayerBounds: true,
  useProxies: true,
  libraryFavorites: [],
  effectFavorites: [],
  inspectorSections: {},
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
      const parsed = JSON.parse(raw) as Partial<Preferences>;
      // ONE-TIME migration to the proxies-on default. `write` persists the
      // whole object, so every pre-existing profile carries useProxies:false
      // whether or not the user ever touched the toggle — flipping only the
      // default would strand exactly the users the change is for. The marker
      // makes it run once; anyone who turns proxies off afterwards keeps
      // their choice.
      const MARKER = 'motion-editor.proxyDefaultMigrated';
      if (parsed.useProxies === false && !window.localStorage.getItem(MARKER)) {
        window.localStorage.setItem(MARKER, '1');
        delete parsed.useProxies; // fall back to the (new) default: true
      }
      return parsed;
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

/**
 * The preview disk budget in BYTES, clamped to something a browser will
 * actually honour.
 *
 * Below the floor the tier cannot hold a usable span and is worse than nothing
 * (the same reasoning as `streamPlanFor`'s frame-count floor); above the
 * ceiling an IndexedDB store will hit the browser's own quota and be evicted
 * wholesale, which is a far worse experience than a smaller cache that works.
 */
export const PREVIEW_DISK_MIN_GB = 0.5;
export const PREVIEW_DISK_MAX_GB = 64;

export function previewDiskCacheBytes(): number {
  const gb = usePreferenceStore.getState().previewDiskCacheGb;
  const safe = Number.isFinite(gb) ? gb : 4;
  const clamped = Math.min(PREVIEW_DISK_MAX_GB, Math.max(PREVIEW_DISK_MIN_GB, safe));
  return Math.round(clamped * 1024 * 1024 * 1024);
}
