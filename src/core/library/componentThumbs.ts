/**
 * Component thumbnails — a saved component drawn by the ENGINE: its layers are
 * put under a throwaway composition sized to their bounds, handed over as a
 * preview document and drawn with `renderDocumentStill`
 * (core/engine/previewDocument.ts), so the thumbnail is the picture inserting
 * the component produces. The PNG is cached per definition as a data URL.
 *
 * The engine answers asynchronously, so `componentThumb` is a sync cache lookup
 * that KICKS OFF the still on a miss and returns null; subscribe via
 * `onComponentThumbReady` to repaint when it lands. A component the engine
 * cannot draw (no engine process in this harness, the renderer unavailable)
 * stays uncached and the caller keeps its icon.
 */

import type { ComponentDef } from '@stores/componentStore';
import type { SceneNode, ID } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';
import { previewDocumentOf, previewStill, type PreviewDocument } from '@core/engine/previewDocument';

/** Long side of the rendered thumbnail, in px (the grid shows it at 48 × 32 CSS px). */
const THUMB_SIZE = 192;
/** Transparent margin around the component's bounds, in composition px. */
const PAD = 12;

/**
 * Rendered thumbnails as PNG data URLs, in recency order (hits re-insert).
 *
 * Bounded. Keys include `createdAt`, so every re-save of a component minted a
 * new key and the previous data URL stayed for the rest of the session; a
 * library browsed for an afternoon only ever grew. The cap is well above a
 * grid's worth of cards, and an evicted card simply asks the engine again the
 * next time it is shown.
 */
const MAX_CACHED_THUMBS = 128;
const cache = new Map<string, string>();

