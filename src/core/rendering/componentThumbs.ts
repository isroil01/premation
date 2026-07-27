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

/**
 * Thumbnail renders run ONE AT A TIME.
 *
 * `componentThumb` is called during render for every card in the component grid,
 * and each cache miss used to fire an independent `renderThumbAsync` — each of
 * which creates a full GPU backend and holds that context across up to four
 * awaited media-convergence passes. With N saved components that is N live
 * WebGL2/WebGPU contexts at once. Chromium caps live contexts per page (~16) and
 * evicts the oldest to honour a new request — and the oldest is the VIEWPORT's.
 * That is the "GPU could not be initialized" / blank-preview-on-entry that only
 * appears sometimes: it depends on how many components you saved and whether the
 * thumb cache was warm.
 *
 * `templatePreview.ts` avoids the same trap by rendering gallery cards on
 * Canvas2D. Thumbnails need the real pipeline for fidelity, so they queue
 * instead — one context, reused sequentially, never competing with the viewport.
 */
let thumbQueue: Promise<void> = Promise.resolve();

function enqueueThumb(task: () => Promise<void>): Promise<void> {
  const run = thumbQueue.then(task, task);
  // Keep the chain alive regardless of individual failures.
  thumbQueue = run.catch(() => undefined);
  return run;
}

/** Subscribe to "a thumbnail just became available" — repaint your grid. */
export function onComponentThumbReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The ONE auxiliary backend every thumbnail draws through, plus its canvas.
 *
 * The queue above already guaranteed only one was ALIVE at a time, but each
 * thumbnail still built a fresh backend and disposed it — so N components meant
 * N sequential engine initialisations. That was merely wasteful on WebGL2;
 * with WebGPU as the primary tier it means N × (requestAdapter → requestDevice
 * → configure) plus N cold shader/pipeline caches, all of which are per-device.
 *
 * Held for the session instead, exactly like the viewport's. Cleared on failure
 * so a lost context self-heals on the next thumbnail rather than poisoning the
 * whole grid.
 */
let sharedBackend: ReturnType<typeof createRenderBackend> | null = null;
let sharedCanvas: HTMLCanvasElement | null = null;

function releaseSharedBackend(): void {
  try {
    sharedBackend?.dispose();
  } catch {
    /* disposing a already-lost context is best-effort */
  }
  sharedBackend = null;
  sharedCanvas = null;
}

async function acquireSharedBackend(): Promise<ReturnType<typeof createRenderBackend>> {
  if (sharedBackend && sharedCanvas) return sharedBackend;
  const backend = createRenderBackend('auto', 'auxiliary');
  const canvas = document.createElement('canvas');
  backend.attach(canvas);
  backend.setPreviewChrome?.(false);
  backend.resize(THUMB_W, THUMB_H, 1);
  if (backend.readyPromise) await backend.readyPromise;
  sharedBackend = backend;
  sharedCanvas = canvas;
  return backend;
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
    const backend = await acquireSharedBackend();
    const canvas = sharedCanvas!;
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
    cache.set(key, url);
    listeners.forEach((fn) => fn());
  } catch {
    // Rendering unavailable (tests without canvas/GPU) — leave uncached so the
    // caller keeps its icon fallback. Drop the shared backend too: a lost
    // context would otherwise fail every remaining thumbnail in the grid, where
    // before (create-per-thumb) each attempt got a clean engine.
    releaseSharedBackend();
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
    void enqueueThumb(() => renderThumbAsync(def, key)).finally(() => pending.delete(key));
  }
  return null;
}

/** Drop a component's cached thumbnail (call when it is re-saved). */
export function invalidateComponentThumb(defId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${defId}:`)) cache.delete(key);
  }
}
