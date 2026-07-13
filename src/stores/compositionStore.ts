/**
 * Composition settings (Prompt E1). The single source of truth for the comp's
 * name, size, frame rate, duration and BACKGROUND — the background was hardcoded
 * to a near-black constant in buildSnapshot; it's now a real, persisted property.
 *
 * Mirrors the `motionBlurStore` pattern: a small Zustand store the render hooks
 * read and thread into `buildSnapshot`, with a `key()` the hooks add to their
 * re-render deps (and the render cache) so edits repaint immediately.
 *
 * Persistence rides on the existing SettingsManager (like createRenderBackend).
 * Defaults equal the previous hardcoded values, so nothing changes visually
 * until the user edits the comp.
 */

import { create } from 'zustand';
import { getSettingsManager } from '@core/services/coreServices';

/** The editable comp settings that flow into the render pipeline. */
export interface CompositionSettings {
  name: string;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  /** Comp background colour (hex). Ignored for compositing when `transparent`. */
  background: string;
  /** When true the comp has no background fill (checkerboard preview, alpha export). */
  transparent: boolean;
}

/** Previous hardcoded values — see buildSnapshot.COMP_* and TimelineController. */
export const DEFAULT_COMPOSITION: CompositionSettings = {
  name: 'Composition 1',
  width: 1920,
  height: 1080,
  fps: 30,
  durationSeconds: 10,
  background: '#101014',
  transparent: false,
};

const SETTINGS_KEY = 'composition';

interface CompositionStore extends CompositionSettings {
  /** Patch one or more fields at once (used by the Composition Settings dialog). */
  update: (patch: Partial<CompositionSettings>) => void;
  setBackground: (hex: string) => void;
  setTransparent: (v: boolean) => void;
  /** The comp-shaped slice fed to buildSnapshot. */
  comp: () => CompositionSettings;
  /** Stable string that changes whenever a render-affecting field changes. */
  key: () => string;
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
}

/** Sanitise a partial patch (sizes/fps/duration must stay positive + sane). */
function sanitize(patch: Partial<CompositionSettings>): Partial<CompositionSettings> {
  const out: Partial<CompositionSettings> = { ...patch };
  if (patch.width !== undefined) out.width = clampInt(patch.width, 1, 16384, DEFAULT_COMPOSITION.width);
  if (patch.height !== undefined) out.height = clampInt(patch.height, 1, 16384, DEFAULT_COMPOSITION.height);
  if (patch.fps !== undefined) out.fps = clampInt(patch.fps, 1, 240, DEFAULT_COMPOSITION.fps);
  if (patch.durationSeconds !== undefined) {
    out.durationSeconds = Number.isFinite(patch.durationSeconds)
      ? Math.max(0.1, patch.durationSeconds)
      : DEFAULT_COMPOSITION.durationSeconds;
  }
  return out;
}

/** Persist the current settings (best-effort; ignores boot-order/quota issues). */
function persist(settings: CompositionSettings): void {
  try {
    getSettingsManager().set<CompositionSettings>(SETTINGS_KEY, settings);
  } catch {
    /* coreServices not booted yet (module init) — hydrate() reconciles later */
  }
}

export const useCompositionStore = create<CompositionStore>((set, get) => ({
  ...DEFAULT_COMPOSITION,

  update: (patch) => {
    const next = sanitize(patch);
    set(next);
    persist(get().comp());
  },
  setBackground: (hex) => {
    set({ background: hex });
    persist(get().comp());
  },
  setTransparent: (v) => {
    set({ transparent: v });
    persist(get().comp());
  },

  comp: () => {
    const s = get();
    return {
      name: s.name,
      width: s.width,
      height: s.height,
      fps: s.fps,
      durationSeconds: s.durationSeconds,
      background: s.background,
      transparent: s.transparent,
    };
  },

  key: () => {
    const s = get();
    return `${s.width}x${s.height}:${s.fps}:${s.durationSeconds}:${s.background}:${s.transparent ? 1 : 0}`;
  },
}));

/** Load persisted comp settings after coreServices boot (called from Providers). */
export function hydrateComposition(): void {
  let stored: Partial<CompositionSettings> | null = null;
  try {
    stored = getSettingsManager().get<Partial<CompositionSettings> | null>(SETTINGS_KEY, null);
  } catch {
    stored = null;
  }
  if (stored) {
    useCompositionStore.setState({ ...DEFAULT_COMPOSITION, ...sanitize(stored) });
  }
}
