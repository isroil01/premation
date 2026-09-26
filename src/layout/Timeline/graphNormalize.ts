/**
 * "Fit all curves vertically" — the graph editor's F key, without the F.
 *
 * ## The problem it solves
 *
 * Each curve in the graph editor auto-fits its OWN vertical range, and the
 * range freezes for the duration of a drag so a keyframe does not slide out
 * from under the pointer as the extent it defines changes. That freeze is
 * correct and it is also sticky in one direction: drag a value far off the top,
 * release, and the curve is now fitted to a range that includes the excursion
 * you have since undone. There was no way to say "fit what is there now" short
 * of toggling the panel.
 *
 * More often, though, the request is the other one: you have opened four
 * properties whose curves are each fitted to their own range, they overlap in
 * a way that means nothing, and you want them re-fitted together so the tall
 * one is tall.
 *
 * ## Why a broadcast rather than a store
 *
 * The fit is derived state inside the editor's sampling memo. Lifting it into a
 * store to have somewhere for a command to write would mean the memo re-reads a
 * store on every sample — 60 times a second during a scrub — for a value that
 * changes when a user presses a button. A one-shot notification costs nothing
 * between presses, and the editor already has the `refitTick` machinery to
 * respond to it.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';

export const TIMELINE_GRAPH_NORMALIZE_COMMAND = asCommandId('timeline.graphNormalize');

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe an open graph editor. Returns the unsubscribe. */
export function onGraphNormalize(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Ask every open graph editor to re-fit. */
export function requestGraphNormalize(): void {
  for (const fn of listeners) fn();
}

/**
 * The vertical range a set of plotted values should be fitted to.
 *
 * Pure, and the ONE place the padding rule lives, so the command and the
 * editor's own auto-fit cannot answer the question differently.
 *
 *   • `value` mode pads 15% either side, so a curve does not touch the frame,
 *     and gives a flat curve ±1 so a constant is a line through the middle
 *     rather than a division by zero.
 *   • `speed` mode is anchored at 0 — speed has a floor and reading it against
 *     a floating baseline is how a slow move looks like a fast one — with 25%
 *     headroom above the peak.
 */
export function normalizedRange(
  values: ReadonlyArray<number>,
  mode: 'value' | 'speed',
): { minV: number; maxV: number } {
  let minV = Infinity;
  let maxV = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) return { minV: 0, maxV: 1 };
  if (mode === 'speed') return { minV: 0, maxV: (maxV <= 0 ? 100 : maxV) * 1.25 };
  if (maxV === minV) return { minV: minV - 1, maxV: maxV + 1 };
  const pad = (maxV - minV) * 0.15;
  return { minV: minV - pad, maxV: maxV + pad };
}

export function buildGraphNormalizeCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TIMELINE_GRAPH_NORMALIZE_COMMAND,
      label: 'Fit All Curves Vertically',
      description:
        'Re-fit every visible curve in the graph editor to the values it actually holds now, '
        + 'discarding the range frozen by the last drag.',
      icon: 'maximize',
      execute: () => requestGraphNormalize(),
    },
  ];
}

let installed = false;

export function installGraphNormalizeCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildGraphNormalizeCommands()) registry.register(command);
}
