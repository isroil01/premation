/**
 * After Effects' nested-composition navigation, over the engine (B4).
 *
 *   - Double-clicking a precomposition layer OPENS the composition it shows:
 *     the viewer switches to it and the Timeline gets a tab for it.
 *   - The Composition Navigator bar shows the flow path — downstream
 *     (containing) comps on the left, upstream on the right — and clicking a
 *     name activates that comp.
 *   - Shift+Esc opens the most recently active comp in the same network.
 *   - "Synchronize Time Of All Related Items": the playhead follows across the
 *     jump, mapped through each layer by the engine's `mapLayerTime` (the
 *     layer's time remap, stretch, reverse; a group maps one-to-one; no answer
 *     for a keyframed remap going outward, where AE leaves the playhead alone).
 *
 * What a layer opens and whether a comp still exists come off the document
 * mirror (`@core/mirror/compNetwork`); the trail lives on the tab
 * (`TabInfo.breadcrumbPath` / `breadcrumbVia`). The tab switches at once; the
 * mapped time follows when the engine answers.
 */

import { secondsToFlicks, flicksToSeconds } from '@motion/engine-api';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore, type TabInfo } from '@stores/projectStore';
import { getTime, setTime } from '@stores/playbackClockStore';
import { useSelectionStore } from '@stores/selectionStore';
import { engine } from '@core/engine/engineInstance';
import { seekPlayhead } from '@core/timeline/timelineView';
import { mirrorCompExists, mirrorCompName, mirrorNestedTarget } from '@core/mirror/compNetwork';

function exists(id: string): boolean {
  return mirrorCompExists(documentMirror(), id);
}

/** Parent-comp time → the time inside what `layerId` shows (`outward`: the reverse), or null when it has none. */
async function mapThrough(layerId: string, seconds: number, outward: boolean): Promise<number | null> {
  if (!documentMirror().layer(layerId)) return null;
  try {
    const res = await engine().query({ type: 'mapLayerTime', layer: layerId, time: secondsToFlicks(seconds), outward });
    return res.ok && res.value.time !== undefined ? flicksToSeconds(res.value.time) : null;
  } catch {
    return null;
  }
}

/** Map `seconds` through each layer in turn (in, or out). Null as soon as one step has no answer. */
async function mapChain(layers: ReadonlyArray<string | undefined>, seconds: number, outward: boolean): Promise<number | null> {
  let t: number | null = seconds;
  for (const layer of layers) {
    if (t === null) return null;
    t = layer ? await mapThrough(layer, t, outward) : null;
  }
  return t;
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

function durationOf(compId: string): number {
  const d = documentMirror().comp(compId)?.settings.duration;
  return typeof d === 'number' && d > 0 ? flicksToSeconds(d) : Infinity;
}

/**
 * Activate `compId`'s tab (opening one if needed) with `path`, then — once
 * `time` resolves — park its playhead there, if the tab is still the one in
 * view. The engine is the transport authority, so it is seeked too.
 */
function activate(compId: string, path: string[], via: string[], time: Promise<number | null> | null): string {
  const actions = useProjectStore.getState().actions;
  const tabId = actions.openTab(compId, path, mirrorCompName(documentMirror(), compId));
  actions.setBreadcrumb(tabId, path, via);
  // A selection belongs to the comp it was made in — AE opens a comp with nothing selected.
  useSelectionStore.getState().clear();
  if (time) {
    void time.then((t) => {
      if (t === null || !Number.isFinite(t) || useProjectStore.getState().activeTabId !== tabId) return;
      const clamped = Math.min(Math.max(0, t), durationOf(compId));
      try {
        seekPlayhead(clamped);
      } catch {
        // No transport yet (headless) — the clock below is still right.
      }
      setTime(tabId, clamped);
    });
  }
  return tabId;
}

/**
 * AE's double-click on a precomposition layer: open the composition it shows,
 * with the playhead carried across. Returns false (and does nothing) for a
 * layer that opens nothing, so callers can fall back to their own behaviour.
 */
export function openLayerComposition(layerId: string): boolean {
  const target = mirrorNestedTarget(documentMirror(), layerId);
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
      // Already downstream of here (only reachable through a stale trail).
      path = trail.path.slice(0, existing + 1);
      via = trail.via.slice(0, existing);
    } else {
      path = [...trail.path.slice(0, trail.at + 1), target.compId];
      via = [...trail.via.slice(0, trail.at), layerId];
    }
  }
  if (from) remember(from.id);
  activate(target.compId, path, via, mapThrough(layerId, parentTime, false));
  return true;
}

