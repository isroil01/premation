/**
 * Layer ▸ Mask and Shape Path — the path-level verbs, plus the path clipboard
 * and Convert Mask to Shape Layer.
 *
 * WHICH PATH. AE acts on the selected Mask Path / Path property. The editor's
 * nearest equivalent is, in order:
 *   1. the outlines holding selected VERTICES in the Direct Selection tool —
 *      the explicit choice, and the only one Set First Vertex can use;
 *   2. otherwise each selected layer's own path, or, for a layer without one
 *      (a solid, footage, text), all of its masks.
 *
 * WHERE THE EDIT LANDS. Closed, RotoBezier, Set First Vertex and Reverse Path
 * Direction are STRUCTURAL: an outline cannot be closed at one keyframe and
 * open at the next, and a vertex order that differs between keyframes makes
 * them morph through each other. So all four edit the static outline AND every
 * keyframe, the way `editMaskPathTopology` adds a vertex. Each command is one
 * undo step.
 *
 * HOW IT IS WRITTEN (B3). A MASK outline goes through the engine API
 * (`pathEdits.ts`: `masks/<id>/path` — its static value, every keyframe's
 * value, a key at the playhead), one `edit` per verb. Convert Mask to Shape
 * Layer is one `pasteLayers` of the Pen's drawn-layer payloads built
 * off-document (`insertDrawnLayers`).
 *
 * B3-legacy: engine gap — what the API cannot address yet stays on
 * `runDocumentEdit`, decided per verb so one action is one undo entry:
 *   - a shape layer's own outline: the catalog has no path-valued property for
 *     it (`path.points` is bound as a SCALAR `layer/path.points`, with no
 *     static value), and Closed / RotoBezier (`Geometry.open`, `rotoBezier`)
 *     have no property at all;
 *   - a mask's RotoBezier switch (a mask-level flag no property carries);
 *   - per-vertex `broken` / `tension` editing state (BezierPath drops it, so
 *     a write through the API would re-join split handles).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import {
  DirectSelectionTool,
  Mat,
  applyPathTopology,
  commands,
  outlinesOfNode,
  reversePath,
  rotoBezierPoints,
  type BezierPoint,
  type Outline,
  type OutlineId,
  type PathTopologyEdit,
  type ToolContext,
  type CreateNodePayload,
} from '@motion/workspace';
import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { compToKeyframeTime, getTimelineController } from '@core/timeline/TimelineController';
import {
  keyframeMask,
  readNodeMask,
  readNodeMaskAnim,
  setMaskPathFlags,
  setMaskPoints,
  type MaskPoint,
} from '@core/effects/mask';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { ID } from '@core/types';
import { getWorkspaceController } from './WorkspaceController';
import { createSceneGraphPort, insertDrawnLayers } from './ports';
import { hasVertexEditState } from './toolEdits';
import {
  maskEveryStateCommands,
  maskKeyAtCommands,
  maskPasteCommands,
  maskPathOnEngine,
  sendPathEdit,
  type MaskOutlineAt,
  type MaskStateEdit,
} from './pathEdits';

/** The animation path of a shape layer's whole-path track (AE's Path property). */
export const PATH_ANIM_PROP = 'path.points';

function notify(message: string, level: 'success' | 'warning' | 'info' = 'info'): void {
  useUIStore.getState().notify({ level, message, durationMs: 2600 });
}

/** A tool context with just what outline resolution reads. */
function outlineContext(): ToolContext {
  return {
    scene: createSceneGraphPort(),
    selectionIds: () => useSelectionStore.getState().ids,
  } as unknown as ToolContext;
}

/** The Direct Selection tool instance the viewport drives. */
function directSelection(): DirectSelectionTool | null {
  const tool = getWorkspaceController().ws.tools.get('direct-select');
  return tool instanceof DirectSelectionTool ? tool : null;
}

export interface PathTarget {
  outline: Outline;
  /** Selected vertex indices (empty when the outline was chosen by layer). */
  indices: number[];
}

/** The paths a Mask and Shape Path command acts on — see the file comment. */
export function resolvePathTargets(): PathTarget[] {
  const ctx = outlineContext();
  const ds = directSelection();
  const fromVertices = ds?.selectedVertexOutlines(ctx) ?? [];
  if (fromVertices.length > 0) return fromVertices;
  const out: PathTarget[] = [];
  for (const id of ctx.selectionIds()) {
    const node = ctx.scene.getNode(id);
    if (!node) continue;
    const outlines = outlinesOfNode(node);
    const own = outlines.find((o) => o.maskId === null);
    for (const o of own ? [own] : outlines) out.push({ outline: o, indices: [] });
  }
  return out;
}

