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
 *   • UNDO is one entry: every preview is sent inside ONE engine gesture
 *     (`GestureSession`, the same path a pointer drag uses), OK ends it
 *     (committed: one entry named by the dialog) and Cancel reverts it (the
 *     engine restores the document exactly, nothing recorded).
 *
 * The assistants write whole PER-MEMBER keyframe lists (the Smoother drops
 * keys from x and y independently), so each preview is computed off-document
 * from the captured originals and sent as `setKeyframes` for every captured
 * property (core/engine/assistantKeys.ts) — the whole state each time, since a
 * gesture keeps only the latest queued send.
 *
 * Nothing here is React-aware; the dialogs own the state.
 */

import { defaultAnimation, type Keyframe, type PropPath } from '@motion/animation';
import { GestureSession } from '@core/engine/uiEdits';
import { assistantKeyframeCommands } from '@core/engine/assistantKeys';

export interface TrackPreview {
  /** The props that were captured (those that had keyframes at open). */
  readonly props: ReadonlyArray<PropPath>;
  /** The keyframes `prop` held when the dialog opened. Always a fresh copy. */
  original(prop: PropPath): Keyframe[];
  /** Revert every preview (Cancel / an abandoned dialog). */
  restore(): Promise<void>;
  /** Show `next` (the captured tracks' replacements) instead of the previous preview. */
  apply(next: ReadonlyMap<PropPath, ReadonlyArray<Keyframe>>): void;
  /** Keep the last preview as ONE undo entry (named by `beginTrackPreview`'s label). */
  commit(): Promise<void>;
}

/**
 * B4-gap: the capture below is the exact "before" in the engine's own
 * per-member form (stored units, keyframe axis) — the assistants transform
 * member lists; the mirror holds one key list per PROPERTY in API units.
 */
export function beginTrackPreview(
  nodeId: string,
  props: ReadonlyArray<PropPath>,
  label: string,
): TrackPreview {
  const captured = new Map<PropPath, Keyframe[]>();
  for (const prop of props) {
    const kfs = defaultAnimation.getTrackKeyframes(nodeId, prop);
    // `getTrackKeyframes` already hands back copies; the clone here is against
    // a future engine that stops doing so, since this array IS the revert state.
    if (kfs && kfs.length) captured.set(prop, kfs.map((k) => ({ ...k })));
  }
  const always = new Map([[nodeId, new Set<string>(captured.keys())]]);
  let session: GestureSession | null = null;

  return {
    props: [...captured.keys()],
    original: (prop) => (captured.get(prop) ?? []).map((k) => ({ ...k })),
    restore: async () => {
      const g = session;
      session = null;
      await g?.cancel();
    },
    apply: (next) => {
      const { cmds } = assistantKeyframeCommands([nodeId], () => {
        for (const [prop, kfs] of captured) {
          defaultAnimation.setTrackKeyframes(nodeId, prop, (next.get(prop) ?? kfs).map((k) => ({ ...k })));
        }
      }, { always });
      session ??= new GestureSession(label);
      session.send(cmds);
    },
    commit: async () => {
      const g = session;
      session = null;
      await g?.end();
    },
  };
}
