/**
 * Onion-skin settings.
 *
 * A store rather than component state because the toggle and the numbers are
 * read from two places that must not disagree: the viewport render loop (which
 * reads them off the store at render time, like every other chrome setting) and
 * whatever UI is exposing them. The same reasoning as `bounceStore`.
 *
 * Not persisted — like a tool's current settings, these are per-session working
 * values, and `enabled` in particular should not survive a restart: onion skins
 * are expensive (a full comp render EACH) and coming back to an editor that is
 * mysteriously slow because of a toggle you set last week is a bad trade.
 */

import { create } from 'zustand';
import { DEFAULT_ONION_SKIN, type OnionSkinSettings } from '@core/rendering/onionSkin';

interface OnionSkinState extends OnionSkinSettings {
  set(patch: Partial<OnionSkinSettings>): void;
  toggle(): void;
}

/** Bounds that keep the cost sane. Each ghost is a full comp render, so the
 *  count is not a taste control — 8 a side is already 17 renders per repaint. */
export const ONION_MAX_SIDE = 8;
export const ONION_MAX_STEP = 30;

export const useOnionSkinStore = create<OnionSkinState>((set) => ({
  ...DEFAULT_ONION_SKIN,
  set: (patch) =>
    set((s) => ({
      ...s,
      ...patch,
      // Clamped here rather than at every call site: the plan tolerates junk,
      // but a slider that can ask for 400 ghosts would hang the viewport long
      // before the plan got a chance to be sensible about it.
      ...(patch.before !== undefined
        ? { before: Math.max(0, Math.min(ONION_MAX_SIDE, Math.round(patch.before))) }
        : {}),
      ...(patch.after !== undefined
        ? { after: Math.max(0, Math.min(ONION_MAX_SIDE, Math.round(patch.after))) }
        : {}),
      ...(patch.step !== undefined
        ? { step: Math.max(1, Math.min(ONION_MAX_STEP, Math.round(patch.step))) }
        : {}),
      ...(patch.opacity !== undefined
        ? { opacity: Math.max(0, Math.min(1, patch.opacity)) }
        : {}),
    })),
  toggle: () => set((s) => ({ enabled: !s.enabled })),
}));
