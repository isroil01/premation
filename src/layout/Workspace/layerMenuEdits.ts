/**
 * The viewport's right-click layer actions through the engine API (B3,
 * docs/B3_PATTERNS.md §1/§2/§6): duplicate, delete, arrange, group / ungroup,
 * Merge Paths (bake), label colour, the 3D switch, "Add Keyframe" and the
 * footage time verbs.
 * Each function is ONE user action = ONE undo entry.
 *
 * Same rules as the legacy helpers they replace (`sceneInsert`,
 * `parenting.arrangeNodes`, `labelColor`, `layerTime`): locked layers are not
 * deleted, a composition root is not a layer, the selection after the action
 * is the UI's. Where the legacy helper did something the API cannot say yet
 * the function keeps it, marked `B3-legacy` with the gap.
 */

import type { Command, LayerSwitchesPatch, PropRef } from '@motion/engine-api';
import { reorderSiblings, type StackAction } from '@core/scene/parenting';
import type { FrameBlend } from '@core/scene/layerTime';
import { apiParentOf, compOfLayer, graph as docGraph, isLayer, layerIdsOfComp } from '@core/engine/doc';
import { offDocument } from '@core/engine/offDocument';
import { encodeFragment } from '@core/engine/handlers/layers';
import { mergeSelectedPaths, type MergeOp } from '@core/scene/mergePaths';
import { labelIndexOf } from '@core/engine/model';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { compTime, propRefForTrack } from '@core/engine/propRefs';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { canBe3DLayer } from '@core/mirror/layerKinds';
import { childOrderOf } from '@core/mirror/layerTree';
import { storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { trackValueCommands } from './viewportEdits';

/** Ids grouped by the composition they are layers of (non-layers dropped). */
function byComp(ids: Iterable<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const id of new Set(ids)) {
    const comp = compOfLayer(id);
    if (!comp) continue;
    const list = out.get(comp);
    if (list) list.push(id);
    else out.set(comp, [id]);
  }
  return out;
}

// ── Delete ────────────────────────────────────────────────────────────

/**
 * `ids` plus the members of every GROUP layer among them (recursively, never
 * into a precomp, locked members left out). `deleteLayers` unparents the
 * children of a deleted layer keeping their world transform (AE's rule for a
 * parent link, right for a null); a group is a container, and deleting it has
 * always taken what is inside it (`deleteLayerNode` removes the subtree).
 */
export function withGroupMembers(ids: Iterable<string>): string[] {
  const m = documentMirror();
  const out = new Set<string>();
  // The API's 'group' kind is exactly a group that is not a precomp.
  const walk = (id: string): void => {
    for (const kid of childOrderOf(m, id)) {
      const k = m.layer(kid);
      if (!k || k.switches.locked || out.has(kid)) continue;
      out.add(kid);
      if (k.kind === 'group') walk(kid);
    }
  };
  for (const id of ids) {
    out.add(id);
    if (m.layer(id)?.kind === 'group') walk(id);
  }
  return [...out];
}

/**
 * Delete the selected layers (locked ones and composition roots are skipped,
 * as `deleteSelectedLayers` skipped them) and clear the selection. One entry,
 * "Delete layer(s)"; one `deleteLayers` per composition inside it.
 */
export async function deleteSelectedLayersEdit(): Promise<void> {
  const m = documentMirror();
  // A composition root is not a layer, so the mirror has no layer record for it.
  const ids = useSelectionStore.getState().ids.filter((id) => {
    const l = m.layer(id);
    return !!l && !l.switches.locked;
  });
  const count = ids.filter((id) => compOfLayer(id)).length;
  const groups = byComp(withGroupMembers(ids));
  if (count === 0 || groups.size === 0) return;
  const cmds: Command[] = [...groups.values()].map((layers) => ({ type: 'deleteLayers', layers }));
  const res = await edit(count === 1 ? 'Delete layer' : 'Delete layers', cmds);
  if (res.ok) useSelectionStore.getState().clear();
}

// ── Duplicate ─────────────────────────────────────────────────────────

