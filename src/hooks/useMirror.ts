/**
 * React hooks over the document mirror (src/stores/documentMirror.ts, B4).
 *
 * Every hook subscribes to the narrowest mirror key that covers what it
 * returns and returns the mirror's own immutable records, so a component
 * re-renders exactly when ITS record changed — identity is the change test.
 * Nothing here reads the engine directly; nothing here runs per played frame
 * (a value at the playhead takes the THROTTLED display time from the caller).
 *
 *   useMirror()                          the mirror (for callbacks: read at call time)
 *   useMirrorStatus()                    'loading' | 'ready' | …
 *   useMirrorRevision(enabled?)          the document revision (wakes on EVERY edit — rarely what you want)
 *   useMirrorStructRevision(enabled?)    a counter for every edit but a pure value write (layers, comps, keys, tree shape)
 *   useMirrorLayer(id)                   LayerInfo | undefined
 *   useMirrorLayers(ids)                 (LayerInfo | undefined)[] — same array until one of them changes
 *   useMirrorComp(id)                    MirrorComp | undefined (settings, stack order, markers)
 *   useMirrorItems() / useMirrorItem(id) ItemInfo records
 *   useMirrorFootage(mediaType)          footage items holding stills / video / audio
 *   useMirrorTree(layer)                 MirrorTree | undefined — retains (loads) the layer's property tree (wakes on ANY property write)
 *   useMirrorTreeGroups(layer, roots)    the same tree, waking only for writes under the root groups + shape changes
 *   useMirrorTreeShape(layer)            the same tree, waking only for shape changes (which nodes exist)
 *   useMirrorProperty(layer, path)       PropertyInfo | undefined — retains the tree
 *   useMirrorKeyframes(layer, path)      readonly Keyframe[] (empty when not animated)
 *   useMirrorLayerKeyframes(layer)       path → keys for every animated property of a layer
 *   useMirrorValueAt(layer, path, t)     Value at comp time `t` (flicks) — static from the tree,
 *                                        animated from the value cache
 *   useMirrorHistory()                   undo/redo labels and position
 *   useMirrorProjectSettings()           ProjectSettings | null
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ItemInfo, Keyframe, LayerInfo, ProjectSettings, PropertyInfo, Value } from '@motion/engine-api';
// Registers the app's engine as the mirror's source (engineInstance.ts).
import '@core/engine/engineInstance';
import {
  documentMirror,
  type DocumentMirror,
  type MirrorComp,
  type MirrorHistory,
  type MirrorStatus,
  type MirrorTree,
} from '@stores/documentMirror';
import { trackRefIn } from '@core/mirror/trackIndex';
import { useProjectStore } from '@stores/projectStore';

export type { DocumentMirror, MirrorComp, MirrorHistory, MirrorStatus, MirrorTree };

/** The session's mirror (stable). Read it inside callbacks; subscribe with the hooks below. */
export function useMirror(): DocumentMirror {
  return documentMirror();
}

/**
 * The generic form: re-render when any of `keys` changes, returning `read()`.
 * `read` must return a stable value while nothing it reads changed (mirror
 * records are). `keys` is compared by content.
 */
export function useMirrorSelect<T>(keys: readonly string[], read: (m: DocumentMirror) => T): T {
  const m = documentMirror();
  const keyStr = keys.join('\u0001');
  const readRef = useRef(read);
  readRef.current = read;
  const subscribe = useMemo(
    () => (cb: () => void) => m.subscribe(keyStr === '' ? [] : keyStr.split('\u0001'), cb),
    [m, keyStr],
  );
  return useSyncExternalStore(subscribe, () => readRef.current(m), () => readRef.current(m));
}

/**
 * Re-render whenever any of `keys` changes; returns a counter that moves each
 * time. The replacement for the legacy `useNodeRevision`: read the mirror
 * synchronously in render, subscribe to exactly the keys you read.
 */
