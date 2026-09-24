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
 * keyframe. Each command is one undo step.
 *
 * HOW IT IS WRITTEN (B3). Every outline — a mask's `masks/<id>/path`, a drawn
 * shape layer's own `layer/path.points` — goes through the engine API
 * (`pathEdits.ts`), one `edit` per verb: Set First Vertex / Reverse Path
 * Direction / Closed are `editPathTopology` (the engine replays them on every
 * state), RotoBezier is the outline's switch (`masks/<id>/rotoBezier`,
 * `layer/pathRotoBezier`) plus every state's computed handles, a key at the
 * playhead is `addKeyframes` / `setProperty {time}`. Split handles and
 * RotoBezier tensions travel in the path value (`vertexStates`). Convert Mask
 * to Shape Layer is one `pasteLayers` of the Pen's drawn-layer payloads built
 * off-document (`insertDrawnLayers`). An outline the API does not address — a
 * node outside a composition — is left out of the verb.
 */

import {
  DirectSelectionTool,
  Mat,
  commands,
  outlinesOfNode,
  rotoBezierPoints,
  type BezierPoint,
  type Outline,
  type ToolContext,
  type CreateNodePayload,
} from '@motion/workspace';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { asCommandId } from '@app-types/common';
import type { Command } from '@core/commands/Command';
import type { Command as EngineCommand } from '@motion/engine-api';
import { getTimelineController } from '@core/timeline/TimelineController';
import { readNodeMask } from '@core/effects/mask';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import type { ID } from '@core/types';
import { getWorkspaceController } from './WorkspaceController';
import { createSceneGraphPort, insertDrawnLayers } from './ports';
import {
  everyStateCommands,
  maskKeyAtCommands,
  outlineOnEngine,
  pasteCommands,
  rotoBezierCommand,
  sendPathEdit,
  shapeKeyAtCommand,
  topologyCommand,
  type MaskOutlineAt,
  type OutlinePoint,
  type OutlineStateEdit,
  type OutlineTarget,
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

const targetOf = (t: PathTarget): OutlineTarget => ({ nodeId: t.outline.nodeId as string, maskId: t.outline.maskId });

/** The targets the engine API addresses (a node outside a composition is left out). */
function engineTargets(targets: ReadonlyArray<PathTarget>): PathTarget[] {
  return targets.filter((t) => outlineOnEngine(targetOf(t)));
}

/** A per-state points edit and the closed state after it. */
type StateFn = (points: OutlinePoint[], closed: boolean) => OutlinePoint[] | null;

/** Send the verb's commands as ONE entry, then redraw. */
function sendVerb(label: string, cmds: Promise<EngineCommand[] | null> | EngineCommand[]): void {
  void Promise.resolve(cmds)
    .then((list) => sendPathEdit(label, list))
    .then(() => getWorkspaceController().requestRender());
}

function noTargetsHint(): void {
  notify('Select a path or mask first (Direct Selection, or a layer with a path)', 'warning');
}

// ── The verbs ────────────────────────────────────────────────────────

/** Layer ▸ Mask and Shape Path ▸ Closed — toggles, taking its lead from the first target. */
export function toggleClosed(): boolean {
  const targets = engineTargets(resolvePathTargets());
  if (targets.length === 0) {
    noTargetsHint();
    return false;
  }
  const closed = !targets[0]!.outline.closed;
  // A RotoBezier outline's end handles depend on Closed: every state's handles
  // are recomputed with it; any other outline only flips the switch.
  const roto = targets.filter((t) => t.outline.rotoBezier);
  const plain = targets.filter((t) => !t.outline.rotoBezier);
  const rotoFn: StateFn = (pts, c) => rotoBezierPoints(pts, c);
  const edits: OutlineStateEdit[] = roto.map((t) => ({ ...targetOf(t), closed, fn: rotoFn }));
  sendVerb('Closed', (async () => {
    const recomputed = edits.length > 0 ? await everyStateCommands('Closed', edits) : [];
    if (!recomputed) return null;
    return [...plain.map((t) => topologyCommand(targetOf(t), undefined, closed)), ...recomputed];
  })());
  return true;
}

/** Set First Vertex — needs exactly one selected vertex on an outline. */
export function setFirstVertexCommand(): boolean {
  const picked = engineTargets(resolvePathTargets().filter((t) => t.indices.length === 1));
  if (picked.length === 0) {
    notify('Select one vertex with the Direct Selection tool to make it the first vertex', 'warning');
    return false;
  }
  // An open outline can only start at one of its two ends.
  const targets = picked.filter((t) => {
    const i = t.indices[0]!;
    return t.outline.closed || i === 0 || i === t.outline.points.length - 1;
  });
  if (targets.length === 0) {
    notify('An open path can only start at one of its ends', 'warning');
    return false;
  }
  sendVerb('Set First Vertex', targets.map((t) => topologyCommand(targetOf(t), {
    kind: 'firstVertex', segment: 0, u: 0, indices: [t.indices[0]!], atStart: false,
  })));
  // The selection indexed the old order.
  directSelection()?.clearVertexSelection();
  return true;
}

/** Reverse Path Direction. */
export function reversePathCommand(): boolean {
  const targets = engineTargets(resolvePathTargets());
  if (targets.length === 0) {
    noTargetsHint();
    return false;
  }
  sendVerb('Reverse Path Direction', targets.map((t) => topologyCommand(targetOf(t), {
    kind: 'reverse', segment: 0, u: 0, indices: [], atStart: false,
  })));
  directSelection()?.clearVertexSelection();
  return true;
}

/**
 * RotoBezier — on computes every state's handles from its vertices; off keeps
 * the handles it last computed (AE: turning it off leaves the curve alone).
 * The switch is the outline's (`masks/<id>/rotoBezier`, `layer/pathRotoBezier`).
 */
export function toggleRotoBezier(): boolean {
  const targets = engineTargets(resolvePathTargets());
  if (targets.length === 0) {
    noTargetsHint();
    return false;
  }
  const on = !targets[0]!.outline.rotoBezier;
  const switches = targets.map((t) => rotoBezierCommand(targetOf(t), on));
  const fn: StateFn = (pts, closed) => rotoBezierPoints(pts, closed);
  sendVerb('RotoBezier', (async () => {
    if (!on) return switches;
    const handles = await everyStateCommands('RotoBezier', targets.map((t) => ({ ...targetOf(t), closed: t.outline.closed, fn })));
    return handles ? [...switches, ...handles] : null;
  })());
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
 * Alt+Shift+M — a Mask Path / Path keyframe at the playhead holding the
 * current shape (AE). A shape layer's Path keys its whole outline (starting
 * its `path.points` track if it had none); a layer's masks are keyed together
 * (one snapshot per key), each with the shape the viewport draws there.
 */
export function keyframePathAtPlayhead(): boolean {
  const targets = engineTargets(resolvePathTargets());
  if (targets.length === 0) {
    notify('Select a path or mask to keyframe', 'warning');
    return false;
  }
  const now = getTimelineController().currentSeconds;
  const scene = outlineContext().scene;
  const cmds: EngineCommand[] = [];
  const maskedLayers = new Set<string>();
  for (const t of targets) {
    const nodeId = t.outline.nodeId as string;
    if (t.outline.maskId === null) {
      cmds.push(shapeKeyAtCommand(nodeId, t.outline.points, t.outline.closed, now));
      continue;
    }
    if (maskedLayers.has(nodeId)) continue;
    maskedLayers.add(nodeId);
    const node = scene.getNode(nodeId);
    const masks: MaskOutlineAt[] = (node ? outlinesOfNode(node) : [])
      .filter((o) => o.maskId !== null)
      .map((o) => ({ maskId: o.maskId!, points: o.points, closed: o.closed }));
    cmds.push(...maskKeyAtCommands(nodeId, masks, now));
  }
  sendVerb('Set Path Keyframe', cmds);
  return true;
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
 * stored values, as in AE. On an animated target it keys the playhead; the
 * pasted Closed holds in every state. One entry.
 */
export function pastePathEdit(): boolean {
  if (!pathClipboard || useUIStore.getState().activeTool !== 'direct-select') return false;
  const targets = engineTargets(resolvePathTargets());
  if (targets.length === 0) return false;
  const clip = pathClipboard;
  sendVerb('Paste Path', pasteCommands('Paste Path', targets.map(targetOf), clip.points, clip.closed, getTimelineController().currentSeconds));
  directSelection()?.clearVertexSelection();
  return true;
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
