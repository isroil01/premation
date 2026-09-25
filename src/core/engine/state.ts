/**
 * The local engine's inverse machinery — "parts".
 *
 * The document is addressed as a set of PARTS, each a plain immutable value
 * under a string key:
 *
 *   node:<id>    the node's row exactly as a save writes it (undefined = absent)
 *   anim:<id>    the node's keyframe tracks, expressions and data tracks
 *   clips:<comp> that composition's clip-bar geometry, per node
 *   tl:<comp>    that composition's timeline facts: rate, duration, work area,
 *                composition markers and every bar's layer markers
 *   comp:<id>    the composition's settings record
 *   order        the engine's node insertion order (= saved node order, comp order)
 *   items        footage records + folders (asset store)
 *   project      engine-API project settings
 *   rq           the render queue saved with the project
 *   mb           project motion-blur settings
 *   cm           project colour management (working space, bit depth)
 *   tx           the cut-transition records, comp id → records (B3z)
 *
 * A command handler declares the parts it may touch (its SCOPE); the engine
 * captures them before and after applying, and the changed ones ARE the
 * command's inverse and redo: undo writes the before values back, redo the
 * after values, in a fixed dependency order (`applyParts`). Recorded at apply
 * time, so undo never re-derives anything, and ids come back exactly.
 *
 * Commands whose footprint is not known up front (precompose, split, delete a
 * subtree…) use DOCUMENT scope: every part. Tests run with `verifyScopes`, which
 * also diffs the whole document and fails a command that changed a part
 * outside its declared scope — the guard that keeps scoped inverses honest.
 */

import { defaultAnimation, type NodeAnimSnapshot } from '@motion/animation';
import { Clip, Marker, type MarkerData } from '@motion/timeline';
import { captureNodeRow, captureSharedState, jsonEqual } from '@core/commands/snapshotSharing';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { ClipGeometry } from '@core/commands/snapshotSharing';
import { useProjectStore, type CompositionSettings } from '@stores/projectStore';
import { useAssetStore, replaceProjectItems, type ImportedAsset, type AssetFolder } from '@stores/assetStore';
import { useMotionBlurStore, type MotionBlurSettings } from '@stores/motionBlurStore';
import { useColorManagementStore, type ColorManagementSettings } from '@stores/colorManagementStore';
import { bumpScene } from '@stores/sceneStore';
import { useTransitionStore } from '@stores/transitionStore';
import { useGuidesStore, type GuidesSettings } from '@stores/guidesStore';
import { useSwatchStore } from '@stores/swatchStore';
import { useMaterialStore } from '@stores/materialStore';
import type { TransitionRecord } from '@core/timeline/transitionModel';
import { getEventBus } from '@core/events/EventBus';
import {
  getProjectSettings,
  setProjectSettingsState,
  getRenderQueue,
  setRenderQueueState,
} from '@core/project/documentExtras';
import type { SceneNode } from '@core/types';
import { graph } from './doc';

export type Parts = Map<string, unknown>;

export interface Scope {
  document: boolean;
  keys: Set<string>;
}

export function newScope(): Scope {
  return { document: false, keys: new Set() };
}

export function documentScope(): Scope {
  return { document: true, keys: new Set() };
}

/** Timeline facts of one composition (`tl:<comp>`). */
export interface TimelinePart {
  duration: number;
  fps: number;
  /** Work area, loop and preview ranges (the loop follows the work area). */
  ranges: { loop: { start: number; duration: number } | null; preview: { start: number; duration: number } | null; workArea: { start: number; duration: number } | null };
  markers: MarkerData[];
  /** bar id → that bar's layer markers. */
  layerMarkers: Record<string, MarkerData[]>;
  /** The track's bar order (persisted in the document; restored exactly). */
  barOrder: string[];
}

export interface ItemsPart {
  assets: ImportedAsset[];
  folders: AssetFolder[];
}

// ── Scope helpers ────────────────────────────────────────────────────

export const K = {
  node: (id: string) => `node:${id}`,
  anim: (id: string) => `anim:${id}`,
  clips: (comp: string) => `clips:${comp}`,
  tl: (comp: string) => `tl:${comp}`,
  comp: (id: string) => `comp:${id}`,
  order: 'order',
  items: 'items',
  project: 'project',
  rq: 'rq',
  mb: 'mb',
  cm: 'cm',
  /** B3z: the cut-transition records (transitionStore), comp id → records. */
  tx: 'tx',
  guides: 'guides',
  swatches: 'swatches',
  materials: 'materials',
} as const;

