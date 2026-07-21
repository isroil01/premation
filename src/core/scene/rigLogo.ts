/**
 * Rig Logo for Animation — turn a whole multi-part logo (a group / precomp /
 * multi-selection of shapes) into ONE riggable piece with a starter puppet rig.
 *
 * WHY this exists: puppet/bone rigging only works on a SINGLE leaf image or
 * shape layer, whose warp mesh comes from its bitmap alpha or path silhouette.
 * A group/precomp has no composited texture to warp (the renderer flattens
 * precomps at draw time), so it can't be rigged directly. The pragmatic
 * AE-style fix is to rasterize the logo to one image layer, then rig THAT — the
 * image-alpha mesh path already works end to end.
 *
 * Decision:
 *   - Exactly one riggable LEAF (image or shape) selected → rig it in place
 *     (no rasterize; it keeps its live vector / bitmap).
 *   - Anything else (a group, a precomp, multiple layers, …) → rasterize the
 *     selection's rendered pixels to a PNG at native resolution, insert it as a
 *     single image layer at the original bounds, and rig that.
 *
 * The GPU rasterize is factored behind an injectable `rasterize` seam (mirroring
 * componentThumbs' provider pattern) so the decision logic is unit-testable
 * without a GPU/canvas.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SIZE } from '@core/rendering/buildSnapshot';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore, type Tool } from '@stores/uiStore';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { insertMedia, setNodeWorldPosition } from '@core/scene/sceneInsert';
import { bumpScene } from '@stores/sceneStore';
import type { SceneNode } from '@core/types';
import type { SceneKind } from '@core/scene/seedDefaultScene';

/**
 * Layer kinds that can carry a puppet / bone rig directly: a rig's warp mesh
 * needs a bitmap alpha or a path silhouette, which only these kinds provide.
 * Groups / precomps / nulls / cameras / lights have no such surface.
 */
export const RIGGABLE_KINDS: ReadonlySet<SceneKind> = new Set(['shape', 'image', 'text']);

/** Whether a scene kind can be rigged directly (see RIGGABLE_KINDS). */
export function isRiggableKind(kind: SceneKind): boolean {
  return RIGGABLE_KINDS.has(kind);
}

/**
 * A single selected layer is directly riggable in the toolbar sense when it is
 * a riggable kind. (Multi-selection / groups route through Rig Logo instead.)
 */
export function isRiggableLeafNode(node: SceneNode | undefined, graph: SceneGraph = defaultSceneGraph): boolean {
  if (!node) return false;
  const kind = readNodeKind(node);
  // Image/shape are the true leaves; a shape may nest booleans but rigging its
  // own silhouette is still valid. Text rigs its glyph mask.
  if (!isRiggableKind(kind)) return false;
  // Groups masquerade as no kind → readNodeKind returns 'group', already
  // excluded above, so no extra child check is needed here.
  void graph;
  return true;
}

/** Selected ids whose parent is NOT also selected — the top-level roots. */
export function topLevelSelected(selectedIds: readonly string[], graph: SceneGraph = defaultSceneGraph): string[] {
  const set = new Set(selectedIds);
  return selectedIds.filter((id) => {
    const n = graph.getNode(id);
    let p = n?.parent ?? null;
    while (p) {
      if (set.has(p)) return false;
      p = graph.getNode(p)?.parent ?? null;
    }
    return true;
  });
}

export type RigDecision =
  | { mode: 'self'; targetId: string }
  | { mode: 'rasterize'; roots: string[] };

/**
 * Decide whether the current selection can be rigged in place (single image or
 * shape leaf) or must be rasterized to a single image first.
 */
export function resolveRigTarget(selectedIds: readonly string[], graph: SceneGraph = defaultSceneGraph): RigDecision | null {
  const roots = topLevelSelected(selectedIds, graph);
  if (roots.length === 0) return null;
  if (roots.length === 1) {
    const node = graph.getNode(roots[0]!);
    if (node) {
      const kind = readNodeKind(node);
      const isLeaf = graph.getChildren(node.id).length === 0;
      // Only a true single leaf image/shape rigs in place with no quality loss.
      if ((kind === 'image' || kind === 'shape') && isLeaf) {
        return { mode: 'self', targetId: node.id };
      }
    }
  }
  return { mode: 'rasterize', roots };
}

