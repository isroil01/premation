/**
 * The Layers panel's own document edits through the engine API (B3,
 * docs/B3_PATTERNS.md): the tree's drag (reorder + reparent), the pick-whip,
 * inline rename, delete, the row menu's time verbs, and the Compositions
 * list's rename / duplicate / delete. ONE user action = ONE undo entry,
 * labelled as the legacy writer labelled it.
 *
 * Several of these are sequences whose later steps depend on what the earlier
 * ones did (a drag into another group re-parents first, then orders within the
 * new sibling list; a duplicated comp is renamed by the id the duplicate
 * returns), so they run inside one engine gesture — each step computed from
 * the document as the previous one left it, committed together, reverted
 * together on failure.
 *
 * Where the API cannot say what the legacy helper did, the helper keeps it,
 * marked `B3-legacy` with the gap. Display reads stay direct until B4.
 */

import type { Command, EngineClient, RenameLayerResult as EngineRenameResult } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { canReparent, enclosingCompRootOf } from '@core/scene/parenting';
import type { RenameLayerResult, RepairedRef } from '@core/scene/renameLayer';
import { getNodeLayerTime } from '@core/scene/layerTime';
import { apiParentOf, compOfLayer, isCompItem, isLayer, layersUsingItem } from '@core/engine/doc';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow } from '@hooks/useMirror';
import { compLayersDeep } from '@core/mirror/layerFields';
import { liveComps } from '@core/mirror/compNames';
import { reorderCommands, withGroupMembers } from '@layout/Workspace/layerMenuEdits';

// ── A sequence as one entry ───────────────────────────────────────────

/**
 * Run `steps` in order inside one engine gesture: each step reads the document
 * as the previous step left it and returns the commands to send now (none =
 * skip). Any refusal is toasted and the whole gesture is reverted. A gesture in
 * which nothing was sent records nothing.
 */