/** A layer's node + animation. */
export function scopeLayer(s: Scope, id: string): Scope {
  s.keys.add(K.node(id));
  s.keys.add(K.anim(id));
  return s;
}

/** A layer and every descendant (node + animation). */
export function scopeSubtree(s: Scope, id: string): Scope {
  scopeLayer(s, id);
  for (const c of graph.getChildOrder(id)) scopeSubtree(s, c);
  return s;
}

/** A composition's timeline side: clip geometry + timeline facts. */
export function scopeTimeline(s: Scope, comp: string): Scope {
  s.keys.add(K.clips(comp));
  s.keys.add(K.tl(comp));
  return s;
}

// ── Capture ──────────────────────────────────────────────────────────

function captureTimeline(comp: string): TimelinePart | undefined {
  const reg = getTimelineController().peekTimeline(comp);
  if (!reg) return undefined;
  const { timeline, trackId } = reg;
  const r = timeline.getRanges();
  const layerMarkers: Record<string, MarkerData[]> = {};
  const barOrder: string[] = [];
  for (const layer of timeline.getTrack(trackId)?.layers ?? []) {
    barOrder.push(layer.id);
    const list = layer.markers.toJSON();
    if (list.length > 0) layerMarkers[layer.id] = list;
  }
  return {
    duration: timeline.duration,
    fps: timeline.getFrameRate().fps,
    ranges: {
      loop: r.loop ? { start: r.loop.start, duration: r.loop.duration } : null,
      preview: r.preview ? { start: r.preview.start, duration: r.preview.duration } : null,
      workArea: r.workArea ? { start: r.workArea.start, duration: r.workArea.duration } : null,
    },
    markers: timeline.markers.toJSON(),
    layerMarkers,
    barOrder,
  };
}

function captureClips(comp: string, all?: Record<string, Record<string, ClipGeometry[]>>): Record<string, ClipGeometry[]> | undefined {
  const src = all ?? getTimelineController().captureClipGeometry();
  return src[comp];
}

function captureOne(key: string, clipsCache: { v?: Record<string, Record<string, ClipGeometry[]>> }): unknown {
  const colon = key.indexOf(':');
  const kind = colon < 0 ? key : key.slice(0, colon);
  const id = colon < 0 ? '' : key.slice(colon + 1);
  switch (kind) {
    case 'node': return captureNodeRow(id);
    case 'anim': return defaultAnimation.snapshotNode(id) ?? undefined;
    case 'clips':
      clipsCache.v ??= getTimelineController().captureClipGeometry();
      return captureClips(id, clipsCache.v);
    case 'tl': return captureTimeline(id);
    case 'comp': {
      const c = useProjectStore.getState().comps[id];
      return c ? structuredClone(c) : undefined;
    }
    case 'order': return graph.getNodeOrder();
    case 'items': {
      const s = useAssetStore.getState();
      return { assets: structuredClone(s.assets), folders: structuredClone(s.folders) } satisfies ItemsPart;
    }
    case 'project': return { settings: getProjectSettings() };
    case 'rq': return getRenderQueue();
    case 'mb': return structuredClone(useMotionBlurStore.getState().settings());
    case 'cm': return structuredClone(useColorManagementStore.getState().settings());
    case 'tx': return useTransitionStore.getState().capture();
    case 'guides': return useGuidesStore.getState().settings();
    case 'swatches': return useSwatchStore.getState().list();
    case 'materials': return useMaterialStore.getState().list();
    default: throw new Error(`unknown part key '${key}'`);
  }
}

/** Every part key the document has right now. */
export function allPartKeys(): string[] {
  const keys: string[] = [];
  for (const id of graph.getNodeOrder()) keys.push(K.node(id));
  const snap = defaultAnimation.snapshot();
  const animIds = new Set<string>([
    ...Object.keys(snap.tracks),
    ...Object.keys(snap.expressions ?? {}),
    ...Object.keys(snap.data ?? {}),
  ]);
  for (const id of animIds) keys.push(K.anim(id));
  const comps = new Set<string>([...Object.keys(useProjectStore.getState().comps), ...getTimelineController().registeredCompIds()]);
  for (const c of comps) {
    keys.push(K.comp(c), K.clips(c), K.tl(c));
  }
  keys.push(K.order, K.items, K.project, K.rq, K.mb, K.cm, K.tx, K.guides, K.swatches, K.materials);
  return keys;
}

