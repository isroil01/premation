/**
 * The dashboard→editor footage handoff for "start a project from a video".
 *
 * The setup modal runs on the dashboard route; the asset store and scene run
 * in the editor behind /editor/:id. A File cannot ride the URL, so the modal
 * parks it here and the editor's ProjectLoader collects it right after the
 * project opens — import, layer, done.
 *
 * Deliberately a one-shot: `take` clears, so a reload of the editor (or
 * opening a DIFFERENT project) can never replay someone's clip into the wrong
 * document. Module state, not a store — nothing renders from it, and it must
 * not persist.
 */

let pending: File | null = null;

export function setPendingFootage(file: File): void {
  pending = file;
}

export function takePendingFootage(): File | null {
  const f = pending;
  pending = null;
  return f;
}
