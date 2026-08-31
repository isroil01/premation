/**
 * Telling a MEDIA DECODE repaint apart from a real document change.
 *
 * `AnimationChanged` carries two very different things. One is an edit — a
 * keyframe moved, an expression changed — which must refresh the timeline
 * tracks, the inspector and the viewport. The other is a decoded video frame or
 * a texture upload landing, which must repaint the viewport and NOTHING else:
 * the document did not change, so re-walking the scene graph, re-hashing it and
 * reconciling React for it is pure cost, paid at the source's frame rate for as
 * long as any video is on screen.
 *
 * The distinction lives here rather than privately inside one consumer because
 * two places need it and they were disagreeing: the viewport's render loop
 * filtered these events, while the app-level subscriber that calls `bumpScene`
 * did not — so the filtering the render loop did was undone one listener over.
 *
 * ## CORRECTED — the id heuristic was not enough
 *
 * This used to be a guess about the SHAPE of `nodeId`: `__texture__`, or a
 * string starting `blob:` / `motion-blob:`. That covers the local-first edition
 * (`motion-blob:<sha256>`) and IndexedDB-backed assets (`blob:`), and misses
 * the desktop/cloud edition entirely — there `assetUrl` resolves footage to
 * `/files/<key>` in the browser and `http://<backend>/files/<key>` under
 * Electron. Neither prefix matched, so on those editions EVERY decoded video
 * frame was classified as a document EDIT: it bumped the scene revision, ran a
 * full scene walk and content re-hash, cleared the RAM preview cache, marked
 * the project dirty and armed autosave — at the source's frame rate, for as
 * long as any video was on screen. The header above described a filter that,
 * on the shipping desktop build, was not filtering anything.
 *
 * The fix is to stop guessing. Media emitters now go through
 * `@core/rendering/repaintScheduler`, which sets `media: true` on the payload,
 * and that flag is authoritative. The id heuristic is KEPT as a fallback for
 * emitters that predate the flag and for the sentinel ids the texture provider
 * still uses directly; it errs toward FALSE (treat as a real edit) for the same
 * reason it always did — a missed media event costs one redundant scene walk,
 * while a misclassified edit would silently fail to update the timeline and
 * inspector.
 */

/** The `AnimationChanged` payload, as far as this decision is concerned. */
export interface MediaRepaintPayload {
  nodeId?: string;
  media?: boolean;
}

/**
 * Is this `AnimationChanged` payload a media decode/upload repaint rather than
 * a document edit?
 *
 * Accepts the whole payload (the authoritative `media` flag) or a bare
 * `nodeId` (the legacy heuristic) so a caller that only has the id still gets
 * the old, weaker answer rather than a type error.
 */
export function isMediaDecodeRepaint(payload?: MediaRepaintPayload | string): boolean {
  if (!payload) return false;
  if (typeof payload !== 'string') {
    if (payload.media === true) return true;
    return isMediaDecodeRepaint(payload.nodeId);
  }
  const nodeId = payload;
  if (nodeId === '__texture__') return true;
  return nodeId.startsWith('blob:') || nodeId.startsWith('motion-blob:');
}
