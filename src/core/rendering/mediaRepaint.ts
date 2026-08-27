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
 */

/**
 * Is this `AnimationChanged` payload a media decode/upload repaint rather than
 * a document edit?
 *
 * Recognizes the texture-provider's sentinel and the blob/object URLs that
 * decoded media reports itself under. It is a heuristic on the id, which is
 * why it errs toward FALSE (treat as a real edit): a missed media event costs
 * one redundant scene walk, while a misclassified edit would silently fail to
 * update the timeline and inspector.
 */
export function isMediaDecodeRepaint(nodeId?: string): boolean {
  if (!nodeId) return false;
  if (nodeId === '__texture__') return true;
  return nodeId.startsWith('blob:') || nodeId.startsWith('motion-blob:');
}