/** The legacy duplicate's placement nudge (Edit ▸ Duplicate offsets the copy). */
const DUPLICATE_OFFSET = 20;

/**
 * Duplicate the selected layers: each copy directly above its original, named
 * "<name> copy" and nudged +20 px / +20 px when its Position is static — what
 * `duplicateSelectedLayers` did — and the copies selected. ONE entry: the
 * duplicate returns the new ids, so the rename and nudge that need them run
 * inside one engine gesture.
 */
export async function duplicateSelectedLayersEdit(): Promise<string[]> {
  const m = documentMirror();
  const ids = useSelectionStore.getState().ids.filter((id) => !!m.layer(id));
  const groups = byComp(ids);
  if (groups.size === 0) return [];
  const label = ids.length === 1 ? 'Duplicate Layer' : 'Duplicate Layers';
  const client = engine();
  const opened = await client.beginGesture(label);
  if (!opened.ok) {
    reportEngineError(label, opened.error);
    return [];
  }
  const newIds: string[] = [];
  let ok = true;
  const follow: Command[] = [];
  for (const layers of groups.values()) {
    const res = await client.execute({ type: 'duplicateLayers', layers });
    if (!res.ok) {
      reportEngineError(label, res.error);
      ok = false;
      break;
    }
    const copies = (res.value as { layers?: string[] }).layers ?? [];
    copies.forEach((copy, i) => {
      const src = m.layer(layers[i]!);
      if (!src) return;
      follow.push({ type: 'renameLayer', layer: copy, name: `${src.name || 'Layer'} copy` });
      // The copy carries the ORIGINAL's values and keys, so the original's
      // Position says both; a static nudge on an animated Position would be a
      // key the user never set.
      const tree = m.tree(src.id);
      const rx = trackRefIn(tree, 'x');
      const ry = trackRefIn(tree, 'y');
      const animated = !rx || !ry || [rx, ry].some((r) => r.info.animated || m.keyframes(src.id, r.path).length > 0);
      const x = rx ? storedNumber(rx, rx.info.value) : undefined;
      const y = ry ? storedNumber(ry, ry.info.value) : undefined;
      if (x !== undefined && y !== undefined && !animated) {
        const move = trackValueCommands(
          [{ nodeId: copy, values: { x: x + DUPLICATE_OFFSET, y: y + DUPLICATE_OFFSET } }],
          { seconds: 0 },
        );
        if (move) follow.push(...move);
      }
      newIds.push(copy);
    });
  }
  if (ok && follow.length > 0) {
    const res = await client.batch(label, follow);
    if (!res.ok) {
      reportEngineError(label, res.error);
      ok = false;
    }
  }
  const closed = await client.endGesture(opened.value.gesture, ok);
  if (!closed.ok) reportEngineError(label, closed.error);
  if (!ok) return [];
  if (newIds.length > 0) useSelectionStore.getState().set(newIds);
  return newIds;
}

// ── Arrange ───────────────────────────────────────────────────────────

const ARRANGE_LABELS: Record<StackAction, string> = {
  front: 'Bring to Front',
  forward: 'Bring Forward',
  backward: 'Send Backward',
  back: 'Send to Back',
};

/**
 * A composition's layer stack (`layerIdsOfComp`'s walk: depth-first,
 * front-most sibling first, a parent before its children, never through a
 * precomp) with some parents' child orders replaced — the state a sequence of
 * `reorderLayers` commands will have reached.
 */
function stackWith(comp: string, orders: ReadonlyMap<string, readonly string[]>): string[] {
  const m = documentMirror();
  const out: string[] = [];
  const walk = (parentId: string): void => {
    const kids = orders.get(parentId) ?? childOrderOf(m, parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const id = kids[i]!;
      const layer = m.layer(id);
      if (!layer) continue;
      out.push(id);
      // Never through a precomp barrier (the API's 'precomp' kind).
      if (layer.kind !== 'precomp') walk(id);
    }
  };
  walk(comp);
  return out;
}