const toBezier = (v: unknown): BezierPoint[] | null =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === 'object' && v[0] !== null && 'x' in (v[0] as object)
    ? (v as Array<Partial<BezierPoint> & { x: number; y: number }>).map((p) => ({
        ...p, x: p.x, y: p.y, inX: p.inX ?? p.x, inY: p.inY ?? p.y, outX: p.outX ?? p.x, outY: p.outY ?? p.y,
      }))
    : null;

/**
 * B3-legacy: engine gap (see the file comment) — apply `fn` to an outline in
 * EVERY state (static + each keyframe) and set its switches, on the scene
 * graph and animation directly. The caller wraps it in ONE `runDocumentEdit`.
 * `fn` gets each state's points and the outline's closed state AFTER the
 * flags, and returns the new points (null = leave that state).
 */
function editOutlineEverywhere(
  id: OutlineId,
  flags: { closed?: boolean; rotoBezier?: boolean },
  fn?: (points: BezierPoint[], closed: boolean) => BezierPoint[] | null,
): void {
  const nodeId = id.nodeId as string;
  if (id.maskId !== null) {
    setMaskPathFlags(nodeId, id.maskId, flags, fn ? (pts, closed) => (fn(pts, closed) as MaskPoint[] | null) ?? pts : undefined);
    return;
  }
  const node = defaultSceneGraph.getNode(nodeId as ID);
  const geom = node?.components.find((c) => c.type === 'Geometry');
  if (!node || !geom) return;
  const closed = flags.closed ?? geom.props.open !== true;
  if (flags.closed !== undefined) defaultSceneGraph.writeProp(node.id, geom.id, 'open', flags.closed ? undefined : true);
  if (flags.rotoBezier !== undefined) defaultSceneGraph.writeProp(node.id, geom.id, 'rotoBezier', flags.rotoBezier ? true : undefined);
  if (!fn) return;
  const stat = toBezier(geom.props.points);
  const nextStatic = stat ? fn(stat, closed) : null;
  if (nextStatic) defaultSceneGraph.writeProp(node.id, geom.id, 'points', nextStatic);
  const track = defaultAnimation.getDataTrack(nodeId, PATH_ANIM_PROP);
  if (track) {
    defaultAnimation.setDataTrack(nodeId, PATH_ANIM_PROP, {
      ...track,
      keyframes: track.keyframes.map((k) => {
        const pts = toBezier(k.value);
        const next = pts ? fn(pts, closed) : null;
        return next ? { ...k, value: next } : k;
      }),
    });
  }
}

const topologyFn = (edit: PathTopologyEdit) => (points: BezierPoint[], closed: boolean): BezierPoint[] | null =>
  applyPathTopology(points, edit, closed);

/** A per-state points edit and the closed state after it. */
type StateFn = (points: BezierPoint[], closed: boolean) => BezierPoint[] | null;

/**
 * The engine route: every target is a mask outline the API can say
 * (`maskPathOnEngine`). Decided once per verb, so one action never splits
 * between the engine's history and the legacy recorder.
 */
function masksOnEngine(targets: ReadonlyArray<PathTarget>): boolean {
  return targets.every((t) => t.outline.maskId !== null && maskPathOnEngine(t.outline.nodeId as string, t.outline.maskId));
}

/** Each target as a mask state edit (only called when `masksOnEngine`). */
function maskStateEdits(targets: ReadonlyArray<PathTarget>, closedOf: (t: PathTarget) => boolean, fnOf: (t: PathTarget) => StateFn | undefined): MaskStateEdit[] {
  return targets.map((t) => {
    const fn = fnOf(t);
    return { nodeId: t.outline.nodeId as string, maskId: t.outline.maskId!, closed: closedOf(t), ...(fn ? { fn } : {}) };
  });
}

/** Send mask state edits as one entry, then redraw. */
function sendMaskStates(label: string, edits: MaskStateEdit[]): void {
  void maskEveryStateCommands(label, edits)
    .then((cmds) => sendPathEdit(label, cmds))
    .then(() => getWorkspaceController().requestRender());
}