export function useMirrorKeys(keys: readonly string[]): number {
  const m = documentMirror();
  const keyStr = keys.join('\u0001');
  const ver = useRef(0);
  const subscribe = useMemo(
    () => (cb: () => void) => m.subscribe(keyStr === '' ? [] : keyStr.split('\u0001'), () => {
      ver.current += 1;
      cb();
    }),
    [m, keyStr],
  );
  return useSyncExternalStore(subscribe, () => ver.current, () => ver.current);
}

/**
 * The mirror keys a row reading `tracks` of `nodeIds` depends on: each
 * layer's header and tree SHAPE (`struct:` — the names resolve through it, and
 * it does not move on a value change), and each resolved property's info, keys
 * and value. A row must NOT wake on the layer's `tree:` key: that moves on
 * every property write of the layer, so every row of an Inspector would
 * re-render on each step of a drag of ONE of them.
 */
export function trackWatchKeys(m: DocumentMirror, nodeIds: readonly string[], tracks: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of nodeIds) {
    out.push(`layer:${id}`, `struct:${id}`);
    const tree = m.tree(id);
    for (const t of tracks) {
      const r = trackRefIn(tree, t);
      if (r) out.push(`prop:${id}|${r.path}`, `key:${id}|${r.path}`, `value:${id}|${r.path}`);
    }
  }
  return out;
}

/** Keep the selection's trees loaded and re-render when any of `tracks` changes on any of `nodeIds`. */
export function useMirrorTrackWatch(nodeIds: readonly string[], tracks: readonly string[]): number {
  const m = documentMirror();
  useRetainTrees(nodeIds);
  return useMirrorKeys(trackWatchKeys(m, nodeIds, tracks));
}

/** Re-render when any of `nodeIds`' headers, trees or keyframes change (whole-layer watch). */
export function useMirrorLayersWatch(nodeIds: readonly string[]): number {
  useRetainTrees(nodeIds);
  const keys: string[] = [];
  for (const id of nodeIds) keys.push(`layer:${id}`, `tree:${id}`, `keys:${id}`);
  return useMirrorKeys(keys);
}

/**
 * Keep the layers' trees loaded and re-render when any of their headers or
 * tree SHAPES change (a layer added / removed / renamed / switched, an effect
 * or mask added or removed) — but NOT on a property's value or keyframes,
 * except under the ROOT groups `roots` (see `useMirrorTreeGroups`). For a shell
 * that decides WHICH rows exist and draws none of their values.
 */
export function useMirrorLayersShapeWatch(nodeIds: readonly string[], roots: readonly string[] = []): number {
  useRetainTrees(nodeIds);
  const keys: string[] = [];
  for (const id of nodeIds) keys.push(`layer:${id}`, `struct:${id}`, ...roots.map((r) => `grp:${id}|${r}`));
  return useMirrorKeys(keys);
}

export function useMirrorStatus(): MirrorStatus {
  return useMirrorSelect(['status', 'doc'], (m) => m.status);
}

/**
 * The document revision — wakes on EVERY edit, a viewport drag step included
 * (one revision per pointer move). Almost always wrong for a panel that is
 * not a whole-document consumer: prefer the keys it reads, or
 * `useMirrorStructRevision` when it draws structure. `enabled = false` keeps a
 * component that only needs it while open (a palette, a dialog, a mode) from
 * waking — and re-rendering — while it is closed.
 */
export function useMirrorRevision(enabled = true): number {
  return useMirrorSelect(enabled ? ['doc'] : [], (m) => (enabled ? m.revision : 0));
}

/**
 * A counter that moves on every document change that is more than property
 * VALUES — layers, compositions, items, stack order, keyframes, a property
 * tree's shape, a reload — and stays put on a value write (a drag step, a
 * typed number). For panels that draw the document's structure (the layer
 * tree, the assets' usage). `enabled = false` as for `useMirrorRevision`.
 */
export function useMirrorStructRevision(enabled = true): number {
  return useMirrorSelect(enabled ? ['docStruct'] : [], (m) => (enabled ? m.structRevision : 0));
}