/**
 * The `reorderLayers` commands that turn one parent's child order (`kids`,
 * back → front) into `next`. The command moves ONE contiguous set to a stack
 * index; a step (Bring Forward) moves each selected layer to a different
 * place, so each moved layer is its own command: inserted just in front of
 * the first unselected sibling that follows it in the target order (or at the
 * very back), in front-to-back order. Simulates `moveInStack` so each
 * `toIndex` is computed against the stack as the previous command left it.
 */
export function reorderCommands(
  comp: string,
  parent: string,
  kids: readonly string[],
  next: readonly string[],
  selected: ReadonlySet<string>,
  orders: Map<string, readonly string[]> = new Map(),
): Command[] {
  const target = [...next].reverse(); // front-first
  const cmds: Command[] = [];
  orders.set(parent, [...kids]);
  for (let i = 0; i < target.length; i++) {
    const s = target[i]!;
    if (!selected.has(s)) continue;
    const nextRest = target.slice(i + 1).find((x) => !selected.has(x));
    const stack = stackWith(comp, orders).filter((x) => x !== s);
    const toIndex = nextRest ? stack.indexOf(nextRest) : stack.length + 1;
    // moveInStack, on the simulated order.
    const curFront = [...orders.get(parent)!].reverse();
    const rest = curFront.filter((x) => x !== s);
    let insertAt = rest.length;
    for (let j = 0; j < rest.length; j++) {
      if (stack.indexOf(rest[j]!) >= toIndex) { insertAt = j; break; }
    }
    const moved = [...rest.slice(0, insertAt), s, ...rest.slice(insertAt)];
    if (moved.every((x, j) => x === curFront[j])) continue;
    orders.set(parent, [...moved].reverse());
    cmds.push({ type: 'reorderLayers', comp, layers: [s], toIndex: Math.min(toIndex, stack.length + 1) });
  }
  return cmds;
}

/**
 * Arrange a selection within each layer's own sibling list (never lifted out
 * of its group or precomp) — `arrangeNodes`'s rules (`reorderSiblings`), sent
 * as `reorderLayers`. One entry, named after the menu item. Returns whether
 * anything moved.
 */
export async function arrangeLayersEdit(ids: readonly string[], action: StackAction): Promise<boolean> {
  const m = documentMirror();
  const byParent = new Map<string, string[]>();
  for (const id of ids) {
    const layer = m.layer(id);
    if (!layer || !isLayer(id)) continue;
    // The tree parent: the parent layer, or the composition at the top.
    const parent = layer.parent ?? layer.comp;
    const list = byParent.get(parent);
    if (list) list.push(id);
    else byParent.set(parent, [id]);
  }
  const cmds: Command[] = [];
  const orders = new Map<string, readonly string[]>();
  for (const [parent, group] of byParent) {
    const comp = compOfLayer(group[0]!);
    if (!comp) continue;
    const kids = orders.get(parent) ?? childOrderOf(m, parent);
    // B3-legacy: not a write — `reorderSiblings` is pure arithmetic over an id list (the
    // ratchet's `reorder…` verb match; belongs in the rule's NOT_WRITES).
    const next = reorderSiblings(kids, group, action);
    if (next.length !== kids.length || next.every((x, i) => x === kids[i])) continue;
    cmds.push(...reorderCommands(comp, parent, kids, next, new Set(group), orders));
  }
  if (cmds.length === 0) return false;
  const res = await edit(ARRANGE_LABELS[action], cmds);
  return res.ok;
}

// ── Group / ungroup ───────────────────────────────────────────────────

/**
 * Group the selected layers (`groupLayers`: the group takes the front-most
 * member's slot) and select the group. A selection spanning parents is first
 * gathered under the FIRST layer's parent keeping each layer's world pose
 * (`setParent`, same batch) — where the legacy grouping put the new group
 * ("group in place": a selection inside a group stays inside it). Composition
 * roots are not layers and are left out. Returns false when the layers belong
 * to different compositions (a layer cannot move between compositions).
 */