async function inOneEntry(label: string, steps: ReadonlyArray<() => Command[]>): Promise<boolean> {
  const client: EngineClient = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return false;
  }
  let ok = true;
  for (const step of steps) {
    const cmds = step();
    if (cmds.length === 0) continue;
    const res = await client.batch(label, cmds);
    if (!res.ok) {
      reportEngineError(label, res.error);
      ok = false;
      break;
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  return ok;
}

/** `setParent` for one layer; a composition root as the target means "no parent". */
function setParentCmd(layer: string, parent: string | null): Command {
  const p = parent && isLayer(parent) ? parent : undefined;
  return { type: 'setParent', layers: [layer], ...(p ? { parent: p } : {}), keepWorldTransform: true };
}

/** Is `parent` (a layer, or its composition root = none) already the layer's parent? */
function parentIs(layer: string, parent: string | null): boolean {
  const want = parent && isLayer(parent) ? parent : null;
  return (apiParentOf(layer) ?? null) === want;
}

/**
 * The commands that put `id` directly before/after `targetId` in CHILD order
 * (`moveNodeAdjacent`'s placement; 'after' = in front of it) — computed from
 * the document as it is NOW, so call it after any re-parent has landed.
 */
function adjacentOrderCommands(id: string, targetId: string, pos: 'before' | 'after'): Command[] {
  const target = defaultSceneGraph.getNode(targetId);
  const node = defaultSceneGraph.getNode(id);
  const comp = compOfLayer(id);
  if (!target?.parent || !node || node.parent !== target.parent || !comp) return [];
  const kids = defaultSceneGraph.getChildOrder(target.parent);
  const rest = kids.filter((x) => x !== id);
  let at = rest.indexOf(targetId);
  if (at < 0) at = rest.length;
  else if (pos === 'after') at += 1;
  const next = [...rest];
  next.splice(at, 0, id);
  if (next.every((x, i) => x === kids[i])) return [];
  return reorderCommands(comp, target.parent, kids, next, new Set([id]));
}

// ── The tree's drag (reorder / reparent) ──────────────────────────────

export type TreeDropPosition = 'before' | 'after' | 'inside';

/**
 * The Layers tree's drop, as ONE entry ("Move layer" / "Move N layers") —
 * the legacy `handleReorder` rules, sent as `setParent` + `reorderLayers`:
 *
 *  • dropped below the last row → out to the active composition (no parent);
 *  • INSIDE a row → parented to it (world transform kept), or, when it cannot
 *    nest there, placed just in front of it;
 *  • BEFORE / AFTER a row (display order: front first) → into that row's
 *    parent, then ordered next to it;
 *  • onto a composition root's row (the project scope lists them) → out to
 *    that composition, when it is the layer's own.
 *
 * `ids` are the movable rows (locks already checked by the caller), handled
 * back to front so a multi-row drag keeps the order the rows were in. A layer
 * cannot leave its composition (parenting is nesting): such a row is skipped,
 * as the legacy helper skipped it.
 */
export async function moveLayersInTreeEdit(ids: ReadonlyArray<string>, targetId: string | null, pos: TreeDropPosition): Promise<void> {
  const label = ids.length === 1 ? 'Move layer' : `Move ${ids.length} layers`;
  const steps: Array<() => Command[]> = [];
  for (const id of [...ids].reverse()) {
    if (!isLayer(id)) continue;
    if (targetId !== null && !isLayer(targetId)) {
      // A composition root's row: the root is "no parent" (legacy `reparentNode(id, root)`).
      const root = targetId;
      steps.push(() => (canReparent(id, root) && !parentIs(id, null) ? [setParentCmd(id, null)] : []));
      continue;
    }
    if (targetId === null) {
      steps.push(() => {
        const root = activeCompIdNow();
        if (!root || enclosingCompRootOf(id) !== root || parentIs(id, null)) return [];
        return [setParentCmd(id, null)];
      });
      continue;
    }
    if (pos === 'inside' && canReparent(id, targetId)) {
      steps.push(() => (parentIs(id, targetId) ? [] : [setParentCmd(id, targetId)]));
      continue;
    }
    // Display "before" is child-order "after" (the tree draws front first);
    // a row that cannot nest lands just in front of the target.
    const childPos: 'before' | 'after' = pos === 'before' || pos === 'inside' ? 'after' : 'before';
    steps.push(() => {
      const tParent = defaultSceneGraph.getNode(targetId)?.parent ?? null;
      if (!tParent || compOfLayer(id) !== compOfLayer(targetId) || id === targetId) return [];
      if (defaultSceneGraph.getNode(id)?.parent === tParent) return [];
      return canReparent(id, tParent) ? [setParentCmd(id, tParent)] : [];
    });
    steps.push(() => (id === targetId ? [] : adjacentOrderCommands(id, targetId, childPos)));
  }
  await inOneEntry(label, steps);
}

// ── Rename ────────────────────────────────────────────────────────────

/** How many layers and compositions carry `name` (B4: the document mirror). */
function countNamed(name: string): number {
  const m = documentMirror();
  let n = 0;
  for (const id of m.layerIds()) if (m.layer(id)?.name === name) n += 1;
  for (const c of m.comps.values()) if (c.settings.name === name) n += 1;
  return n;
}

/**
 * Inline rename (F2 / double-click). Through the engine's `renameLayer` —
 * which follows the rename through the expressions that name the layer in the
 * same entry and reports repaired / captured counts (B3z) — or `renameItem`
 * for a composition root's row, which renames the comp and its record together.
 */
export async function renameLayerEdit(nodeId: string, name: string): Promise<RenameLayerResult> {
  const none: RenameLayerResult = { ok: false, repaired: [], captured: [], nameAlreadyInUse: false };
  // B4: the row's current name from the document mirror (a layer, or a composition's record).
  const m = documentMirror();
  const layer = m.layer(nodeId);
  const comp = layer ? undefined : m.comp(nodeId);
  if (!layer && !comp) return none;
  const oldName = layer ? layer.name : comp!.settings.name;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === oldName) return { ...none, ok: trimmed !== '' };
  if (!isLayer(nodeId) && !isCompItem(nodeId)) return none;
  const label = `Rename “${oldName}” to “${trimmed}”`;
  if (!isLayer(nodeId)) {
    const nameAlreadyInUse = countNamed(trimmed) > 0;
    const res = await edit(label, { type: 'renameItem', item: nodeId, name: trimmed });
    return { ok: res.ok, repaired: [], captured: [], nameAlreadyInUse: res.ok && nameAlreadyInUse };
  }
  // The engine follows the rename through the expressions that name the layer
  // (B3z `renameLayer`) and counts what it repaired / what now reads this layer.
  const res = await edit(label, { type: 'renameLayer', layer: nodeId, name: trimmed });
  if (!res.ok) return none;
  const r = res.value[0] as EngineRenameResult;
  const counted = (n: number): RepairedRef[] => Array.from({ length: n }, () => ({ nodeId, prop: '' }));
  return { ok: true, repaired: counted(r.repaired), captured: counted(r.captured), nameAlreadyInUse: r.nameAlreadyInUse };
}