function cacheThumb(key: string, url: string): void {
  cache.delete(key);
  cache.set(key, url);
  while (cache.size > MAX_CACHED_THUMBS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

interface SerializedNodeLike {
  name: string;
  transform: SceneNode['transform'];
  components: SceneNode['components'];
  children: SerializedNodeLike[];
}

/**
 * The component's top-level layers for the thumbnail, each with its children
 * nested: the legacy saved tree (`root`), or the rows of its `copyLayers`
 * fragment (B4 round 5: `{layers: [{row}]}`, each row a stored node with its
 * child ids) nested by parent. Empty when there is nothing to draw.
 */
function componentTrees(def: ComponentDef): SerializedNodeLike[] {
  if (def.root) return [def.root as unknown as SerializedNodeLike];
  if (!def.fragment) return [];
  type Row = { id: string; name?: string; parent?: string | null; children?: string[]; transform: SceneNode['transform']; components: SceneNode['components'] };
  let rows: Row[];
  try {
    const doc = JSON.parse(def.fragment.data) as { layers?: Array<{ row?: Row }> };
    rows = (doc.layers ?? []).map((l) => l.row).filter((r): r is Row => !!r && typeof r.id === 'string' && !!r.transform);
  } catch {
    return [];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const nest = (r: Row): SerializedNodeLike => ({
    name: r.name ?? r.id,
    transform: r.transform,
    components: r.components ?? [],
    children: (r.children ?? []).map((c) => byId.get(c)).filter((c): c is Row => !!c).map(nest),
  });
  return rows.filter((r) => !r.parent || !byId.has(r.parent)).map(nest);
}

/** 2D affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Affine = readonly [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

function multiply(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const num = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);

/** A node's own placement under its parent: position, rotation (degrees), scale. */
function localAffine(d: SerializedNodeLike): Affine {
  const p = (d.components.find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;
  const x = num(p.x, d.transform.position.x);
  const y = num(p.y, d.transform.position.y);
  const r = (num(p.rotation, d.transform.rotation ?? 0) * Math.PI) / 180;
  const sx = num(p.scaleX, d.transform.scale?.x ?? 1);
  const sy = num(p.scaleY, d.transform.scale?.y ?? 1);
  const cos = Math.cos(r), sin = Math.sin(r);
  return [cos * sx, sin * sx, -sin * sy, cos * sy, x, y];
}

function isGroup(d: SerializedNodeLike): boolean {
  return d.components.some((c) => (c.props as Record<string, unknown>)[SCENE_KIND_PROP] === 'group');
}

/**
 * Rough content bounds, in the space the top-level layers are placed in: each
 * layer's box (its Transform's width × height about its position; 120 × 120
 * when it states none, e.g. auto-sized text) carried through its parents'
 * transforms — a parented layer's transform is LOCAL to its parent. A group
 * has no box of its own. Rough: anchors and effects are not accounted for,
 * which is what the margin is for.
 */
function treeBounds(tops: ReadonlyArray<SerializedNodeLike>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (d: SerializedNodeLike, parent: Affine): void => {
    const m = multiply(parent, localAffine(d));
    if (!isGroup(d)) {
      const p = (d.components.find((c) => c.type === 'Transform')?.props ?? {}) as Record<string, unknown>;
      const hw = num(p.width, 120) / 2;
      const hh = num(p.height, 120) / 2;
      for (const [cx, cy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
        const x = m[0] * cx + m[2] * cy + m[4];
        const y = m[1] * cx + m[3] * cy + m[5];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    for (const c of d.children) walk(c, m);
  };
  for (const t of tops) walk(t, IDENTITY);
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 200, maxY: 150 };
  return { minX, minY, maxX, maxY };
}

const THUMB_ROOT = 'thumb_root';

/**
 * The serialized tree as document nodes under `parentId` (fresh ids). A
 * TOP-level layer is moved by (dx, dy) so the content sits inside the
 * thumbnail composition's 0-based coordinate space; its children follow it
 * (their transforms are local to it) and are copied as they are.
 */
function treeNodes(def: SerializedNodeLike, parentId: ID, dx: number, dy: number, out: SceneNode[], seq: { n: number }): ID {
  const id = `thumb_${(seq.n += 1)}` as ID;
  const transform = JSON.parse(JSON.stringify(def.transform)) as SceneNode['transform'];
  transform.position.x += dx;
  transform.position.y += dy;
  const node: SceneNode = {
    id,
    name: def.name,
    parent: parentId,
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
  out.push(node);
  for (const child of def.children) node.children.push(treeNodes(child, id, 0, 0, out, seq));
  return id;
}

/**
 * The component as a preview document: its layers under a transparent
 * composition the size of their bounds plus a margin. Null when the component
 * holds nothing to draw. Pure (no engine), exported for the tests.
 */
export function componentThumbDocument(def: ComponentDef): PreviewDocument | null {
  const tops = componentTrees(def);
  if (tops.length === 0) return null;
  const b = treeBounds(tops);
  const w = Math.max(1, b.maxX - b.minX + PAD * 2);
  const h = Math.max(1, b.maxY - b.minY + PAD * 2);
  const root: SceneNode = {
    id: THUMB_ROOT,
    name: def.name,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } } as SceneNode['transform'],
    visible: true,
    locked: false,
    components: [{ id: `${THUMB_ROOT}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  };
  const nodes: SceneNode[] = [root];
  // Move the layers so their bounds start at (PAD, PAD) INSIDE the composition
  // — its coordinate space is 0-based, and content in negative space draws
  // outside it.
  const seq = { n: 0 };
  for (const top of tops) root.children.push(treeNodes(top, THUMB_ROOT, PAD - b.minX, PAD - b.minY, nodes, seq));
  // The component at rest: no animation rides in a thumbnail (a saved entrance
  // would show its first, often empty, frame).
  return previewDocumentOf(nodes, null, { rootId: THUMB_ROOT, name: def.name, width: w, height: h, background: 'rgba(0,0,0,0)' });
}

const listeners = new Set<() => void>();
const pending = new Set<string>();

/** Subscribe to "a thumbnail just became available" — repaint your grid. */
export function onComponentThumbReady(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    if (typeof FileReader === 'undefined') { resolve(null); return; }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function renderThumb(def: ComponentDef, key: string): Promise<void> {
  const doc = componentThumbDocument(def);
  if (!doc) return;
  // Queued behind the other preview stills (one at a time on the engine).
  const blob = await previewStill(doc, 0, THUMB_SIZE, { priority: 'poster' });
  const url = blob ? await blobToDataUrl(blob) : null;
  // No picture (the engine could not draw it): left uncached, so the caller
  // keeps its icon and a later showing asks again.
  if (!url) return;
  cacheThumb(key, url);
  listeners.forEach((fn) => fn());
}

/**
 * The component's thumbnail as a data URL — a cached hit, or null while the
 * engine's still is in flight (or unavailable). A miss asks for it; listen via
 * `onComponentThumbReady` for completion.
 */
export function componentThumb(def: ComponentDef): string | null {
  const key = `${def.id}:${def.createdAt}`;
  const hit = cache.get(key);
  if (hit) {
    cacheThumb(key, hit); // refresh recency
    return hit;
  }
  if (!pending.has(key)) {
    pending.add(key);
    void renderThumb(def, key).catch(() => undefined).finally(() => pending.delete(key));
  }
  return null;
}

/** Test seam: install a rendered thumbnail as if the engine's still had landed. */
export function primeComponentThumb(def: Pick<ComponentDef, 'id' | 'createdAt'>, url: string): void {
  cacheThumb(`${def.id}:${def.createdAt}`, url);
}

/** Test seam: how many thumbnails are held. */
export function componentThumbCacheSize(): number {
  return cache.size;
}

/** Drop a component's cached thumbnail (call when it is re-saved). */
export function invalidateComponentThumb(defId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${defId}:`)) cache.delete(key);
  }
}