/**
 * Capture `scope`. Document scope enumerates every key and captures the scene
 * and animation through the structurally shared snapshot (unchanged nodes and
 * tracks are the SAME objects as the previous capture, so the diff is cheap).
 */
export function captureScope(scope: Scope): Parts {
  const out: Parts = new Map();
  const clipsCache: { v?: Record<string, Record<string, ClipGeometry[]>> } = {};
  if (scope.document) {
    const shared = captureSharedState();
    const rows = new Map<string, SceneNode>();
    for (const n of shared.scene.nodes) rows.set(n.id, n);
    for (const key of allPartKeys()) {
      if (key.startsWith('node:')) out.set(key, rows.get(key.slice(5)));
      else if (key.startsWith('anim:')) out.set(key, animOfShared(shared.anim, key.slice(5)));
      else out.set(key, captureOne(key, clipsCache));
    }
    for (const key of scope.keys) if (!out.has(key)) out.set(key, captureOne(key, clipsCache));
    return out;
  }
  for (const key of scope.keys) out.set(key, captureOne(key, clipsCache));
  return out;
}

function animOfShared(anim: ReturnType<typeof defaultAnimation.snapshot>, id: string): NodeAnimSnapshot | undefined {
  const tracks: NodeAnimSnapshot['tracks'] = {};
  const expressions: NodeAnimSnapshot['expressions'] = {};
  const data: NodeAnimSnapshot['data'] = {};
  let any = false;
  for (const [prop, t] of Object.entries(anim.tracks[id] ?? {})) { tracks[prop] = t.keyframes; any = true; }
  for (const [prop, e] of Object.entries(anim.expressions?.[id] ?? {})) { expressions[prop] = e; any = true; }
  for (const [prop, t] of Object.entries(anim.data?.[id] ?? {})) { data[prop] = t; any = true; }
  return any ? { tracks, expressions, data } : undefined;
}

/** Keys whose values differ between two captures (a key missing from one side reads as absent). */
export function changedKeys(before: Parts, after: Parts): string[] {
  const keys = new Set<string>([...before.keys(), ...after.keys()]);
  const out: string[] = [];
  for (const k of keys) {
    const a = before.get(k);
    const b = after.get(k);
    if (a === b) continue;
    let equal: boolean;
    try {
      equal = jsonEqual(a, b);
    } catch {
      equal = false;
    }
    if (!equal) out.push(k);
  }
  return out;
}

// ── Apply (restore) ──────────────────────────────────────────────────

/**
 * Make the document match `parts`, in dependency order:
 * comps → nodes (create/update, then remove) → order → animation →
 * timeline facts → clip geometry → layer markers → items/project/queue/blur.
 * Everything here writes silently (no engine-timeline history, no app
 * history); the caller owns the one entry and the events.
 */