export function useMirrorLayer(id: string | null | undefined): LayerInfo | undefined {
  return useMirrorSelect(id ? [`layer:${id}`] : [], (m) => (id ? m.layer(id) : undefined));
}

export function useMirrorLayers(ids: readonly string[]): ReadonlyArray<LayerInfo | undefined> {
  const last = useRef<ReadonlyArray<LayerInfo | undefined>>([]);
  const keys = useMemo(() => ids.map((id) => `layer:${id}`), [ids]);
  return useMirrorSelect(keys, (m) => {
    const next = ids.map((id) => m.layer(id));
    const prev = last.current;
    if (prev.length === next.length && prev.every((x, i) => x === next[i])) return prev;
    last.current = next;
    return next;
  });
}

export function useMirrorComp(id: string | null | undefined): MirrorComp | undefined {
  return useMirrorSelect(id ? [`comp:${id}`] : ['comps'], (m) => (id ? m.comp(id) : undefined));
}

export function useMirrorComps(): ReadonlyMap<string, MirrorComp> {
  return useMirrorSelect(['comps'], (m) => m.comps);
}

/** The active tab's composition id (editor state: which comp the user is looking at). */
export function useActiveCompId(): string | undefined {
  return useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined)) ?? undefined;
}

/**
 * The active tab's composition id for a CALLBACK (the hook form is
 * `useActiveCompId`): the tab's composition when the document has it (a
 * composition, or a legacy nested precomp group), else the document's first
 * composition. The mirror twin of `activeCompRootId`.
 */
export function activeCompIdNow(): string | undefined {
  const s = useProjectStore.getState();
  const id = s.activeTabId ? s.tabs[s.activeTabId]?.compositionId : undefined;
  const m = documentMirror();
  if (id && (m.comp(id) || m.layer(id))) return id;
  return m.compIds[0];
}

/** The active composition's mirror record. */
export function useActiveMirrorComp(): MirrorComp | undefined {
  const id = useActiveCompId();
  const m = documentMirror();
  return useMirrorSelect(id ? [`comp:${id}`, 'comps'] : ['comps'], () => (id ? m.comp(id) : m.comp(m.compIds[0] ?? '')));
}

/** Frames per second of a composition's settings. */
export function compFps(comp: MirrorComp | undefined, fallback = 30): number {
  const r = comp?.settings?.frameRate;
  return r && r.num > 0 ? r.num / (r.den || 1) : fallback;
}

/** The active composition's frame rate. */
export function useActiveCompFps(fallback = 30): number {
  return compFps(useActiveMirrorComp(), fallback);
}

export function useMirrorItems(): ReadonlyMap<string, ItemInfo> {
  return useMirrorSelect(['items'], (m) => m.items);
}

/**
 * The footage items whose file holds `mediaType` (`ItemInfo.mediaType`), in project order — the pickers that
 * offer "a still image" (a sky, a sprite, a height map, a plugin's image param). Same array until the items change.
 */
export function useMirrorFootage(mediaType: ItemInfo['mediaType']): readonly ItemInfo[] {
  const items = useMirrorItems();
  return useMemo(() => [...items.values()].filter((i) => i.kind === 'footage' && i.mediaType === mediaType), [items, mediaType]);
}

export function useMirrorItem(id: string | null | undefined): ItemInfo | undefined {
  return useMirrorSelect(id ? [`item:${id}`] : [], (m) => (id ? m.item(id) : undefined));
}

/** Keep `layer`'s property tree loaded while the component is mounted. */
export function useRetainTree(layer: string | null | undefined): void {
  const m = documentMirror();
  useEffect(() => (layer ? m.retainTree(layer) : undefined), [m, layer]);
}

