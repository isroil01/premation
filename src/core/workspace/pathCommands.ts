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
 * undo step (`runDocumentEdit` snapshots scene and animation together).
 *
 * B3-legacy: engine gap — every verb here edits what the API cannot address
 * yet: a shape layer's own outline (`path.points` has no static value in the
 * TS engine; Closed / RotoBezier / a vertex order applied to EVERY key have
 * no command), a mask's RotoBezier switch, and per-vertex `broken` / `tension`
 * state (BezierPath drops it). They stay on `runDocumentEdit` until the
 * engine grows path topology commands.
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
import { createCommandPort, createSceneGraphPort } from './ports';

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
 * Apply `fn` to an outline in EVERY state (static + each keyframe) and set its
 * switches. `fn` gets each state's points and the outline's closed state
 * AFTER the flags, and returns the new points (null = leave that state).
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

/** Run `edit` over the targets as one undo step; false (and a hint) when there are none. */
function onTargets(label: string, edit: (targets: PathTarget[]) => void): boolean {
  const targets = resolvePathTargets();
  if (targets.length === 0) {
    notify('Select a path or mask first (Direct Selection, or a layer with a path)', 'warning');
    return false;
  }
  runDocumentEdit(label, () => edit(targets));
  getWorkspaceController().requestRender();
  return true;
}

// ── The verbs ────────────────────────────────────────────────────────

/** Layer ▸ Mask and Shape Path ▸ Closed — toggles, taking its lead from the first target. */
export function toggleClosed(): boolean {
  return onTargets('Closed', (targets) => {
    const closed = !targets[0]!.outline.closed;
    for (const t of targets) {
      editOutlineEverywhere(t.outline, { closed }, t.outline.rotoBezier ? (pts, c) => rotoBezierPoints(pts, c) : undefined);
    }
  });
}

/** Set First Vertex — needs exactly one selected vertex on an outline. */
export function setFirstVertexCommand(): boolean {
  const targets = resolvePathTargets().filter((t) => t.indices.length === 1);
  if (targets.length === 0) {
    notify('Select one vertex with the Direct Selection tool to make it the first vertex', 'warning');
    return false;
  }
  runDocumentEdit('Set First Vertex', () => {
    for (const t of targets) {
      editOutlineEverywhere(t.outline, {}, topologyFn({ op: 'firstVertex', index: t.indices[0]! }));
    }
  });
  // The selection indexed the old order.
  directSelection()?.clearVertexSelection();
  getWorkspaceController().requestRender();
  return true;
}

/** Reverse Path Direction. */
export function reversePathCommand(): boolean {
  const ok = onTargets('Reverse Path Direction', (targets) => {
    for (const t of targets) editOutlineEverywhere(t.outline, {}, (pts) => reversePath(pts));
  });
  if (ok) directSelection()?.clearVertexSelection();
  return ok;
}

/**
 * RotoBezier — on computes every state's handles from its vertices; off keeps
 * the handles it last computed (AE: turning it off leaves the curve alone).
 */
export function toggleRotoBezier(): boolean {
  let on = false;
  const ok = onTargets('RotoBezier', (targets) => {
    on = !targets[0]!.outline.rotoBezier;
    for (const t of targets) {
      editOutlineEverywhere(t.outline, { rotoBezier: on }, on ? (pts, closed) => rotoBezierPoints(pts, closed) : undefined);
    }
  });
  if (ok) notify(on ? 'RotoBezier on — drag a vertex with Convert Vertex to set its tension' : 'RotoBezier off', 'info');
  return ok;
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
 */
export function convertMasksToShapeLayers(): string[] {
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
  const port = createCommandPort();
  const made = runDocumentEdit(jobs.length > 1 ? `Convert ${jobs.length} Masks to Shape Layers` : 'Convert Mask to Shape Layer', () => {
    const out: string[] = [];
    for (const job of jobs) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of job.world) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const local = job.world.map((p) => ({ x: p.x - cx, y: p.y - cy, inX: p.inX - cx, inY: p.inY - cy, outX: p.outX - cx, outY: p.outY - cy }));
      // The same command the Pen commits, so the layer is exactly a drawn path.
      port.execute(commands.createNode('Path', { x: minX, y: minY, width: maxX - minX, height: maxY - minY }, local, undefined, job.closed));
      const created = useSelectionStore.getState().ids[0];
      if (created) out.push(created);
    }
    return out;
  });
  if (made.length > 0) useSelectionStore.getState().set(made);
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
      execute: () => { convertMasksToShapeLayers(); },
    },
  ];
}
