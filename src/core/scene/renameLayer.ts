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
 */

import { defaultAnimation, mapLayerNameRefs, layerNameRefsIn } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { runDocumentEdit } from '@core/commands/documentEdit';

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

/** First node with this name, in traversal order — the same rule the engine's resolver uses. */
function resolveByName(name: string): string | null {
  let found: string | null = null;
  defaultSceneGraph.traverse((n) => {
    if (found === null && n.name === name) found = n.id;
  });
  return found;
}

function countNamed(name: string): number {
  let n = 0;
  defaultSceneGraph.traverse((node) => {
    if (node.name === name) n += 1;
  });
  return n;
}

/**
 * Rename a layer and follow the rename through every expression that named it.
 *
 * One `runDocumentEdit`, so the rename and the repairs undo together. Undoing a
 * rename that left its repairs behind would be worse than not repairing at all
 * — the references would then name a layer that no longer exists.
 */
export function renameLayer(nodeId: string, newName: string): RenameLayerResult {
  const empty: RenameLayerResult = {
    ok: false,
    repaired: [],
    captured: [],
    nameAlreadyInUse: false,
  };

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return empty;

  // An unnamed node has no references to follow — nothing can have named it.
  // Still a rename; just not one with any repair work in it.
  const oldName = node.name ?? '';
  const trimmed = newName.trim();
  // An empty name is not a rename, and neither is renaming to the same thing.
  if (trimmed === '' || trimmed === oldName) return { ...empty, ok: trimmed !== '' };

  /*
    Both questions have to be asked BEFORE the mutation, because afterwards
    neither is answerable:

      • Did the old name mean THIS layer? If it meant a different layer that
        shares the name, references to it must be left alone — rewriting by
        text match would retarget them to the layer being renamed, which is not
        the one they were reading.
      • Who did the NEW name mean? If it meant someone, and after the rename it
        means this layer instead, every reference to it just moved.
  */
  const oldNameResolvedToThis = resolveByName(oldName) === nodeId;
  const previousOwnerOfNewName = resolveByName(trimmed);
  const nameAlreadyInUse = countNamed(trimmed) > 0;

  const repaired: RepairedRef[] = [];
  const captured: RepairedRef[] = [];

  runDocumentEdit(`Rename “${oldName}” to “${trimmed}”`, () => {
    node.name = trimmed;

    for (const expr of defaultAnimation.allExpressions()) {
      // A layer's own expression referring to its own old name is repaired the
      // same way as anyone else's. There is nothing special about self.
      const { src, changed } = mapLayerNameRefs(expr.src, (name) =>
        name === oldName && oldNameResolvedToThis ? trimmed : null,
      );

      if (changed) {
        defaultAnimation.setExpressionState(expr.nodeId, expr.prop, {
          src,
          // Preserved, both of them. Losing `enabled` would silently re-enable a
          // disabled expression; losing `authoredBy` would strip the provenance
          // that makes a plugin's leftovers findable after it is uninstalled.
          enabled: defaultAnimation.isExpressionEnabled(expr.nodeId, expr.prop),
          ...(expr.authoredBy ? { authoredBy: expr.authoredBy } : {}),
        });
        repaired.push({
          nodeId: expr.nodeId,
          prop: expr.prop,
          ...(expr.authoredBy ? { authoredBy: expr.authoredBy } : {}),
        });
        continue;
      }

      // Names the layer this rename just stole the name FROM. Nothing about
      // this expression changed, and that is exactly the problem: it silently
      // began reading a different layer.
      if (
        previousOwnerOfNewName !== null &&
        previousOwnerOfNewName !== nodeId &&
        resolveByName(trimmed) === nodeId &&
        layerNameRefsIn(expr.src).includes(trimmed)
      ) {
        captured.push({
          nodeId: expr.nodeId,
          prop: expr.prop,
          ...(expr.authoredBy ? { authoredBy: expr.authoredBy } : {}),
        });
      }
    }
  });

  return { ok: true, repaired, captured, nameAlreadyInUse };
}