/** Keep several layers' trees loaded (the multi-selection Inspector). */
export function useRetainTrees(layers: readonly string[]): void {
  const m = documentMirror();
  const key = layers.join('\u0001');
  useEffect(() => {
    const releases = key === '' ? [] : key.split('\u0001').map((l) => m.retainTree(l));
    return () => { for (const r of releases) r(); };
  }, [m, key]);
}

/**
 * The layer's whole property tree — re-renders on ANY property change of the
 * layer (a drag step of its Position included). Use it only for a component
 * that reads across the tree; one that reads a few groups takes
 * `useMirrorTreeGroups`, one that reads only its shape `useMirrorTreeShape`.
 */
export function useMirrorTree(layer: string | null | undefined): MirrorTree | undefined {
  useRetainTree(layer);
  return useMirrorSelect(layer ? [`tree:${layer}`, `layer:${layer}`] : [], (m) => (layer ? m.tree(layer) : undefined));
}

/**
 * The layer's property tree for a component that reads only what is under the
 * ROOT groups `roots` (a path's first segment: `transform`, `layer`, `effects`,
 * `styles`, `contents` …) plus the tree's SHAPE (which nodes exist, their types,
 * names, limits, children). Re-renders on the layer's header, a shape change,
 * or any write under one of `roots` — NOT on a write elsewhere in the layer's
 * tree, so a drag of Position leaves an Effects / Styles / Appearance reader alone.
 * The caller owns the claim: a value read from a group not listed here would go stale.
 */
export function useMirrorTreeGroups(layer: string | null | undefined, roots: readonly string[]): MirrorTree | undefined {
  useRetainTree(layer);
  useMirrorKeys(layer ? [`layer:${layer}`, `struct:${layer}`, ...roots.map((r) => `grp:${layer}|${r}`)] : []);
  return layer ? documentMirror().tree(layer) : undefined;
}

/** `useMirrorTreeGroups` with no group: the tree for a component that reads only its shape (`nodes.has`, types, names, children). */
export function useMirrorTreeShape(layer: string | null | undefined): MirrorTree | undefined {
  return useMirrorTreeGroups(layer, []);
}

export function useMirrorProperty(layer: string | null | undefined, path: string | null | undefined): PropertyInfo | undefined {
  useRetainTree(layer);
  return useMirrorSelect(
    layer && path ? [`prop:${layer}|${path}`, `struct:${layer}`] : [],
    (m) => (layer && path ? m.property(layer, path) : undefined),
  );
}

export function useMirrorKeyframes(layer: string | null | undefined, path: string | null | undefined): readonly Keyframe[] {
  return useMirrorSelect(
    layer && path ? [`key:${layer}|${path}`] : [],
    (m) => (layer && path ? m.keyframes(layer, path) : EMPTY),
  );
}

export function useMirrorLayerKeyframes(layer: string | null | undefined): ReadonlyMap<string, readonly Keyframe[]> {
  return useMirrorSelect(layer ? [`keys:${layer}`] : [], (m) => (layer ? m.layerKeyframes(layer) : EMPTY_MAP));
}

/**
 * The value of `path` on `layer` at comp time `time` (flicks). Pass the
 * THROTTLED display time (`useThrottledTime`), never the raw clock.
 */
export function useMirrorValueAt(layer: string | null | undefined, path: string | null | undefined, time: number): Value | undefined {
  useRetainTree(layer);
  return useMirrorSelect(
    layer && path ? [`value:${layer}|${path}`, `prop:${layer}|${path}`, `struct:${layer}`, 'doc'] : [],
    (m) => (layer && path ? m.valueAt(layer, path, time) : undefined),
  );
}

export function useMirrorHistory(): MirrorHistory | null {
  return useMirrorSelect(['history'], (m) => m.history);
}

export function useMirrorProjectSettings(): ProjectSettings | null {
  return useMirrorSelect(['settings'], (m) => m.settings);
}

const EMPTY: readonly Keyframe[] = Object.freeze([]) as readonly Keyframe[];
const EMPTY_MAP: ReadonlyMap<string, readonly Keyframe[]> = new Map();