function noTargetsHint(): void {
  notify('Select a path or mask first (Direct Selection, or a layer with a path)', 'warning');
}

/** B3-legacy: engine gap — run the legacy `edit` over the targets as one undo step. */
function legacyOnTargets(label: string, targets: PathTarget[], edit: (targets: PathTarget[]) => void): void {
  runDocumentEdit(label, () => edit(targets));
  getWorkspaceController().requestRender();
}

// ── The verbs ────────────────────────────────────────────────────────

/** Layer ▸ Mask and Shape Path ▸ Closed — toggles, taking its lead from the first target. */
export function toggleClosed(): boolean {
  const targets = resolvePathTargets();
  if (targets.length === 0) {
    noTargetsHint();
    return false;
  }
  const closed = !targets[0]!.outline.closed;
  const rotoFn = (t: PathTarget): StateFn | undefined => (t.outline.rotoBezier ? (pts, c) => rotoBezierPoints(pts, c) : undefined);
  if (masksOnEngine(targets)) {
    sendMaskStates('Closed', maskStateEdits(targets, () => closed, rotoFn));
    return true;
  }
  legacyOnTargets('Closed', targets, (ts) => {
    for (const t of ts) editOutlineEverywhere(t.outline, { closed }, rotoFn(t));
  });
  return true;
}

/** Set First Vertex — needs exactly one selected vertex on an outline. */
export function setFirstVertexCommand(): boolean {
  const targets = resolvePathTargets().filter((t) => t.indices.length === 1);
  if (targets.length === 0) {
    notify('Select one vertex with the Direct Selection tool to make it the first vertex', 'warning');
    return false;
  }
  const fnOf = (t: PathTarget): StateFn => topologyFn({ op: 'firstVertex', index: t.indices[0]! });
  if (masksOnEngine(targets)) {
    sendMaskStates('Set First Vertex', maskStateEdits(targets, (t) => t.outline.closed, fnOf));
  } else {
    legacyOnTargets('Set First Vertex', targets, (ts) => {
      for (const t of ts) editOutlineEverywhere(t.outline, {}, fnOf(t));
    });
  }
  // The selection indexed the old order.
  directSelection()?.clearVertexSelection();
  return true;
}

/** Reverse Path Direction. */
export function reversePathCommand(): boolean {
  const targets = resolvePathTargets();
  if (targets.length === 0) {
    noTargetsHint();
    return false;
  }
  const fn: StateFn = (pts) => reversePath(pts);
  if (masksOnEngine(targets)) {
    sendMaskStates('Reverse Path Direction', maskStateEdits(targets, (t) => t.outline.closed, () => fn));
  } else {
    legacyOnTargets('Reverse Path Direction', targets, (ts) => {
      for (const t of ts) editOutlineEverywhere(t.outline, {}, fn);
    });
  }
  directSelection()?.clearVertexSelection();
  return true;
}

/**
 * RotoBezier — on computes every state's handles from its vertices; off keeps
 * the handles it last computed (AE: turning it off leaves the curve alone).
 *
 * B3-legacy: engine gap — the switch itself (`Geometry.rotoBezier`, a mask's
 * `rotoBezier`) has no API property, for a shape path or a mask alike.
 */
export function toggleRotoBezier(): boolean {
  const targets = resolvePathTargets();
  if (targets.length === 0) {
    noTargetsHint();
    return false;
  }
  const on = !targets[0]!.outline.rotoBezier;
  legacyOnTargets('RotoBezier', targets, (ts) => {
    for (const t of ts) {
      editOutlineEverywhere(t.outline, { rotoBezier: on }, on ? (pts, closed) => rotoBezierPoints(pts, closed) : undefined);
    }
  });
  notify(on ? 'RotoBezier on — drag a vertex with Convert Vertex to set its tension' : 'RotoBezier off', 'info');
  return true;
}

/** Whether the first target is closed / RotoBezier — the menu's check marks. */
export function firstTargetFlags(): { closed: boolean; rotoBezier: boolean } | null {
  const t = resolvePathTargets()[0];
  return t ? { closed: t.outline.closed, rotoBezier: t.outline.rotoBezier } : null;
}

/**
 * Free Transform Points — switches to Direct Selection and opens the box
 * around the selected vertices, or around every vertex of the target outlines.
 */
