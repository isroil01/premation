/**
 * Renaming a layer without silently breaking the expressions that name it.
 *
 * `layer('Hero depth', 'opacity')` resolves a NAME at evaluation time, every
 * frame. Rename the layer and the reference reads 0 — no error, no warning, and
 * the symptom shows up nowhere near the rename that caused it. Plugin-written
 * bindings were fixed by rewriting them to `layer('#<id>')` at authoring time.
 * A person's own expressions deliberately were NOT, because the source text is
 * what they typed and what they see when they open the editor, and replacing a
 * layer name with `#n_a1b2c3` makes their expression unreadable to them in
 * order to fix a problem they have not hit yet.
 *
 * That decision stands. This is the other way to keep the promise: when the
 * name changes, change the references to the NEW NAME. The text stays readable,
 * the reference stays correct, and nobody has to learn the id form. It is the
 * same edit an IDE's rename does, and it costs the author nothing.
 *
 * ── Why it is keyed on RESOLUTION, not on matching text ──────────────────────
 *
 * Layer names are not unique. `layer('Panel')` resolves to the FIRST node named
 * Panel in traversal order, so if there are two and you rename the second, every
 * expression still points at the first — and rewriting them by text match would
 * silently RETARGET them to the layer the author was not referring to. So the
 * old name is resolved before the rename, and references are rewritten only if
 * that resolution was this node.
 *
 * ── What it refuses to do quietly ────────────────────────────────────────────
 *
 * One case is reported rather than fixed, because only the author knows the
 * right answer: **capture**. Rename a layer TO a name another layer already
 * uses, and if the renamed layer comes first in traversal order it now wins
 * `layer('That Name')` — so every expression referencing that name silently
 * starts reading a different layer. No text changed and nothing errored, which
 * is what makes it worth naming out loud. Rewriting those references would be
 * guessing which layer the author meant.
 *
 * Note what is NOT a hazard, despite looking like one: renaming AWAY from a
 * duplicated name. If `Panel` resolved to this layer, its references are
 * repaired; if it resolved to a different layer, they still do. Either way
 * nothing moves, so there is nothing to warn about — and a warning fired there
 * would be the kind nobody reads.
 *
 * Reported, never blocking. The user asked for a rename, and refusing it to
 * protect an expression they can see and edit would be the tool overruling them.
 *
 * The rename itself is the engine's `renameLayer` command (both engines; TS
 * handlers/layers.ts), which repairs the references inside the same command.
 * This module keeps the result types the Layers panel reports with
 * (sceneEdits.ts `renameLayerEdit`).
 */

/** One expression whose reference to the renamed layer was repaired. */
export interface RepairedRef {
  nodeId: string;
  prop: string;
  /** The plugin that wrote it, when one did. Absent means a person typed it. */
  authoredBy?: string;
}

export interface RenameLayerResult {
  ok: boolean;
  /** Expressions rewritten to follow the new name. */
  repaired: RepairedRef[];
  /**
   * Expressions naming the NEW name that used to resolve to some other layer
   * and now resolve to this one.
   *
   * The genuinely dangerous case, and the reason this is a list rather than a
   * flag: nothing errors, no text changed, and a set of expressions quietly
   * started reading a different layer. Rewriting them would be guessing which
   * layer the author meant, so they are named instead.
   */
  captured: RepairedRef[];
  /**
   * True when the new name was already in use at all — even if resolution did
   * not move. One of the two layers is now unreachable by name from any
   * expression, which is worth one sentence at the moment it becomes true.
   */
  nameAlreadyInUse: boolean;
}