export function applyParts(parts: Parts): void {
  const byKind = new Map<string, Array<[string, unknown]>>();
  for (const [key, value] of parts) {
    const colon = key.indexOf(':');
    const kind = colon < 0 ? key : key.slice(0, colon);
    const id = colon < 0 ? '' : key.slice(colon + 1);
    const list = byKind.get(kind) ?? [];
    list.push([id, value]);
    byKind.set(kind, list);
  }
  const controller = getTimelineController();

  // 1. composition records
  const compEntries = byKind.get('comp') ?? [];
  if (compEntries.length > 0) {
    const comps: Record<string, CompositionSettings> = { ...useProjectStore.getState().comps };
    for (const [id, v] of compEntries) {
      if (v === undefined) delete comps[id];
      else comps[id] = structuredClone(v as CompositionSettings);
    }
    useProjectStore.getState().actions.replaceComps(comps);
  }

  // 2. nodes: write every present row, then drop the absent ones
  const nodeEntries = byKind.get('node') ?? [];
  const order = parts.get(K.order) as string[] | undefined;
  for (const [id, v] of nodeEntries) {
    if (v === undefined) continue;
    const idx = order ? order.indexOf(id) : -1;
    graph.restoreNodeRow(v as SceneNode, idx >= 0 ? idx : undefined);
  }
  for (const [id, v] of nodeEntries) {
    if (v === undefined && graph.getNode(id)) graph.removeNodeOnly(id);
  }
  if (order) graph.setNodeOrder(order);

  // 3. animation
  const animEntries = byKind.get('anim') ?? [];
  if (animEntries.length > 0) {
    defaultAnimation.batch(() => {
      for (const [id, v] of animEntries) defaultAnimation.restoreNode(id, (v as NodeAnimSnapshot | undefined) ?? null);
    });
  }

  if (nodeEntries.length > 0) controller.invalidateLayerIndex();

  // 4. timeline facts (rate/duration/work area/comp markers) before bars
  const tlEntries = byKind.get('tl') ?? [];
  for (const [comp, v] of tlEntries) {
    if (v === undefined) {
      // The timeline did not exist in the restored state (a comp created, then undone).
      controller.dropTimeline(comp);
      continue;
    }
    const part = v as TimelinePart;
    const reg = controller.timelineForComp(comp);
    if (!reg) continue;
    const { timeline } = reg;
    timeline.history.silently(() => {
      if (timeline.getFrameRate().fps !== part.fps) timeline.setFrameRate(part.fps);
      if (timeline.duration !== part.duration) timeline.setDuration(part.duration);
      timeline.setRange('workArea', part.ranges.workArea ? { ...part.ranges.workArea } : null);
      timeline.setRange('loop', part.ranges.loop ? { ...part.ranges.loop } : null);
      timeline.setRange('preview', part.ranges.preview ? { ...part.ranges.preview } : null);
      timeline.markers.clear();
      for (const m of part.markers) timeline.markers.add(Marker.fromJSON({ ...m }));
    });
  }

  // 5. clip geometry (reconciles bar membership against the restored scene)
  const clipEntries = byKind.get('clips') ?? [];
  {
    const clips: Record<string, Record<string, ClipGeometry[]>> = {};
    for (const [comp, v] of clipEntries) if (v !== undefined) clips[comp] = structuredClone(v as Record<string, ClipGeometry[]>);
    controller.applyClipGeometry(clips);
    controller.invalidateLayerIndex();
  }

  // 6. layer markers (bars exist now)
  for (const [comp, v] of tlEntries) {
    if (v === undefined) continue;
    const part = v as TimelinePart;
    const reg = controller.peekTimeline(comp);
    const track = reg?.timeline.getTrack(reg.trackId);
    if (!reg || !track) continue;
    reg.timeline.history.silently(() => {
      for (const layer of track.layers) {
        layer.markers.clear();
        for (const m of part.layerMarkers[layer.id] ?? []) layer.markers.add(Marker.fromJSON({ ...m }));
      }
    });
    const rank = new Map(part.barOrder.map((id, i) => [id, i]));
    track.layers.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    controller.invalidateLayerIndex();
  }

  // 7. project-level parts
  const items = parts.get(K.items) as ItemsPart | undefined;
  if (parts.has(K.items) && items) replaceProjectItems(items);
  const project = parts.get(K.project) as { settings: ReturnType<typeof getProjectSettings> } | undefined;
  if (project) setProjectSettingsState(project.settings);
  if (parts.has(K.rq)) setRenderQueueState((parts.get(K.rq) as ReturnType<typeof getRenderQueue>) ?? []);
  const mb = parts.get(K.mb) as MotionBlurSettings | undefined;
  if (mb) useMotionBlurStore.getState().restore(structuredClone(mb));
  if (parts.has(K.tx)) useTransitionStore.getState().restore((parts.get(K.tx) as Record<string, TransitionRecord[]> | undefined) ?? {});
  const cm = parts.get(K.cm) as ColorManagementSettings | undefined;
  if (cm) useColorManagementStore.getState().restore(structuredClone(cm));
  if (parts.has(K.guides)) useGuidesStore.getState().restore(structuredClone(parts.get(K.guides) as GuidesSettings));
  if (parts.has(K.swatches)) useSwatchStore.getState().restore(structuredClone(parts.get(K.swatches)));
  if (parts.has(K.materials)) useMaterialStore.getState().restore(structuredClone(parts.get(K.materials)));

  bumpScene();
  getEventBus().emit('DocumentChanged', { source: 'composition' });
}

/** Re-exported for handlers that write bars directly. */
export { Clip };