export function freeTransformPoints(): boolean {
  const ctx = outlineContext();
  const ds = directSelection();
  if (!ds) return false;
  if (ds.selectedVertexOutlines(ctx).length === 0) {
    for (const t of resolvePathTargets()) ds.selectVertices(t.outline, t.outline.points.map((_, i) => i));
  }
  useUIStore.getState().setActiveTool('direct-select');
  const opened = ds.openFreeTransform(ctx);
  if (!opened) notify('Free Transform Points needs at least two vertices', 'warning');
  getWorkspaceController().requestRender();
  return opened;
}

/**
 * The masks to key per layer for Alt+Shift+M — every mask of each target's
 * layer (they are keyed together), with the shape the viewport draws at the
 * playhead — or null when a target is not a mask the API can key.
 */
function maskKeysByLayer(targets: ReadonlyArray<PathTarget>): Map<string, MaskOutlineAt[]> | null {
  if (!masksOnEngine(targets)) return null;
  const scene = outlineContext().scene;
  const out = new Map<string, MaskOutlineAt[]>();
  for (const t of targets) {
    const nodeId = t.outline.nodeId as string;
    if (out.has(nodeId)) continue;
    const node = scene.getNode(nodeId);
    const masks = node ? outlinesOfNode(node).filter((o) => o.maskId !== null) : [];
    if (masks.some((o) => !maskPathOnEngine(nodeId, o.maskId!))) return null;
    out.set(nodeId, masks.map((o) => ({ maskId: o.maskId!, points: o.points, closed: o.closed })));
  }
  return out;
}

/**
 * Alt+Shift+M — a Mask Path / Path keyframe at the playhead holding the
 * current shape (AE). A shape layer's path starts its `path.points` track here
 * if it had none; a mask keys its whole-mask snapshot.
 */
export function keyframePathAtPlayhead(): boolean {
  const targets = resolvePathTargets();
  if (targets.length === 0) {
    notify('Select a path or mask to keyframe', 'warning');
    return false;
  }
  const now = getTimelineController().currentSeconds;
  const byLayer = maskKeysByLayer(targets);
  if (byLayer) {
    void sendPathEdit('Set Path Keyframe', [...byLayer].flatMap(([nodeId, masks]) => maskKeyAtCommands(nodeId, masks, now)));
    return true;
  }
  // B3-legacy: engine gap — a shape layer's `path.points` has no path-valued
  // property, and a mask key through the API drops `broken` / `tension`.
  runDocumentEdit('Set Path Keyframe', () => {
    const maskedLayers = new Set<string>();
    for (const t of targets) {
      const nodeId = t.outline.nodeId as string;
      const time = compToKeyframeTime(nodeId, now);
      if (t.outline.maskId !== null) {
        if (maskedLayers.has(nodeId)) continue;
        maskedLayers.add(nodeId);
        keyframeMask(nodeId, time);
      } else {
        defaultAnimation.setDataKeyframe(nodeId, PATH_ANIM_PROP, 'points', time, t.outline.points.map((p) => ({ ...p })));
      }
    }
  });
  return true;
}

/**
 * The timeline Path row's stopwatch: start a `path.points` track from the
 * static outline, or — lit — end it, keeping the shape at the playhead as the
 * static path (AE leaves the value where the playhead is).
 *
 * B3-legacy: engine gap — a shape layer's Path has no path-valued property in
 * the catalog (`path.points` is bound as a scalar `layer/path.points`, whose
 * `setAnimated` would key a number), so its stopwatch stays on the legacy writer.
 */
export function togglePathAnimation(nodeId: string): void {
  const node = defaultSceneGraph.getNode(nodeId as ID);
  const geom = node?.components.find((c) => c.type === 'Geometry');
  if (!node || !geom || node.locked) return;
  const time = compToKeyframeTime(nodeId, getTimelineController().currentSeconds);
  if (defaultAnimation.isDataAnimated(nodeId, PATH_ANIM_PROP)) {
    runDocumentEdit('Disable path animation', () => {
      const live = toBezier(defaultAnimation.sampleData(nodeId, PATH_ANIM_PROP, time));
      if (live) defaultSceneGraph.writeProp(node.id, geom.id, 'points', live);
      defaultAnimation.setDataTrack(nodeId, PATH_ANIM_PROP, null);
    });
    return;
  }
  const pts = toBezier(geom.props.points);
  if (!pts) return;
  runDocumentEdit('Enable path animation', () => {
    defaultAnimation.setDataKeyframe(nodeId, PATH_ANIM_PROP, 'points', time, pts);
  });
}