// ── Local geometry helpers ─────────────────────────────────────────

interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number; }

/** Comp-space box of ONE node from its Transform props (center-based). */
function nodeBox(node: SceneNode): Box | null {
  let x: number | undefined, y: number | undefined;
  let width: number | undefined, height: number | undefined;
  let scaleX: number | undefined, scaleY: number | undefined, scale: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number') x = p.x;
    if (typeof p.y === 'number') y = p.y;
    if (typeof p.width === 'number') width = p.width;
    if (typeof p.height === 'number') height = p.height;
    if (typeof p.scaleX === 'number') scaleX = p.scaleX;
    if (typeof p.scaleY === 'number') scaleY = p.scaleY;
    if (typeof p.scale === 'number') scale = p.scale;
  }
  const kind = readNodeKind(node);
  // Groups / nulls / cameras / lights / audio don't draw — skip; their drawable
  // descendants contribute to the union instead.
  if (kind === 'group' || kind === 'null' || kind === 'camera' || kind === 'light' || kind === 'audio' || kind === 'adjustment') {
    return null;
  }
  const fallback = (SIZE as Record<string, { w: number; h: number } | undefined>)[kind];
  const sx = Math.abs(scaleX ?? scale ?? 1);
  const sy = Math.abs(scaleY ?? scale ?? 1);
  const w = (width ?? fallback?.w ?? 100) * sx;
  const h = (height ?? fallback?.h ?? 100) * sy;
  const cx = x ?? node.transform.position.x;
  const cy = y ?? node.transform.position.y;
  return { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
}

/** Union comp-space bounds of every drawable descendant of `roots`. */
function selectionBounds(roots: readonly string[], graph: SceneGraph): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (id: string): void => {
    const n = graph.getNode(id);
    if (!n) return;
    const box = nodeBox(n);
    if (box) {
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
    for (const child of graph.getChildren(id)) walk(child.id);
  };
  for (const r of roots) walk(r);
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** Unscaled local width/height of a node (for placing rig pins in layer space). */
function localSize(node: SceneNode): { w: number; h: number } {
  let width: number | undefined, height: number | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.width === 'number') width = p.width;
    if (typeof p.height === 'number') height = p.height;
  }
  const fallback = (SIZE as Record<string, { w: number; h: number } | undefined>)[readNodeKind(node)];
  return { w: width ?? fallback?.w ?? 100, h: height ?? fallback?.h ?? 100 };
}

/**
 * A minimal, deterministic starter rig in layer-local coordinates centered on
 * the origin: an anchor pin at bottom-center and a "wave" mover pin at
 * top-center, so the user can immediately drag to wave the logo and add more.
 * Pin ids follow the codebase's existing `pin_<ts>_<i>` author-time convention
 * (see toolHandlers.createPuppetRig).
 */
export function starterPuppetPins(w: number, h: number): { pins: Array<{ id: string; name: string; x: number; y: number }> } {
  const now = Date.now();
  void w; // pins sit on the vertical center line; width is accepted for symmetry
  const halfH = Math.max(1, h / 2);
  return {
    pins: [
      { id: `pin_${now}_0`, name: 'Anchor', x: 0, y: halfH },
      { id: `pin_${now}_1`, name: 'Wave', x: 0, y: -halfH },
    ],
  };
}

// ── GPU rasterize seam ─────────────────────────────────────────────

export interface RasterResult {
  /** PNG data URL at native (device) resolution. */
  dataUrl: string;
  /** Comp-space size the inserted image layer should occupy. */
  compWidth: number;
  compHeight: number;
  /** Comp-space center where the logo sat. */
  centerX: number;
  centerY: number;
  /** Suggested asset/layer name. */
  name: string;
}

let rlSeq = 0;

