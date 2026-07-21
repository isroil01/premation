/**
 * Component thumbnails — render a saved component's node tree into a small
 * offscreen canvas through the unified GPU engine (same pipeline as the
 * viewport, so the preview matches what inserting it produces) and cache the
 * dataURL per definition.
 *
 * GPU init is async, so `componentThumb` is a sync cache lookup that KICKS OFF
 * the render on a miss and returns null; subscribe via `onComponentThumbReady`
 * to repaint when the dataURL lands. (The old code forced the Null backend,
 * which produces no pixels — thumbnails were permanently blank.)
 */

import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot } from './buildSnapshot';
import { createRenderBackend } from './createRenderBackend';
import type { ComponentDef } from '@stores/componentStore';
import type { SceneNode, ID } from '@core/types';

const THUMB_W = 96;
const THUMB_H = 64;

const cache = new Map<string, string>();

interface SerializedNodeLike {
  name: string;
  transform: SceneNode['transform'];
  components: SceneNode['components'];
  children: SerializedNodeLike[];
}

let seq = 0;

/** Materialize the serialized tree into `graph` (fresh throwaway ids),
 *  shifting every node by (dx, dy) so the content sits inside the thumb
 *  comp's 0-based coordinate space. */
function addTree(graph: SceneGraph, def: SerializedNodeLike, parentId: string | null, dx: number, dy: number): void {
  const id = `thumb_${(seq += 1)}` as ID;
  const transform = JSON.parse(JSON.stringify(def.transform)) as SceneNode['transform'];
  transform.position.x += dx;
  transform.position.y += dy;
  const node: SceneNode = {
    id,
    name: def.name,
    parent: parentId as ID | null,
    children: [],
    transform,
    visible: true,
    locked: false,
    components: def.components.map((c, i) => {
      const props = { ...(c.props as Record<string, unknown>) };
      if (c.type === 'Transform') {
        if (typeof props.x === 'number') props.x = props.x + dx;
        if (typeof props.y === 'number') props.y = props.y + dy;
      }
      return { id: `${id}_c${i}`, type: c.type, props };
    }),
  };
  if (parentId) graph.addChild(parentId as ID, node);
  else graph.addNode(node);
  // Children keep positions relative to the root in this model — only the
  // ROOT gets the shift; descendants inherit it through their parent chain?
  // No: this scene model stores absolute Transform props per node, so shift
  // every level identically.
  for (const child of def.children) addTree(graph, child, id, dx, dy);
}

/** Rough content bounds from the tree's Transform props. */
function treeBounds(def: SerializedNodeLike): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (d: SerializedNodeLike): void => {
    const t = d.components.find((c) => c.type === 'Transform');
    const p = (t?.props ?? {}) as Record<string, unknown>;
    const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
    const x = num(p.x, d.transform.position.x);
    const y = num(p.y, d.transform.position.y);
    const w = num(p.width, 120);
    const h = num(p.height, 120);
    minX = Math.min(minX, x - w / 2);
    minY = Math.min(minY, y - h / 2);
    maxX = Math.max(maxX, x + w / 2);
    maxY = Math.max(maxY, y + h / 2);
    for (const c of d.children) walk(c);
  };
  walk(def);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 200, maxY: 150 };
  return { minX, minY, maxX, maxY };
}

const listeners = new Set<() => void>();
const pending = new Set<string>();

/** Subscribe to "a thumbnail just became available" — repaint your grid. */
export function onComponentThumbReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function renderThumbAsync(def: ComponentDef, key: string): Promise<void> {
  try {
    const b = treeBounds(def.root as unknown as SerializedNodeLike);
    const pad = 12;
    const w = Math.max(1, b.maxX - b.minX + pad * 2);
    const h = Math.max(1, b.maxY - b.minY + pad * 2);
    // Shift the tree so its bounds start at (pad, pad) INSIDE the comp box —
    // the comp coordinate space is 0-based, and content in negative space
    // renders outside it.
    const graph = new SceneGraph();
    addTree(graph, def.root as unknown as SerializedNodeLike, null, pad - b.minX, pad - b.minY);
    const scale = Math.min(THUMB_W / w, THUMB_H / h);
    const canvas = document.createElement('canvas');
    const backend = createRenderBackend();
    backend.attach(canvas);
    backend.setPreviewChrome?.(false);
    backend.resize(THUMB_W, THUMB_H, 1);
    if (backend.readyPromise) await backend.readyPromise;
    const snapshot = buildSnapshot(
      graph,
      new AnimationEngine(),
      0,
      undefined,
      undefined,
      {
        scale,
        offsetX: (THUMB_W - w * scale) / 2,
        offsetY: (THUMB_H - h * scale) / 2,
      },
      undefined,
      { width: w, height: h, background: 'rgba(0,0,0,0)' },
    );
    backend.renderFrame(snapshot);
    // Converge async media (image fills etc.) exactly like renderOffline does.
    for (let pass = 0; pass < 4; pass++) {
      const waits = backend.takeMediaWaits?.();
      if (!waits || waits.length === 0) break;
      await Promise.all(waits);
      backend.renderFrame(snapshot);
    }
    // Read through a 2D scratch canvas — robust for WebGL (no
    // preserveDrawingBuffer dependency) and WebGPU alike.
    const scratch = document.createElement('canvas');
    scratch.width = THUMB_W;
    scratch.height = THUMB_H;
    const ctx = scratch.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(canvas, 0, 0);
    const url = scratch.toDataURL('image/png');
    backend.dispose();
    cache.set(key, url);
    listeners.forEach((fn) => fn());
  } catch {
    // Rendering unavailable (tests without canvas/GPU) — leave uncached so the
    // caller keeps its icon fallback.
  }
}

/**
 * The component's thumbnail as a dataURL — cached hit, or null while the GPU
 * render is in flight (or unavailable, e.g. in tests without canvas). A miss
 * schedules the render; listen via `onComponentThumbReady` for completion.
 */
export function componentThumb(def: ComponentDef): string | null {
  const key = `${def.id}:${def.createdAt}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!pending.has(key)) {
    pending.add(key);
    void renderThumbAsync(def, key).finally(() => pending.delete(key));
  }
  return null;
}

/** Drop a component's cached thumbnail (call when it is re-saved). */
export function invalidateComponentThumb(defId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${defId}:`)) cache.delete(key);
  }
}
