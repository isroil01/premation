/**
 * Bounce settings — the ONE set of numbers the bounce is generated from.
 *
 * A store rather than component state for two reasons. The panel is a dock tab,
 * so local state would be thrown away every time the user switched to Effects
 * and back — and the Animate menu's one-click "Bounce Keyframes" applies the
 * same shape, so the menu and the panel have to agree about what a bounce is.
 * Before this, the menu applied a hardcoded `DEFAULT_BOUNCE` and there was no
 * other way to change it.
 *
 * Not persisted: these are per-session working values, like a tool's current
 * settings, and a preference the user cannot see or reset is worse than a
 * predictable default at launch.
 */

import { create } from 'zustand';
import {
  DEFAULT_BOUNCE,
  DEFAULT_DROP_IN,
  DEFAULT_SQUASH,
  type BounceOptions,
  type DropInOptions,
  type SquashOptions,
} from '@core/animation/bounce';

interface BounceState {
  bounce: BounceOptions;
  drop: DropInOptions;
  squash: SquashOptions;
  /** Squash & stretch is opt-in — it writes SCALE, not position, and a user who
   *  asked for a bounce did not necessarily ask for their layer to deform. */
  squashEnabled: boolean;
  setBounce(patch: Partial<BounceOptions>): void;
  setDrop(patch: Partial<DropInOptions>): void;
  setSquash(patch: Partial<SquashOptions>): void;
  setSquashEnabled(on: boolean): void;
  /** Replace the bounce parameters wholesale — what picking a style does. */
  applyStyle(options: BounceOptions): void;
}

export const useBounceStore = create<BounceState>((set) => ({
  bounce: DEFAULT_BOUNCE,
  drop: DEFAULT_DROP_IN,
  squash: DEFAULT_SQUASH,
  squashEnabled: false,
  setBounce: (patch) => set((s) => ({ bounce: { ...s.bounce, ...patch } })),
  setDrop: (patch) => set((s) => ({ drop: { ...s.drop, ...patch } })),
  setSquash: (patch) => set((s) => ({ squash: { ...s.squash, ...patch } })),
  setSquashEnabled: (squashEnabled) => set({ squashEnabled }),
  applyStyle: (options) => set({ bounce: { ...options } }),
}));

/** The squash settings as the generators want them: `null` when switched off. */
export function currentSquash(): SquashOptions | null {
  const s = useBounceStore.getState();
  return s.squashEnabled ? s.squash : null;
}
