/**
 * compNavigation — After Effects' nested-composition navigation.
 *
 * AE's model, which this reproduces:
 *   - Double-clicking a precomposition layer OPENS the composition it shows:
 *     the viewer switches to it and the Timeline gets a tab for it. Its layers
 *     are then edited on their own, at the nested comp's own size and time.
 *   - The Composition Navigator bar along the top of the viewer shows the flow
 *     path — downstream (containing) comps on the left, upstream on the right —
 *     and clicking a name activates that comp.
 *   - Shift+Esc opens the most recently active comp in the same network.
 *   - "Synchronize Time Of All Related Items" is on by default, so the playhead
 *     follows across the jump: a precomp placed at 2s shows its own 0s at the
 *     parent's 2s, and opening it from there lands on 0s.
 *
 * There are two kinds of nested thing here, and one kind AE does not have:
 *   - a comp INSTANCE (`readCompRef`) opens the composition it references —
 *     that comp's own time axis, so the playhead is mapped through the layer;
 *   - a GROUP (a legacy in-place precomp, or a plain group) opens as a tab of
 *     its own subtree. A group's layers keep their clips on the PARENT's time
 *     axis (precompose transfers them without an offset), so the playhead maps
 *     one-to-one.
 *
 * The trail lives on the tab (`TabInfo.breadcrumbPath` / `breadcrumbVia`) and
 * is saved with the document. Tabs are not in undo history, so an undo that
 * removes a group you are inside would leave its tab pointing at nothing —
 * `installCompNavigation` repairs that by stepping back out to the nearest comp
 * that still exists.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readCompRef } from '@core/scene/compInstance';
import { getEventBus } from '@core/events/EventBus';
import { useProjectStore, type TabInfo } from '@stores/projectStore';
import { getTime, setTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { compToKeyframeTime, getTimelineController, keyframeToCompTime } from '@core/timeline/TimelineController';
import { defaultAnimation } from '@motion/animation';

/** What double-clicking a layer opens, when it opens anything. */
export interface NestedTarget {
  /** The composition (or group) the new viewer shows. */
  compId: string;
  title: string;
  /** `instance` = a placed composition; `group` = a group opened as its own tab. */
  kind: 'instance' | 'group';
}

/**
 * The composition a layer opens into, or null for a layer that has none (a
 * shape, text, footage, a comp ROOT, a comp instance whose source is gone).
 */
export function nestedTargetOf(layerId: string): NestedTarget | null {
  const node = defaultSceneGraph.getNode(layerId);
  if (!node) return null;
  const ref = readCompRef(node);
  if (ref) {
    const refNode = defaultSceneGraph.getNode(ref);
    if (!refNode) return null;
    const title = useProjectStore.getState().comps[ref]?.name ?? refNode.name ?? ref;
    return { compId: ref, title, kind: 'instance' };
  }
  // A comp's own root is a group with no parent — it is the composition, not a
  // layer in one.
  if (node.parent && readNodeKind(node) === 'group') {
    return { compId: node.id, title: node.name || node.id, kind: 'group' };
  }
  return null;
}

/**
 * True for a composition the user made, false for the settings record a
 * group gets when it is opened in a tab (`openTab` seeds one so the tab has a
 * size and frame rate). Lists of compositions — the Scene panel, Insert ▸
 * Composition — must not offer those groups as comps.
 */
export function isRealComposition(compId: string): boolean {
  return !defaultSceneGraph.getNode(compId)?.parent;
}

/** True when `nodeId` sits somewhere below `ancestorId` in the scene tree. */
export function isDescendantOf(nodeId: string, ancestorId: string): boolean {
  let parent = defaultSceneGraph.getNode(nodeId)?.parent;
  for (let guard = 0; parent && guard < 256; guard++) {
    if (parent === ancestorId) return true;
    parent = defaultSceneGraph.getNode(parent)?.parent;
  }
  return false;
}

function isRemapped(layerId: string): boolean {
  return defaultAnimation.isAnimated(layerId, 'timeRemap') || defaultAnimation.isAnimated(layerId, 'precompTime');
}

/**
 * Parent-comp time → the time inside the composition `layerId` shows. This is
 * the renderer's `precompSourceTime`: the layer's own time remap when
 * keyframed, then its clip retime / stretch (`compToKeyframeTime`).
 */
export function innerTimeOf(layerId: string, parentTime: number): number {
  const node = defaultSceneGraph.getNode(layerId);
  if (!node || !readCompRef(node)) return parentTime;
  const remapped = defaultAnimation.sample(layerId, 'timeRemap', parentTime)
    ?? defaultAnimation.sample(layerId, 'precompTime', parentTime);
  const t = typeof remapped === 'number' ? remapped : parentTime;
  return compToKeyframeTime(layerId, t);
}

/**
 * Nested time → the parent-comp time that shows it, or null when that has no
 * single answer (a keyframed time remap can show one inner frame at many
 * parent times, or at none) — the caller then leaves the parent's playhead
 * where it was, which is what AE does with a remapped precomp.
 */