// ── Path clipboard (mask ⇄ shape path) ───────────────────────────────

let pathClipboard: { points: BezierPoint[]; closed: boolean } | null = null;

/** Only an explicit vertex selection in Direct Selection copies a PATH instead of layers. */
function explicitPathTarget(): PathTarget | null {
  if (useUIStore.getState().activeTool !== 'direct-select') return null;
  const ds = directSelection();
  return ds?.selectedVertexOutlines(outlineContext())[0] ?? null;
}

/**
 * Edit ▸ Copy with path vertices selected: the outline (local points + closed)
 * goes on the path clipboard, as AE copies a Mask Path or a shape Path value.
 * Returns false when this is not a path copy (the caller copies as usual, and
 * the stale path clipboard is dropped so it cannot shadow that paste).
 */
export function copyPathFromSelection(): boolean {
  const t = explicitPathTarget();
  if (!t) {
    pathClipboard = null;
    return false;
  }
  pathClipboard = { points: t.outline.points.map((p) => ({ ...p })), closed: t.outline.closed };
  notify(`Copied ${t.outline.maskId === null ? 'path' : 'mask path'} (${t.outline.points.length} vertices)`, 'success');
  return true;
}

/**
 * Edit ▸ Paste onto a path: replaces the target outline's shape with the
 * copied one — a mask onto a shape's Path or the reverse. Coordinates paste as
 * stored values, as in AE. On an animated target it keys the playhead.
 */
export function pastePathOntoSelection(): boolean {
  if (!pathClipboard || useUIStore.getState().activeTool !== 'direct-select') return false;
  const targets = resolvePathTargets();
  if (targets.length === 0) return false;
  const clip = pathClipboard;
  const now = getTimelineController().currentSeconds;
  if (masksOnEngine(targets) && !hasVertexEditState(clip.points)) {
    const onto = targets.map((t) => ({ nodeId: t.outline.nodeId as string, maskId: t.outline.maskId! }));
    void maskPasteCommands('Paste Path', onto, clip.points, clip.closed, now)
      .then((cmds) => sendPathEdit('Paste Path', cmds))
      .then(() => getWorkspaceController().requestRender());
    directSelection()?.clearVertexSelection();
    return true;
  }
  // B3-legacy: engine gap — a shape layer's own outline, and split handles /
  // RotoBezier tension on the pasted or the target outline (see the file comment).
  runDocumentEdit('Paste Path', () => {
    for (const t of targets) {
      const nodeId = t.outline.nodeId as string;
      const time = compToKeyframeTime(nodeId, now);
      const pts = clip.points.map((p) => ({ ...p }));
      if (t.outline.maskId !== null) {
        setMaskPathFlags(nodeId, t.outline.maskId, { closed: clip.closed });
        setMaskPoints(nodeId, t.outline.maskId, pts as MaskPoint[], readNodeMaskAnimLength(nodeId) > 0 ? time : undefined);
      } else if (defaultAnimation.isDataAnimated(nodeId, PATH_ANIM_PROP)) {
        editOutlineEverywhere(t.outline, { closed: clip.closed });
        defaultAnimation.setDataKeyframe(nodeId, PATH_ANIM_PROP, 'points', time, pts);
      } else {
        editOutlineEverywhere(t.outline, { closed: clip.closed }, () => pts);
      }
    }
  });
  directSelection()?.clearVertexSelection();
  getWorkspaceController().requestRender();
  return true;
}

function readNodeMaskAnimLength(nodeId: string): number {
  const node = defaultSceneGraph.getNode(nodeId as ID);
  return node ? readNodeMaskAnim(node).length : 0;
}

/** Test seam. */
export function clearPathClipboard(): void {
  pathClipboard = null;
}

// ── Convert Mask to Shape Layer ──────────────────────────────────────

/**
 * Each mask of the selected layer becomes a shape layer drawing the same
 * outline in the same place — the layer transform is baked into the points
 * (a rotated layer's mask comes out as a rotated path on an unrotated layer).
 * The source layer keeps its masks; AE's equivalent (copy the Mask Path into a
 * new shape) leaves them too.
 *
 * ONE entry: the layers are the Pen's own drawn-layer payloads, built
 * off-document and inserted with one `pasteLayers` (`insertDrawnLayers`).
 * Resolves to the new layers' ids, which end up selected.
 */
