/**
 * Live preview for a keyframe-assistant dialog.
 *
 * The Smoother and The Wiggler used to be `customPrompt` text boxes: you typed
 * a number, pressed Enter, and found out afterwards whether it was the right
 * number. Both are tolerance/amplitude controls where the only way to pick a
 * value is to SEE it, so the dialogs apply as you type.
 *
 * Applying-as-you-type has to not litter the undo stack, and it has to be
 * genuinely revertible on Cancel. Two mechanisms, deliberately separate:
 *
 *   • REVERT is exact, not diffed — the affected tracks' keyframes are copied
 *     at open and written back verbatim. Re-running the assistant with the
 *     original tolerance would NOT be a revert: these transforms are lossy
 *     (the Smoother deletes keyframes; the Wiggler adds and re-tangents them),
 *     so the only faithful "before" is the array we kept.
 *
 *   • UNDO is one entry, via `beginAnimEdit`'s snapshot-now/diff-later
 *     transaction — the same path a pointer drag uses. Every intermediate
 *     preview write happens with no command recorded, and OK records the net
 *     change once. Cancel records nothing at all, which is why it must restore
 *     first: an un-restored cancel would leave the preview applied with no
 *     history entry to undo it.
 *
 * Nothing here is React-aware; the dialogs own the state.
 */

import { defaultAnimation, type Keyframe, type PropPath } from '@motion/animation';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';

export interface TrackPreview {
  /** The props that were captured (those that had keyframes at open). */
  readonly props: ReadonlyArray<PropPath>;
  /** The keyframes `prop` held when the dialog opened. Always a fresh copy. */
  original(prop: PropPath): Keyframe[];
  /** Put every captured track back exactly as it was. */
  restore(): void;
  /**
   * Restore every captured track, then write the replacements in `next`.
   * One engine batch, so the viewport repaints once per keystroke.
   */
  apply(next: ReadonlyMap<PropPath, ReadonlyArray<Keyframe>>): void;
  /** Record everything since capture as ONE undo entry. */
  commit(label: string): void;
}

export function beginTrackPreview(
  nodeId: string,
  props: ReadonlyArray<PropPath>,
): TrackPreview {
  const captured = new Map<PropPath, Keyframe[]>();
  for (const prop of props) {
    const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
    // `getTrackKeyframes` already hands back copies; the clone here is against
    // a future engine that stops doing so, since this array IS the undo state.
    if (kfs && kfs.length) captured.set(prop, kfs.map((k) => ({ ...k })));
  }
  const tx = beginAnimEdit();

  const writeOriginals = (): void => {
    for (const [prop, kfs] of captured) {
      defaultAnimation.setTrackKeyframes(nodeId, prop, kfs.map((k) => ({ ...k })));
    }
  };

  return {
    props: [...captured.keys()],
    original: (prop) => (captured.get(prop) ?? []).map((k) => ({ ...k })),
    restore: () => defaultAnimation.batch(writeOriginals),
    apply: (next) =>
      defaultAnimation.batch(() => {
        writeOriginals();
        for (const [prop, kfs] of next) {
          if (!captured.has(prop)) continue;
          defaultAnimation.setTrackKeyframes(nodeId, prop, kfs.map((k) => ({ ...k })));
        }
      }),
    commit: (label) => recordAnimEdit(tx.commit(label)),
  };
}