export function outerTimeOf(layerId: string, innerTime: number): number | null {
  const node = defaultSceneGraph.getNode(layerId);
  if (!node) return null;
  if (!readCompRef(node)) return innerTime;
  if (isRemapped(layerId)) return null;
  return keyframeToCompTime(layerId, innerTime);
}

function activeTab(): TabInfo | null {
  const s = useProjectStore.getState();
  return s.activeTabId ? s.tabs[s.activeTabId] ?? null : null;
}

/** A tab's trail, normalised so it always contains the tab's own comp. */
function trailOf(tab: TabInfo): { path: string[]; via: string[]; at: number } {
  let path = tab.breadcrumbPath.length > 0 ? [...tab.breadcrumbPath] : [tab.compositionId];
  let at = path.indexOf(tab.compositionId);
  if (at < 0) {
    path = [tab.compositionId];
    at = 0;
  }
  const via = [...(tab.breadcrumbVia ?? [])].slice(0, path.length - 1);
  return { path, via, at };
}

function titleOf(compId: string): string {
  return useProjectStore.getState().comps[compId]?.name ?? defaultSceneGraph.getNode(compId)?.name ?? compId;
}

function durationOf(compId: string): number {
  const d = useProjectStore.getState().comps[compId]?.durationSeconds;
  return typeof d === 'number' && d > 0 ? d : Infinity;
}

/**
 * Activate `compId`'s tab (opening one if needed) with `trail`, then park its
 * playhead at `time` when there is one. The engine is the transport authority,
 * so it is seeked too — the clock alone would be overwritten by the engine's
 * next `CurrentTimeChanged`.
 */
function activate(compId: string, path: string[], via: string[], time: number | null): string {
  const actions = useProjectStore.getState().actions;
  const tabId = actions.openTab(compId, path, titleOf(compId));
  actions.setBreadcrumb(tabId, path, via);
  // A selection belongs to the comp it was made in. Carrying the precomp
  // LAYER into its own comp left the Properties panel editing a layer that is
  // not in the viewer — AE opens a comp with nothing selected.
  useSelectionStore.getState().clear();
  if (time !== null && Number.isFinite(time)) {
    const t = Math.min(Math.max(0, time), durationOf(compId));
    try {
      getTimelineController().seekSeconds(t);
    } catch {
      // No engine yet (headless) — the clock below is still right.
    }
    setTime(tabId, t);
  }
  return tabId;
}

/**
 * AE's double-click on a precomposition layer: open the composition it shows,
 * with the playhead carried across. Returns false (and does nothing) for a
 * layer that opens nothing, so callers can fall back to their own behaviour.
 */
export function openLayerComposition(layerId: string): boolean {
  const target = nestedTargetOf(layerId);
  if (!target) return false;
  const from = activeTab();
  const trail = from ? trailOf(from) : { path: [] as string[], via: [] as string[], at: -1 };
  const parentTime = from ? getTime(from.id) : 0;

  let path: string[];
  let via: string[];
  if (trail.path[trail.at + 1] === target.compId) {
    // Walking back down a trail we already have: keep what lies beyond it.
    path = trail.path;
    via = [...trail.via];
    via[trail.at] = layerId;
  } else {
    const existing = trail.path.indexOf(target.compId);
    if (existing >= 0 && existing <= trail.at) {
      // Already downstream of here (only reachable through a stale trail —
      // cycles are refused at insert). Step back to it instead of looping.
      path = trail.path.slice(0, existing + 1);
      via = trail.via.slice(0, existing);
    } else {
      path = [...trail.path.slice(0, trail.at + 1), target.compId];
      via = [...trail.via.slice(0, trail.at), layerId];
    }
  }
  activate(target.compId, path, via, innerTimeOf(layerId, parentTime));
  return true;
}

/**
 * Activate the comp at `index` in the active tab's trail — a click on a name
 * in the Composition Navigator. Moving downstream (left) maps the playhead out
 * through each layer; moving upstream (right) maps it in. The trail itself is
 * kept whole, so the comps on either side stay reachable.
 */
export function navigateToCrumb(index: number): boolean {
  const tab = activeTab();
  if (!tab) return false;
  const { path, via, at } = trailOf(tab);
  if (index === at || index < 0 || index >= path.length) return false;
  const compId = path[index]!;
  if (!defaultSceneGraph.getNode(compId)) return false;

  let t: number | null = getTime(tab.id);
  if (index < at) {
    for (let i = at - 1; i >= index && t !== null; i--) {
      const layer = via[i];
      t = layer && defaultSceneGraph.getNode(layer) ? outerTimeOf(layer, t) : null;
    }
  } else {
    for (let i = at; i < index && t !== null; i++) {
      const layer = via[i];
      t = layer && defaultSceneGraph.getNode(layer) ? innerTimeOf(layer, t) : null;
    }
  }
  remember(tab.id);
  activate(compId, path, via, t);
  return true;
}

