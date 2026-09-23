/**
 * The viewport's right-click layer actions through the engine API (B3,
 * docs/B3_PATTERNS.md §1/§2/§6): duplicate, delete, arrange, group / ungroup,
 * label colour, the 3D switch, "Add Keyframe" and the footage time verbs.
 * Each function is ONE user action = ONE undo entry.
 *
 * Same rules as the legacy helpers they replace (`sceneInsert`,
 * `parenting.arrangeNodes`, `labelColor`, `layerTime`): locked layers are not
 * deleted, a composition root is not a layer, the selection after the action
 * is the UI's. Where the legacy helper did something the API cannot say yet
 * the function keeps it, marked `B3-legacy` with the gap.
 */

import type { Command, LayerSwitchesPatch, PropRef } from '@motion/engine-api';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { reorderSiblings, type StackAction } from '@core/scene/parenting';
import { isPrecomp } from '@core/scene/precomp';
import { readNodeKind } from '@core/scene/sceneDerive';
import { canBe3D, is3DEnabled } from '@core/scene/threeD';
import type { FrameBlend } from '@core/scene/layerTime';
import { compOfLayer, isLayer } from '@core/engine/doc';
import { labelIndexOf } from '@core/engine/model';
import { engine } from '@core/engine/engineInstance';
import { edit, reportEngineError } from '@core/engine/uiEdits';
import { compTime, propRefForTrack } from '@core/engine/propRefs';
import { useSelectionStore } from '@stores/selectionStore';
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
 * Delete the selected layers (locked ones and composition roots are skipped,
 * as `deleteSelectedLayers` skipped them) and clear the selection. One entry,
 * "Delete layer(s)"; one `deleteLayers` per composition inside it.
 */
export async function deleteSelectedLayersEdit(): Promise<void> {
  const ids = useSelectionStore.getState().ids.filter((id) => {
    const n = defaultSceneGraph.getNode(id);
    return !!n && !n.locked && n.parent !== null;
  });
  const groups = byComp(ids);
  const count = [...groups.values()].reduce((a, l) => a + l.length, 0);
  if (count === 0) return;
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
  const ids = useSelectionStore.getState().ids.filter((id) => defaultSceneGraph.getNode(id)?.parent);
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
      const src = defaultSceneGraph.getNode(layers[i]!);
      if (!src) return;
      follow.push({ type: 'renameLayer', layer: copy, name: `${src.name ?? 'Layer'} copy` });
      const t = src.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
      // Display read (B4 mirror): the copy carries the original's keys, and a
      // static nudge on an animated Position would be a key the user never set.
      const r = propRefForTrack(copy, 'x');
      const animated = r ? r.members.some((m) => defaultAnimation.isAnimated(copy, m)) : true;
      if (t && typeof t.x === 'number' && typeof t.y === 'number' && !animated) {
        const move = trackValueCommands(
          [{ nodeId: copy, values: { x: t.x + DUPLICATE_OFFSET, y: t.y + DUPLICATE_OFFSET } }],
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
  const out: string[] = [];
  const walk = (parentId: string): void => {
    const kids = orders.get(parentId) ?? defaultSceneGraph.getChildOrder(parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const id = kids[i]!;
      const node = defaultSceneGraph.getNode(id);
      if (!node) continue;
      out.push(id);
      if (!isPrecomp(node)) walk(id);
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
  const byParent = new Map<string, string[]>();
  for (const id of ids) {
    const node = defaultSceneGraph.getNode(id);
    if (!node?.parent || !isLayer(id)) continue;
    const list = byParent.get(node.parent);
    if (list) list.push(id);
    else byParent.set(node.parent, [id]);
  }
  const cmds: Command[] = [];
  const orders = new Map<string, readonly string[]>();
  for (const [parent, group] of byParent) {
    const comp = compOfLayer(group[0]!);
    if (!comp) continue;
    const kids = orders.get(parent) ?? defaultSceneGraph.getChildOrder(parent);
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
 * Group the selected layers when they share one parent (`groupLayers`: the
 * group takes the front-most member's slot) and select the group. Returns
 * false when the API cannot express the grouping (the caller keeps the legacy
 * one).
 */
export async function groupSelectedLayersEdit(): Promise<boolean> {
  const ids = useSelectionStore.getState().ids;
  if (ids.length === 0) return true;
  const parents = new Set(ids.map((id) => defaultSceneGraph.getNode(id)?.parent ?? null));
  if (parents.size !== 1 || parents.has(null) || !ids.every((id) => isLayer(id))) return false;
  const res = await edit('Group Layers', { type: 'groupLayers', layers: [...ids], name: 'Group' });
  if (res.ok) {
    const group = (res.value[0] as { layer?: string } | undefined)?.layer;
    if (group) useSelectionStore.getState().set([group]);
  }
  return true;
}

/** Dissolve every selected group layer; its members end up selected. One entry. */
export async function ungroupSelectedEdit(): Promise<void> {
  const groups = useSelectionStore.getState().ids.filter((id) => {
    const n = defaultSceneGraph.getNode(id);
    return !!n && isLayer(id) && readNodeKind(n) === 'group' && !isPrecomp(n);
  });
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
  if (color && label === 0) return false;
  await edit('Label Color', switchCmds(ids, () => ({ label })));
  return true;
}

/**
 * The 3D switch, flipped on EACH layer that can be 3D (the viewport menu's
 * rule), or set to `on` for all (the toolbar cube). One entry.
 */
export async function set3DEdit(ids: readonly string[], on?: boolean): Promise<void> {
  const cmds = switchCmds(ids, (id) => {
    const n = defaultSceneGraph.getNode(id);
    if (!n || !canBe3D(n)) return null;
    const next = on ?? !is3DEnabled(n);
    return next === is3DEnabled(n) ? null : { threeD: next };
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
