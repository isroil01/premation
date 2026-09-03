/**
 * The transition PALETTE — four chips you drag onto a cut.
 *
 * ## Why a palette and not only a menu
 *
 * Applying a transition needs two facts: WHICH kind, and WHICH cut. A menu can
 * only supply the second by inference — "the cut nearest the playhead", or "the
 * clip you right-clicked, and whichever neighbour it has" — and both are
 * guesses that are wrong exactly when a comp is dense enough to be worth
 * cutting carefully. Dragging a chip states both facts in one gesture, and it
 * is the gesture every NLE already trains people in.
 *
 * The menu paths still exist (double-click a cut; the clip context menu), for
 * the same reason the edit-mode tool row kept its modifiers: the drag is
 * discoverable, the menu is precise, and neither one is the only door.
 *
 * ## Native HTML5 drag, not a pointer-driven ghost
 *
 * `draggable` + `dataTransfer` costs four lines and gives the drag image, the
 * cursor feedback, the escape-to-cancel and the drop-target semantics for free.
 * A hand-rolled pointer drag would have to reimplement all four, and would
 * fight the lanes' own pointer capture the whole way. The payload is a private
 * MIME type so a drop from anywhere else in the app — a layer, a file, an asset
 * — cannot be mistaken for a transition.
 */

import { TRANSITION_KINDS, TRANSITION_LABEL, TRANSITION_SHORT } from '@core/timeline/transitionStore';
import type { TransitionKind } from '@core/timeline/transitionStore';
import styles from './transitionPalette.module.css';

/** The drag payload's MIME type — private, so nothing else can be mistaken for it. */
export const TRANSITION_DND_TYPE = 'application/x-premation-transition';

/** Read a dropped chip's kind, or null when the drop is not one of ours. */
export function readTransitionDrag(dataTransfer: DataTransfer | null): TransitionKind | null {
  if (!dataTransfer) return null;
  const raw = dataTransfer.getData(TRANSITION_DND_TYPE);
  return (TRANSITION_KINDS as ReadonlyArray<string>).includes(raw) ? (raw as TransitionKind) : null;
}

/**
 * True when a drag currently in flight is one of our chips.
 *
 * `getData` is not readable during `dragover` (the spec's protected mode), so
 * the TYPE list is the only thing a drop target may inspect while the pointer
 * is moving. Without this the lanes would light up for every drag in the app.
 */
export function isTransitionDrag(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(TRANSITION_DND_TYPE);
}

export function TransitionPalette(): JSX.Element {
  return (
    <div className={styles.palette} aria-label="Transitions">
      <span className={styles.paletteLabel} aria-hidden>
        Transitions
      </span>
      {TRANSITION_KINDS.map((kind) => (
        <button
          key={kind}
          type="button"
          draggable
          className={styles.chip}
          data-kind={kind}
          // The title carries its weight: four short words on four small chips
          // are not self-explanatory, and the instruction (drag it onto a cut)
          // is the part a first-time user is missing, not the name.
          title={`${TRANSITION_LABEL[kind]} — drag onto a cut between two clips, or double-click a cut for a Cross Dissolve`}
          aria-label={`${TRANSITION_LABEL[kind]} transition`}
          onDragStart={(e) => {
            e.dataTransfer.setData(TRANSITION_DND_TYPE, kind);
            e.dataTransfer.effectAllowed = 'copy';
          }}
        >
          <span className={styles.chipGlyph} aria-hidden data-kind={kind} />
          {TRANSITION_SHORT[kind]}
        </button>
      ))}
    </div>
  );
}

export default TransitionPalette;