/**
 * Open a composition that CONTAINS the one in view — a downstream entry of the
 * Mini-Flowchart. `viaLayerId` is the layer in it that shows the current comp;
 * the playhead maps out through it. When that comp is already on the trail,
 * this is a navigator click. Otherwise it goes on the trail's LEFT, keeping
 * the comps upstream of here one click away.
 */
export function openContainingComposition(compId: string, viaLayerId: string): boolean {
  const tab = activeTab();
  if (!tab || !defaultSceneGraph.getNode(compId)) return false;
  const { path, via, at } = trailOf(tab);
  const onTrail = path.indexOf(compId);
  if (onTrail >= 0 && onTrail < at) return navigateToCrumb(onTrail);
  const t = defaultSceneGraph.getNode(viaLayerId) ? outerTimeOf(viaLayerId, getTime(tab.id)) : null;
  remember(tab.id);
  activate(compId, [compId, ...path.slice(at)], [viaLayerId, ...via.slice(at)], t);
  return true;
}

// ── Shift+Esc: the most recently active composition in the network ───

/** The tab navigation last left, for Shift+Esc to return to. */
let previousTabId: string | null = null;

function remember(tabId: string): void {
  previousTabId = tabId;
}

// Any tab switch counts — a click on a Timeline tab is as much "the comp I was
// just in" as a navigator jump.
useProjectStore.subscribe((state, prev) => {
  if (state.activeTabId !== prev.activeTabId && prev.activeTabId && state.tabs[prev.activeTabId]) {
    previousTabId = prev.activeTabId;
  }
  if (previousTabId && !state.tabs[previousTabId]) previousTabId = null;
});

/**
 * Where Shift+Esc goes: the previously active comp when it is in this comp's
 * network (on the trail), otherwise one step downstream. Null when there is
 * nowhere to go.
 */
function previousTarget(): { index: number } | { tabId: string } | null {
  const tab = activeTab();
  if (!tab) return null;
  const { path, at } = trailOf(tab);
  const s = useProjectStore.getState();
  const prev = previousTabId && previousTabId !== tab.id ? s.tabs[previousTabId] : undefined;
  if (prev && defaultSceneGraph.getNode(prev.compositionId)) {
    const i = path.indexOf(prev.compositionId);
    if (i >= 0 && i !== at) return { index: i };
    // Related the other way round: this comp is on the previous tab's trail.
    if (prev.breadcrumbPath.includes(tab.compositionId)) return { tabId: prev.id };
  }
  if (at > 0 && defaultSceneGraph.getNode(path[at - 1]!)) return { index: at - 1 };
  return null;
}

export function canOpenPreviousComposition(): boolean {
  return previousTarget() !== null;
}

/** AE's Shift+Esc. */
export function openPreviousComposition(): boolean {
  const target = previousTarget();
  if (!target) return false;
  if ('index' in target) return navigateToCrumb(target.index);
  const from = activeTab();
  if (from) remember(from.id);
  useProjectStore.getState().actions.setActiveTab(target.tabId);
  return true;
}

// ── Repair: a tab whose group was removed ───────────────────────────

/**
 * Close tabs whose nested comp no longer exists (an undo took the group away,
 * or it was deleted from the parent), stepping the view back out to the
 * nearest comp on its trail that still does. A tab whose comp is the FIRST
 * entry of its trail (a top-level comp) closes only when the comp's settings
 * record is gone too — `deleteComposition` closes its own tabs, but engine
 * edits (undo of New Composition, `removeItems`) do not touch editor state.
 */
export function repairNestedTabs(): void {
  const s = useProjectStore.getState();
  for (const tab of Object.values(s.tabs)) {
    if (defaultSceneGraph.getNode(tab.compositionId)) continue;
    const { path, via, at } = trailOf(tab);
    if (at <= 0) {
      // A TOP-LEVEL comp gone from the document with its record — an undone
      // New Composition, an engine `removeItems` (neither knows about tabs,
      // which are editor state). Its tab has nothing left to show.
      if (!useProjectStore.getState().comps[tab.compositionId]) s.actions.closeTab(tab.id);
      continue;
    }
    const wasActive = s.activeTabId === tab.id;
    s.actions.closeTab(tab.id);
    if (!wasActive) continue;
    for (let i = at - 1; i >= 0; i--) {
      const compId = path[i]!;
      if (!defaultSceneGraph.getNode(compId)) continue;
      activate(compId, path.slice(0, i + 1), via.slice(0, i), null);
      break;
    }
  }
}

/**
 * Start repairing on structural scene changes. Deferred a tick: an undo
 * restore clears the graph and re-adds every node, and the intermediate empty
 * graph must not close anything. Returns the disposer.
 */
export function installCompNavigation(): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const sub = getEventBus().on('SceneGraphChanged', () => {
    if (pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      repairNestedTabs();
    }, 0);
  });
  return () => {
    if (pending !== null) clearTimeout(pending);
    sub.dispose();
  };
}