export async function groupSelectedLayersEdit(): Promise<boolean> {
  const layers = useSelectionStore.getState().ids.filter((id) => isLayer(id));
  if (layers.length === 0) return true;
  if (new Set(layers.map((id) => compOfLayer(id))).size !== 1) return false;
  const comp = compOfLayer(layers[0]!)!;
  const selected = new Set(layers);
  // A layer's parent in the API's terms: a layer of the comp, or the comp itself.
  const parentOf = (id: string): string => apiParentOf(id) ?? comp;
  // The first layer's parent — or, when that is itself being grouped, its
  // nearest ancestor that is not (a group cannot go inside one of its members).
  let target = parentOf(layers[0]!);
  while (selected.has(target)) target = parentOf(target);
  const cmds: Command[] = [];
  const moved = layers.filter((id) => parentOf(id) !== target);
  if (moved.length > 0) {
    cmds.push({ type: 'setParent', layers: moved, ...(target !== comp ? { parent: target } : {}), keepWorldTransform: true });
  }
  cmds.push({ type: 'groupLayers', layers, name: 'Group' });
  const res = await edit('Group Layers', cmds);
  if (res.ok) {
    const group = (res.value[res.value.length - 1] as { layer?: string } | undefined)?.layer;
    if (group) useSelectionStore.getState().set([group]);
  }
  return true;
}

// ── Merge Paths (bake) ────────────────────────────────────────────────

/**
 * Merge Paths ▸ Bake <op>: the selected paths' boolean as new path layers
 * (one per island, holes on the same layer), the operands removed, the
 * results selected — `mergeSelectedPaths`, run OFF-document (ENGINE_API.md
 * §15.9) and sent as ONE batch: `deleteLayers` of what it removed, then
 * `pasteLayers` of what it built, at its stack slot among the remaining
 * layers and under the same parent. One undo entry. Resolves to the new ids
 * (`[]` when fewer than two paths could be merged or the engine refused).
 */
