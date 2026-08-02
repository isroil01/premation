/**
 * The ONE definition of the track-matte menu.
 *
 * There were two: the inspector's CompositingControls and the timeline row, each
 * with its own hardcoded copy of the four legacy enum labels. Two copies of a
 * value list is how a fifth matte type becomes an expensive change — and it is
 * why the four-value enum survived as long as it did.
 *
 * This module owns the OPTIONS and the read/write mapping; the two hosts own
 * their own chrome, because a timeline row and an inspector row genuinely look
 * different. Sharing the data and not the markup is the split that holds.
 */

import { readMatte, type TrackMatte, type MatteMode } from '@core/effects/matte';

export interface MatteOption {
  id: string;
  label: string;
  /** undefined = "no matte". */
  value: TrackMatte | undefined;
}

/**
 * Alpha/Luma × Inverted, presented as four rows.
 *
 * The MODEL is two fields; the MENU is still four rows, because that is what AE
 * shows and what a user picking a matte is actually choosing between. The point
 * of the model change was never to make the user click twice — it was so a fifth
 * matte kind costs one entry here instead of a new spelling in every consumer.
 */
export const MATTE_OPTIONS: readonly MatteOption[] = [
  { id: 'none', label: 'No matte', value: undefined },
  { id: 'alpha', label: 'Alpha', value: { mode: 'alpha', inverted: false } },
  { id: 'alpha-inv', label: 'Alpha Inverted', value: { mode: 'alpha', inverted: true } },
  { id: 'luma', label: 'Luma', value: { mode: 'luma', inverted: false } },
  { id: 'luma-inv', label: 'Luma Inverted', value: { mode: 'luma', inverted: true } },
];

/** Short labels for the timeline's narrow column. */
export const MATTE_SHORT_LABEL: Record<string, string> = {
  none: 'None',
  alpha: 'Alpha',
  'alpha-inv': 'Alpha Inv',
  luma: 'Luma',
  'luma-inv': 'Luma Inv',
};

/** Which option a stored matte corresponds to. Accepts every legacy shape. */
export function matteOptionId(stored: unknown): string {
  const m = readMatte(stored);
  if (!m) return 'none';
  return m.inverted ? `${m.mode}-inv` : m.mode;
}

/**
 * Apply an option to a stored matte, PRESERVING the explicit source.
 *
 * Dropping sourceId here would silently re-point the matte at whatever layer sits
 * above — still matted, still looks fine, cut to the wrong shape.
 */
export function applyMatteOption(stored: unknown, optionId: string): TrackMatte | undefined {
  const opt = MATTE_OPTIONS.find((o) => o.id === optionId);
  if (!opt?.value) return undefined;
  const sourceId = readMatte(stored)?.sourceId;
  return { ...opt.value, ...(sourceId ? { sourceId } : {}) };
}

/** Repoint a matte at a source without disturbing mode/inverted. */
export function setMatteSource(stored: unknown, sourceId: string | undefined): TrackMatte | undefined {
  const m = readMatte(stored);
  if (!m) return undefined;
  const { sourceId: _drop, ...rest } = m;
  return sourceId ? { ...rest, sourceId } : (rest as { mode: MatteMode; inverted: boolean });
}