// ── Delete ────────────────────────────────────────────────────────────

/**
 * Delete these layers, skipping locked ones and composition roots (as
 * `deleteSelectedLayers` did), and clear the selection. One entry, one
 * `deleteLayers` per composition. Resolves to how many were deleted.
 */
export async function deleteLayersEdit(ids: ReadonlyArray<string>): Promise<number> {
  const m = documentMirror();
  const picked = [...new Set(ids)].filter((id) => {
    const l = m.layer(id);
    return !!l && !l.switches.locked && !!compOfLayer(id);
  });
  const count = picked.length;
  if (count === 0) return 0;
  const byComp = new Map<string, string[]>();
  // A group takes its members with it (see `withGroupMembers`).
  for (const id of withGroupMembers(picked)) {
    const comp = compOfLayer(id);
    if (!comp) continue;
    const list = byComp.get(comp);
    if (list) list.push(id);
    else byComp.set(comp, [id]);
  }
  const res = await edit(count === 1 ? 'Delete layer' : 'Delete layers',
    [...byComp.values()].map((layers) => ({ type: 'deleteLayers', layers }) as Command));
  if (!res.ok) return 0;
  useSelectionStore.getState().clear();
  return count;
}

// ── Time verbs (the row menu's Time submenu) ──────────────────────────

/**
 * Time-Reverse over a selection, `toggleReverse`'s rule: if any layer plays
 * forward the whole set ends up reversed, otherwise the whole set plays
 * forward again. `timeReverseLayers` flips, so it goes to the layers not
 * already in the target state. One entry.
 */
export async function reverseLayersEdit(ids: ReadonlyArray<string>): Promise<void> {
  const layers = ids.filter((id) => isLayer(id));
  if (layers.length === 0) return;
  // B4: a reversed layer plays at a negative stretch (`LayerTiming.stretch`).
  const m = documentMirror();
  const reversed = (id: string): boolean => (m.layer(id)?.timing.stretch ?? 1) < 0;
  const target = layers.some((id) => !reversed(id));
  const flip = layers.filter((id) => reversed(id) !== target);
  if (flip.length === 0) return;
  await edit('Time-Reverse Layer', flip.map((id) => ({ type: 'timeReverseLayers', layers: [id] }) as Command));
}

/**
 * Freeze Frame at Playhead over a selection, `toggleFreeze`'s rule: if any
 * layer is live, the whole set freezes on the frame under the playhead.
 * Returns false when every layer is already frozen — un-freezing has no
 * command (the caller keeps the legacy writer).
 */
export async function freezeLayersEdit(ids: ReadonlyArray<string>, seconds: number): Promise<boolean> {
  const layers = ids.filter((id) => isLayer(id));
  if (layers.length === 0) return true;
  // B4-gap: a layer's Freeze Frame hold (`layerTime.freeze`) has no `LayerTiming` field.
  if (!layers.some((id) => !getNodeLayerTime(id).freeze)) return false;
  const time = compTime(seconds);
  await edit('Freeze Frame', layers.map((layer) => ({ type: 'freezeFrame', layer, time, lastFrame: false }) as Command));
  return true;
}

