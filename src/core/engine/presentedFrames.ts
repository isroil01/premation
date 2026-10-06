/**
 * The document revision of the frame each viewport is SHOWING — the engine
 * frame the surface last blitted, not the newest one rendered or requested.
 *
 * What it is for: a page overlay that previews an edit (a shape being dragged
 * out, a pen path, a brush stroke) must not vanish the moment the edit is sent.
 * The engine draws the result a frame or two later; dropping the preview in
 * between shows the canvas WITHOUT the new object for that gap — the blink on
 * release. The painter holds its preview until `presentedRevision` reaches the
 * edit's revision.
 *
 * Frame-rate traffic: `notePresented` is a map write and a loop over the (one
 * or two) listeners — no allocation per frame.
 *
 * No React (src/core).
 */

const shown = new Map<number, number>();
const listeners = new Map<number, Set<() => void>>();

/** The surface blitted a frame of `viewport` rendered at document `revision`. */
export function notePresented(viewport: number, revision: number): void {
  if ((shown.get(viewport) ?? -1) >= revision) return;
  shown.set(viewport, revision);
  const set = listeners.get(viewport);
  if (set) for (const l of set) l();
}

/** The revision of the frame on screen in `viewport` (-1 before the first). */
export function presentedRevision(viewport: number): number {
  return shown.get(viewport) ?? -1;
}

/** Called when `viewport` shows a frame of a newer revision. */
export function subscribePresented(viewport: number, cb: () => void): () => void {
  let set = listeners.get(viewport);
  if (!set) listeners.set(viewport, (set = new Set()));
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}