export async function bakeMergePathsEdit(op: MergeOp): Promise<string[]> {
  const label = `Merge Paths (${op})`;
  let plan: { removed: string[]; paste: Command } | null;
  try {
    plan = offDocument(() => mergeSelectedPaths(op), ({ value: made, changed, before }) => {
      const comp = made[0] ? compOfLayer(made[0]) : null;
      if (!comp) return null;
      const created = new Set(made);
      const stack = layerIdsOfComp(comp);
      const tops = stack.filter((id) => created.has(id));
      const first = stack.indexOf(tops[0]!);
      const index = stack.slice(0, first).filter((id) => !created.has(id)).length;
      const parent = docGraph.getNode(tops[0]!)?.parent;
      const removed = changed
        .filter((k) => k.startsWith('node:') && before.get(k) !== undefined && !docGraph.getNode(k.slice(5)))
        .map((k) => k.slice(5));
      const paste = {
        type: 'pasteLayers',
        comp,
        fragment: encodeFragment(tops),
        index,
        ...(parent && parent !== comp ? { parent } : {}),
      } as Command;
      return { removed, paste };
    });
  } catch (err) {
    reportEngineError(label, { code: 'internal', message: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!plan) return [];
  const removed = plan.removed.filter((id) => isLayer(id));
  const cmds: Command[] = removed.length > 0 ? [{ type: 'deleteLayers', layers: removed }, plan.paste] : [plan.paste];
  const res = await edit(label, cmds);
  if (!res.ok) return [];
  const ids = (res.value[res.value.length - 1] as { layers?: string[] } | undefined)?.layers ?? [];
  if (ids.length > 0) useSelectionStore.getState().set(ids);
  return ids;
}

/** Dissolve every selected group layer; its members end up selected. One entry. */
export async function ungroupSelectedEdit(): Promise<void> {
  const m = documentMirror();
  const groups = useSelectionStore.getState().ids.filter((id) => isLayer(id) && m.layer(id)?.kind === 'group');
  if (groups.length === 0) return;
  const res = await edit('Ungroup', groups.map((group) => ({ type: 'ungroupLayer', group }) as Command));
  if (!res.ok) return;
  const freed = res.value.flatMap((r) => (r as { layers?: string[] }).layers ?? []);
  if (freed.length > 0) useSelectionStore.getState().set(freed);
}

// ── Switches ──────────────────────────────────────────────────────────

function switchCmds(ids: readonly string[], patch: (id: string) => LayerSwitchesPatch | null): Command[] {
  const out: Command[] = [];
  for (const id of ids) {
    if (!isLayer(id)) continue;
    const p = patch(id);
    if (p) out.push({ type: 'setLayerSwitches', layers: [id], patch: p });
  }
  return out;
}

/**
 * Label colour for a set of layers. Returns false when `color` is not one of
 * the layer label palette's (the API's label is an index into it).
 */
export async function setLabelColorEdit(ids: readonly string[], color: string | undefined): Promise<boolean> {
  const label = labelIndexOf(color);
  // A colour outside the palette is a custom label (B3z `labelColor`).
  const patch: LayerSwitchesPatch = color && label === 0 ? { labelColor: color } : { label };
  const res = await edit('Label Color', switchCmds(ids, () => patch));
  return res.ok;
}

/**
 * The 3D switch, flipped on EACH layer that can be 3D (the viewport menu's
 * rule), or set to `on` for all (the toolbar cube). One entry.
 */
export async function set3DEdit(ids: readonly string[], on?: boolean): Promise<void> {
  const m = documentMirror();
  const cmds = switchCmds(ids, (id) => {
    const layer = m.layer(id);
    if (!layer || !canBe3DLayer(layer)) return null;
    const next = on ?? !layer.switches.threeD;
    return next === layer.switches.threeD ? null : { threeD: next };
  });
  if (cmds.length === 0) return;
  const anyOn = cmds.some((c) => (c as { patch: LayerSwitchesPatch }).patch.threeD);
  await edit(anyOn ? 'Enable 3D Layer' : 'Disable 3D Layer', cmds);
}

// ── Keyframes at the playhead ─────────────────────────────────────────

/**
 * "Add Keyframe ▸ Position / Scale / …": a key at the playhead on each named
 * property, holding its current value (a key already there is replaced, as
 * the legacy `setKeyframe` did). Member tracks of one property (x/y) are one
 * key. One entry.
 */
export async function addKeyframesAtPlayheadEdit(nodeId: string, label: string, tracks: readonly string[], seconds: number): Promise<void> {
  const seen = new Set<string>();
  const props: PropRef[] = [];
  for (const t of tracks) {
    const r = propRefForTrack(nodeId, t);
    if (!r || !r.animatable || seen.has(r.ref.path)) continue;
    seen.add(r.ref.path);
    props.push(r.ref);
  }
  if (props.length === 0) return;
  const time = compTime(seconds);
  await edit(`Add ${label} keyframe`, {
    type: 'addKeyframes',
    keys: props.map((prop) => ({ prop, time, spatialIn: [], spatialOut: [] })),
  });
}

// ── Footage time (the viewport's Video submenu) ───────────────────────

/** Speed as a stretch percentage (200 = half speed); reversal is kept. */
export async function setStretchEdit(nodeId: string, stretchPercent: number, reversed: boolean): Promise<void> {
  const stretch = (reversed ? -1 : 1) * (stretchPercent / 100);
  await edit('Time Stretch', { type: 'setLayerTiming', items: [{ layer: nodeId, stretch }] });
}

export async function timeReverseEdit(nodeId: string): Promise<void> {
  await edit('Time-Reverse Layer', { type: 'timeReverseLayers', layers: [nodeId] });
}

/** Freeze on the frame under the playhead (comp seconds). */
export async function freezeFrameEdit(nodeId: string, seconds: number): Promise<void> {
  await edit('Freeze Frame', { type: 'freezeFrame', layer: nodeId, time: compTime(seconds), lastFrame: false });
}

const API_FRAME_BLEND: Record<FrameBlend, NonNullable<LayerSwitchesPatch['frameBlend']>> = {
  none: 'off',
  mix: 'frameMix',
  pixelMotion: 'pixelMotion',
};

export async function setFrameBlendEdit(nodeId: string, mode: FrameBlend): Promise<void> {
  await edit('Frame Blending', { type: 'setLayerSwitches', layers: [nodeId], patch: { frameBlend: API_FRAME_BLEND[mode] } });
}