/** Materialize a real-graph subtree into `dst` with fresh ids, shifted by (dx,dy). */
function materialize(dst: SceneGraph, src: SceneGraph, srcId: string, parentId: string | null, dx: number, dy: number): void {
  const node = src.getNode(srcId);
  if (!node) return;
  const id = `riglogo_${(rlSeq += 1)}`;
  const transform = JSON.parse(JSON.stringify(node.transform)) as SceneNode['transform'];
  transform.position.x += dx;
  transform.position.y += dy;
  const components = node.components.map((c, i) => {
    const props = { ...(c.props as Record<string, unknown>) };
    // Transform props store ABSOLUTE comp coords in this scene model, so every
    // level shifts identically (matches componentThumbs' addTree).
    if (typeof props.x === 'number') props.x = props.x + dx;
    if (typeof props.y === 'number') props.y = props.y + dy;
    return { id: `${id}_c${i}`, type: c.type, props };
  });
  const fresh: SceneNode = {
    id,
    name: node.name,
    parent: parentId,
    children: [],
    transform,
    visible: node.visible !== false,
    locked: false,
    components,
  };
  if (parentId) dst.addChild(parentId, fresh);
  else dst.addNode(fresh);
  for (const child of src.getChildren(srcId)) materialize(dst, src, child.id, id, dx, dy);
}

const MAX_RASTER_DIM = 2048;

/**
 * Default rasterize implementation: render the selection's subtree through the
 * real GPU engine (same pipeline as the viewport, so the pixels match) at the
 * logo's native resolution, tight to its world bounds, transparent background.
 * Returns null when there is nothing renderable or no canvas/GPU (tests).
 */
export async function rasterizeSelection(roots: readonly string[], graph: SceneGraph = defaultSceneGraph): Promise<RasterResult | null> {
  const bounds = selectionBounds(roots, graph);
  if (!bounds) return null;
  const pad = 4; // tiny margin so strokes / AA aren't clipped
  const w = Math.max(1, bounds.maxX - bounds.minX + pad * 2);
  const h = Math.max(1, bounds.maxY - bounds.minY + pad * 2);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  try {
    // Lazy-load the render engine so this module (and its pure helpers) stays
    // importable in environments without a GPU/canvas.
    const { buildSnapshot } = await import('@core/rendering/buildSnapshot');
    const { createRenderBackend } = await import('@core/rendering/createRenderBackend');
    const { AnimationEngine } = await import('@motion/animation');

    const scene = new SceneGraph();
    for (const r of roots) materialize(scene, graph, r, null, pad - bounds.minX, pad - bounds.minY);

    const dpr0 = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const dpr = Math.min(dpr0, MAX_RASTER_DIM / Math.max(w, h));

    const canvas = document.createElement('canvas');
    const backend = createRenderBackend();
    backend.attach(canvas);
    backend.setPreviewChrome?.(false);
    backend.resize(w, h, dpr);
    if (backend.readyPromise) await backend.readyPromise;

    const snapshot = buildSnapshot(
      scene,
      new AnimationEngine(),
      0,
      undefined,
      undefined,
      { scale: 1, offsetX: 0, offsetY: 0 },
      undefined,
      { width: w, height: h, background: 'rgba(0,0,0,0)', transparent: true },
    );
    backend.renderFrame(snapshot);
    // Converge async media (image fills, video frames) like renderOffline does.
    for (let pass = 0; pass < 4; pass++) {
      const waits = backend.takeMediaWaits?.();
      if (!waits || waits.length === 0) break;
      await Promise.all(waits);
      backend.renderFrame(snapshot);
    }

    const scratch = document.createElement('canvas');
    scratch.width = Math.max(1, Math.round(w * dpr));
    scratch.height = Math.max(1, Math.round(h * dpr));
    const ctx = scratch.getContext('2d');
    if (!ctx) {
      backend.dispose();
      return null;
    }
    ctx.drawImage(canvas, 0, 0);
    const dataUrl = scratch.toDataURL('image/png');
    backend.dispose();

    const first = graph.getNode(roots[0]!);
    const baseName = (first?.name ?? 'Logo').replace(/\s*\(Rigged\)\s*$/i, '');
    return { dataUrl, compWidth: w, compHeight: h, centerX, centerY, name: `${baseName} (Rigged)` };
  } catch {
    return null;
  }
}

// ── Orchestrator ───────────────────────────────────────────────────