// ── Compositions (the Compositions list, the comp tab menu) ───────────

/** Rename a composition (its record and its root row, together). */
export async function renameCompositionEdit(compId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed || !isCompItem(compId)) return;
  await edit('Rename Composition', { type: 'renameItem', item: compId, name: trimmed });
}

/**
 * Duplicate a composition — "<name> copy", as the editor has always named it
 * (the API's own copy is "<name> 2", so the duplicate is renamed in the same
 * entry) — and open the copy. Resolves to the new comp id.
 */
export async function duplicateCompositionEdit(compId: string): Promise<string | null> {
  const src = documentMirror().comp(compId)?.settings;
  if (!src || !isCompItem(compId)) return null;
  const client = engine();
  const label = 'Duplicate Composition';
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return null;
  }
  let newId: string | null = null;
  const dup = await client.execute({ type: 'duplicateComposition', comp: compId, deep: false });
  if (!dup.ok) reportEngineError(label, dup.error);
  else {
    newId = (dup.value as { item?: string }).item ?? null;
    if (newId) {
      const renamed = await client.execute({ type: 'renameItem', item: newId, name: `${src.name} copy` });
      if (!renamed.ok) {
        reportEngineError(label, renamed.error);
        newId = null;
      }
    }
  }
  const closed = await client.endGesture(opened.value.gesture, newId !== null);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (!newId) return null;
  // Editor state: open the copy (as `duplicateComposition` did).
  const name = documentMirror().comp(newId)?.settings.name ?? `${src.name} copy`;
  useProjectStore.getState().actions.openTab(newId, [newId], name);
  useSelectionStore.getState().clear();
  return newId;
}

/** What "Delete Composition" will take with it, for the confirmation. */
export function compositionDeleteSummary(compId: string): { layers: number; usedBy: number } {
  return {
    layers: compLayersDeep(documentMirror(), compId).length,
    usedBy: isCompItem(compId) ? layersUsingItem(compId).length : 0,
  };
}

/**
 * The Delete Composition confirmation: its own layers, and the layers in
 * OTHER compositions that place it (the delete takes those too, as in AE).
 */
export function deleteCompositionWarning(name: string, compId: string): string {
  const { layers, usedBy } = compositionDeleteSummary(compId);
  const own = layers > 0 ? ` and its ${layers} layer${layers === 1 ? '' : 's'}` : '';
  const uses = usedBy > 0 ? ` It is used by ${usedBy} layer${usedBy === 1 ? '' : 's'} in other compositions, which will be removed too.` : '';
  return `Delete “${name}”${own}?${uses}`;
}

/**
 * Delete a composition: `removeItems` with the layers that place it (AE
 * removes a deleted comp's instances too). Its tabs close and the selection
 * clears (editor state). A group opened in its own tab is a LAYER, not a
 * composition, and is refused, as before. Resolves to whether it went.
 */
export async function deleteCompositionEdit(compId: string): Promise<boolean> {
  // B4: the compositions from the document mirror (a group opened in its own
  // tab is a layer, not a composition record there).
  const m = documentMirror();
  if (!m.comp(compId)) return false;
  if (!isCompItem(compId)) return false;
  // Deleting the LAST composition leaves the empty project's placeholder in its
  // place (AE's "no compositions" state: pristine, adopted by New Composition,
  // no tab opened) — created first, in the same entry.
  const last = liveComps(m).length <= 1;
  const cmds: Command[] = [
    ...(last ? [{ type: 'createComposition', settings: { name: 'Composition 1', pristine: true }, fromItems: [] } as Command] : []),
    { type: 'removeItems', items: [compId], removeUsingLayers: true },
  ];
  const res = await edit('Delete Composition', cmds);
  if (!res.ok) return false;
  const s = useProjectStore.getState();
  for (const tab of Object.values(s.tabs)) {
    if (tab.compositionId === compId) s.actions.closeTab(tab.id);
  }
  useSelectionStore.getState().clear();
  return true;
}
