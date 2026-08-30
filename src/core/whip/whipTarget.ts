/**
 * What is under the cursor, when the cursor is dragging a pick-whip.
 *
 * ── Why the DOM, and not a registry ────────────────────────────────────
 * The obvious design is a store every droppable row registers its bounds with.
 * It is also the wrong one here: rows are virtualised (the scene tree and the
 * timeline both windowed), they move on every scroll, and a registry of live
 * rectangles would have to be invalidated by scroll, resize, panel drag, zoom
 * and layout change — five subscriptions to keep a copy of something the
 * browser already knows exactly.
 *
 * So a target is an ATTRIBUTE, and hit-testing is `elementFromPoint`. A surface
 * opts in by marking itself, and that is the whole integration:
 *
 *   `data-whip-layer="<nodeId>"`   — this element IS a layer
 *   `data-whip-prop="<prop>"`      — …and this property of it
 *   `data-whip-scope="layer"`      — inside here, `data-id` is a layer id
 *
 * The scope form exists for the scene tree, whose rows already carry
 * `data-id` from the shared TreeView. Marking the container is one attribute;
 * teaching TreeView to emit per-row whip attributes would be a new API on a
 * component used by six panels for four different kinds of id.
 *
 * Pure apart from the two DOM calls, and both are injected, so the walk is
 * testable without a browser.
 */

export interface WhipTarget {
  /** The scene node the cursor is over. */
  nodeId: string;
  /** The specific property, when the surface named one. */
  prop?: string;
}

/** The document functions this needs, injectable for tests. */
export interface WhipDom {
  elementFromPoint(x: number, y: number): Element | null;
}

/**
 * Resolve the whip target under a point, or null.
 *
 * Walks from the hit element up through its ancestors, taking the FIRST
 * property it meets and the first layer — so a property row nested inside a
 * layer row resolves to both, which is exactly the case an expression whip
 * wants ("that layer's Y", not "that layer").
 */
export function resolveWhipTargetAt(
  x: number,
  y: number,
  dom: WhipDom = document,
): WhipTarget | null {
  let element = dom.elementFromPoint(x, y);
  let prop: string | undefined;
  let scoped: Element | null = null;

  while (element) {
    const propAttr = element.getAttribute('data-whip-prop');
    if (propAttr && prop === undefined) prop = propAttr;

    const layerAttr = element.getAttribute('data-whip-layer');
    if (layerAttr) return prop === undefined ? { nodeId: layerAttr } : { nodeId: layerAttr, prop };

    // Inside a scoped container, the nearest `data-id` on the way up is the
    // row's node id. Remembered rather than returned immediately: an explicit
    // `data-whip-layer` further up is more specific and must win.
    if (scoped === null && element.getAttribute('data-id')) scoped = element;
    if (element.getAttribute('data-whip-scope') === 'layer' && scoped) {
      const id = scoped.getAttribute('data-id');
      if (id) return prop === undefined ? { nodeId: id } : { nodeId: id, prop };
    }

    element = element.parentElement;
  }
  return null;
}

/**
 * The expression that reads `target`, for insertion at a caret.
 *
 * `fallbackProp` is the property the whip was dragged FROM. Whipping a layer
 * rather than one of its properties means "follow that layer's <this same
 * property>", which is what a person dragging from Y onto another layer means
 * — and is what After Effects produces for the same gesture.
 *
 * The name, not the id: the expression language addresses layers by name (see
 * `layer()` in the expression API), and a name is also what the author will
 * recognise when they read the expression back.
 */
export function whipExpression(layerName: string, prop: string): string {
  // Single quotes, escaped — a layer called `Ada's title` is legal and would
  // otherwise produce an expression that does not parse.
  return `layer('${layerName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', '${prop}')`;
}

/**
 * Splice `insert` into `text` at `caret`, and report where the caret lands.
 *
 * Separated from the editor because "where does the caret end up" is the part
 * that is annoying to get right and trivial to test: after an insertion the
 * caret must sit AFTER the inserted text, or the next thing typed lands inside
 * the expression that was just added.
 */
export function insertAtCaret(
  text: string,
  caret: number,
  insert: string,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(text.length, caret));
  return { text: text.slice(0, at) + insert + text.slice(at), caret: at + insert.length };
}