export async function convertMasksToShapeLayers(): Promise<string[]> {
  const ids = useSelectionStore.getState().ids;
  const scene = createSceneGraphPort();
  const jobs: Array<{ world: BezierPoint[]; closed: boolean }> = [];
  for (const id of ids) {
    const node = scene.getNode(id);
    const raw = defaultSceneGraph.getNode(id as ID);
    if (!node || !raw || !readNodeMask(raw)) continue;
    for (const o of outlinesOfNode(node)) {
      if (o.maskId === null) continue;
      jobs.push({
        world: o.points.map((p) => {
          const v = Mat.apply(o.matrix, { x: p.x, y: p.y });
          const i = Mat.apply(o.matrix, { x: p.inX, y: p.inY });
          const q = Mat.apply(o.matrix, { x: p.outX, y: p.outY });
          return { x: v.x, y: v.y, inX: i.x, inY: i.y, outX: q.x, outY: q.y };
        }),
        closed: o.closed,
      });
    }
  }
  if (jobs.length === 0) {
    notify('Select a layer with masks to convert', 'warning');
    return [];
  }
  const label = jobs.length > 1 ? `Convert ${jobs.length} Masks to Shape Layers` : 'Convert Mask to Shape Layer';
  const payloads = jobs.map((job) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of job.world) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const local = job.world.map((p) => ({ x: p.x - cx, y: p.y - cy, inX: p.inX - cx, inY: p.inY - cy, outX: p.outX - cx, outY: p.outY - cy }));
    // The same payload the Pen commits, so the layer is exactly a drawn path.
    return commands.createNode('Path', { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, local, undefined, job.closed)
      .payload as CreateNodePayload;
  });
  const made = await insertDrawnLayers(label, payloads);
  if (!made || made.length === 0) return [];
  notify(`Created ${made.length} shape layer${made.length === 1 ? '' : 's'} from mask${made.length === 1 ? '' : 's'}`, 'success');
  return made;
}

// ── Commands ─────────────────────────────────────────────────────────

const hasLayerSelection = (): boolean => useSelectionStore.getState().ids.length > 0;

export function buildPathCommands(): ReadonlyArray<Command> {
  return [
    {
      id: asCommandId('path.toggleClosed'),
      label: 'Mask and Shape Path: Closed',
      icon: 'path',
      enabled: hasLayerSelection,
      isChecked: () => firstTargetFlags()?.closed === true,
      execute: () => { toggleClosed(); },
    },
    {
      id: asCommandId('path.setFirstVertex'),
      label: 'Mask and Shape Path: Set First Vertex',
      icon: 'path',
      enabled: hasLayerSelection,
      execute: () => { setFirstVertexCommand(); },
    },
    {
      id: asCommandId('path.reverse'),
      label: 'Mask and Shape Path: Reverse Path Direction',
      icon: 'path',
      enabled: hasLayerSelection,
      execute: () => { reversePathCommand(); },
    },
    {
      id: asCommandId('path.toggleRotoBezier'),
      label: 'Mask and Shape Path: RotoBezier',
      icon: 'curvature',
      enabled: hasLayerSelection,
      isChecked: () => firstTargetFlags()?.rotoBezier === true,
      execute: () => { toggleRotoBezier(); },
    },
    {
      // No registry chord: Ctrl+T is the Type tool's. The Direct Selection
      // tool claims Ctrl+T from the viewport while vertices are selected.
      id: asCommandId('path.freeTransformPoints'),
      label: 'Mask and Shape Path: Free Transform Points',
      icon: 'scale',
      enabled: hasLayerSelection,
      execute: () => { freeTransformPoints(); },
    },
    {
      id: asCommandId('path.keyframe'),
      label: 'Set Mask / Path Keyframe',
      icon: 'keyframe',
      shortcut: { key: 'm', alt: true, shift: true },
      enabled: hasLayerSelection,
      execute: () => { keyframePathAtPlayhead(); },
    },
    {
      id: asCommandId('path.convertMaskToShape'),
      label: 'Convert Mask to Shape Layer',
      icon: 'shape',
      enabled: hasLayerSelection,
      execute: () => { void convertMasksToShapeLayers(); },
    },
  ];
}