export interface RigLogoDeps {
  graph?: SceneGraph;
  getSelection?: () => readonly string[];
  setSelection?: (ids: readonly string[]) => void;
  setActiveTool?: (tool: Tool) => void;
  notify?: (n: { level: 'info' | 'success' | 'warning' | 'error'; message: string; durationMs: number }) => void;
  rasterize?: (roots: readonly string[], graph: SceneGraph) => Promise<RasterResult | null>;
  addAsset?: (file: File) => Promise<ImportedAsset>;
  insertMedia?: (asset: ImportedAsset) => Promise<void>;
  /** Optional PNG dataURL → File converter (overridable in tests). */
  toFile?: (dataUrl: string, name: string) => Promise<File>;
}

async function dataUrlToFile(dataUrl: string, name: string): Promise<File> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return new File([blob], name, { type: 'image/png' });
}

/**
 * Set a node's Transform width/height and (comp-space) center, so the inserted
 * image sits exactly where the logo was at its comp size (independent of the
 * PNG's device pixel resolution).
 */
function placeAndSize(nodeId: string, graph: SceneGraph, w: number, h: number): void {
  const node = graph.getNode(nodeId);
  if (!node) return;
  const t = node.components.find((c) => c.type === 'Transform');
  if (t) {
    graph.writeProp(nodeId, t.id, 'width', w);
    graph.writeProp(nodeId, t.id, 'height', h);
  }
}

/**
 * Turnkey "Rig Logo for Animation". Async because the rasterize path awaits the
 * GPU. Never throws — the no-selection / undecoded-media cases notify and bail.
 */
export async function rigLogoForAnimation(deps: RigLogoDeps = {}): Promise<void> {
  const graph = deps.graph ?? defaultSceneGraph;
  const getSelection = deps.getSelection ?? (() => useSelectionStore.getState().ids);
  const setSelection = deps.setSelection ?? ((ids) => useSelectionStore.getState().set(ids));
  const setActiveTool = deps.setActiveTool ?? ((t: Tool) => useUIStore.getState().setActiveTool(t));
  const notify = deps.notify ?? ((n) => useUIStore.getState().notify(n));
  const rasterize = deps.rasterize ?? rasterizeSelection;
  const addAsset = deps.addAsset ?? ((f: File) => useAssetStore.getState().addAsset(f));
  const doInsertMedia = deps.insertMedia ?? insertMedia;
  const toFile = deps.toFile ?? dataUrlToFile;

  const selection = Array.from(getSelection());
  const decision = resolveRigTarget(selection, graph);
  if (!decision) {
    notify({ level: 'warning', message: 'Select a layer, group, or logo to rig first.', durationMs: 3000 });
    return;
  }

  const rigTarget = (targetId: string): void => {
    const node = graph.getNode(targetId);
    if (!node) return;
    const { w, h } = localSize(node);
    graph.setPuppet(targetId, starterPuppetPins(w, h));
    setSelection([targetId]);
    setActiveTool('puppet-pin');
    bumpScene();
    notify({ level: 'success', message: 'Logo ready to rig — drag pins to animate.', durationMs: 3200 });
  };

  if (decision.mode === 'self') {
    rigTarget(decision.targetId);
    return;
  }

  // Rasterize path — flatten the logo to one image layer, then rig it.
  const raster = await rasterize(decision.roots, graph);
  if (!raster) {
    notify({
      level: 'error',
      message: 'Could not rasterize the selection (media may still be loading). Try again in a moment.',
      durationMs: 4000,
    });
    return;
  }

  try {
    const file = await toFile(raster.dataUrl, `${raster.name}.png`);
    const asset = await addAsset(file);
    await doInsertMedia(asset);
    // insertMedia selects the new node.
    const newId = Array.from(getSelection())[0];
    if (!newId) {
      notify({ level: 'error', message: 'Rasterized the logo but could not find the new layer.', durationMs: 4000 });
      return;
    }
    placeAndSize(newId, graph, raster.compWidth, raster.compHeight);
    setNodeWorldPosition(newId, raster.centerX, raster.centerY);
    rigTarget(newId);
  } catch {
    notify({ level: 'error', message: 'Failed to build the rigged logo layer.', durationMs: 4000 });
  }
}