/**
 * {@link openLayerComposition} for a layer a command JUST made (Pre-compose ▸
 * Open New Composition): the mirror learns the layer and its comp from the
 * command's events a moment later, so wait for them (up to `timeoutMs`).
 */
export function openLayerCompositionWhenKnown(layerId: string, timeoutMs = 2000): Promise<boolean> {
  if (openLayerComposition(layerId)) return Promise.resolve(true);
  const m = documentMirror();
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const unsubscribe = m.subscribe(['comps', 'layers', `layer:${layerId}`], () => {
      if (openLayerComposition(layerId)) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Activate the comp at `index` in the active tab's trail — a click on a name
 * in the Composition Navigator. Moving downstream (left) maps the playhead out
 * through each layer; moving upstream (right) maps it in. The trail is kept.
 */
export function navigateToCrumb(index: number): boolean {
  const tab = activeTab();
  if (!tab) return false;
  const { path, via, at } = trailOf(tab);
  if (index === at || index < 0 || index >= path.length) return false;
  const compId = path[index]!;
  if (!exists(compId)) return false;
  const now = getTime(tab.id);
  const time = index < at
    ? mapChain(via.slice(index, at).reverse(), now, true)
    : mapChain(via.slice(at, index), now, false);
  remember(tab.id);
  activate(compId, path, via, time);
  return true;
}

/**
 * Open a composition that CONTAINS the one in view — a downstream entry of the
 * Mini-Flowchart. `viaLayerId` is the layer in it that shows the current comp;
 * the playhead maps out through it. When that comp is already on the trail,
 * this is a navigator click; otherwise it goes on the trail's LEFT.
 */
export function openContainingComposition(compId: string, viaLayerId: string): boolean {
  const tab = activeTab();
  if (!tab || !exists(compId)) return false;
  const { path, via, at } = trailOf(tab);
  const onTrail = path.indexOf(compId);
  if (onTrail >= 0 && onTrail < at) return navigateToCrumb(onTrail);
  remember(tab.id);
  activate(compId, [compId, ...path.slice(at)], [viaLayerId, ...via.slice(at)], mapThrough(viaLayerId, getTime(tab.id), true));
  return true;
}

// ── Shift+Esc: the most recently active composition in the network ───

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

function previousTarget(): { index: number } | { tabId: string } | null {
  const tab = activeTab();
  if (!tab) return null;
  const { path, at } = trailOf(tab);
  const s = useProjectStore.getState();
  const prev = previousTabId && previousTabId !== tab.id ? s.tabs[previousTabId] : undefined;
  if (prev && exists(prev.compositionId)) {
    const i = path.indexOf(prev.compositionId);
    if (i >= 0 && i !== at) return { index: i };
    // Related the other way round: this comp is on the previous tab's trail.
    if (prev.breadcrumbPath.includes(tab.compositionId)) return { tabId: prev.id };
  }
  if (at > 0 && exists(path[at - 1]!)) return { index: at - 1 };
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

// ── Repair: a tab whose comp or group was removed ───────────────────

/**
 * Close tabs whose comp no longer exists in the document (an undo took the
 * group or the composition away — tabs are editor state, not in history),
 * stepping the view back out to the nearest comp on its trail that still
 * does. Does nothing until the mirror holds a document.
 */
export function repairNestedTabs(): void {
  const m = documentMirror();
  if (m.status !== 'ready') return;
  const s = useProjectStore.getState();
  for (const tab of Object.values(s.tabs)) {
    if (exists(tab.compositionId)) continue;
    const { path, via, at } = trailOf(tab);
    const wasActive = useProjectStore.getState().activeTabId === tab.id;
    s.actions.closeTab(tab.id);
    if (!wasActive || at <= 0) continue;
    for (let i = at - 1; i >= 0; i--) {
      const compId = path[i]!;
      if (!exists(compId)) continue;
      activate(compId, path.slice(0, i + 1), via.slice(0, i), null);
      break;
    }
  }
}

/** Repair on every change to the document's compositions or layers. Returns the disposer. */
export function installCompNavigation(): () => void {
  return documentMirror().subscribe(['comps', 'layers'], repairNestedTabs);
}
