/**
 * Extrusion meshes for the render snapshot — the layer's outline swept into a
 * real solid (core/geometry/extrudeMesh.ts), cached so an unchanged object
 * costs nothing per frame.
 *
 * This is the mesh-path counterpart of `extrusion.ts`, which synthesises flat
 * quads. The quad model remains the geometry face picking and the gizmos
 * reason about (its faces are simple to hit-test), and the fallback when an
 * outline cannot be produced; RENDERING goes through here.
 *
 * Outlines by layer kind:
 *   • shape rect (incl. per-corner radii) — exact rounded-rect polygon;
 *   • shape ellipse — a ring whose segment count follows the size;
 *   • shape path — the layer's own closed Bézier runs, flattened;
 *   • text — the glyphs TRACED from a 4× raster (`traceTextRuns`), which is
 *     what Create Shapes From Text uses when the font cannot be read, so the
 *     silhouette matches the drawn text to ~0.4 px;
 *   • anything else (image, video, precomp…) — the layer rect.
 *
 * Two caches: outlines keyed by what shapes them (text content + style, path
 * points, size + radii) and meshes keyed by outline + depth + bevel. Both
 * are small LRUs — the snapshot is rebuilt every frame and must not re-trace
 * text or re-triangulate a glyph set at 60 fps.
 */

import { extrudeOutline, rectOutline, ellipseOutline, bezierRunsToRings, type ExtrudedMesh, type BevelProfile } from '@core/geometry/extrudeMesh';
import type { Ring } from '@core/geometry/polygonTriangulate';
import { layerSubpaths } from '@core/rendering/raster/subpaths';
import { traceTextRuns } from '@core/scene/shapesFromText';
import { readMeasuredTextStyle } from '@core/text/measureText';
import type { RenderLayer } from '@core/rendering/RenderBackend';
import type { SceneNode } from '@core/types';

const OUTLINE_CACHE_MAX = 64;
const MESH_CACHE_MAX = 128;

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, v);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  clear(): void {
    this.map.clear();
  }
}

const outlines = new Lru<{ rings: Ring[] } | null>(OUTLINE_CACHE_MAX);
const meshes = new Lru<ExtrudedMesh | null>(MESH_CACHE_MAX);

/** Test seam. */
export function clearExtrusionMeshCaches(): void {
  outlines.clear();
  meshes.clear();
}

let meshPathEnabled = true;

/**
 * Test seam: switch the mesh path off so the snapshot takes the quad-synthesis
 * FALLBACK (`extrusion.ts`). That path is still live — it is what renders when
 * an outline cannot be produced — and its own suites keep guarding it through
 * this switch. Production never calls it.
 */
export function setExtrusionMeshPath(enabled: boolean): void {
  meshPathEnabled = enabled;
}

export function isExtrusionMeshPathEnabled(): boolean {
  return meshPathEnabled;
}

function radiiOf(layer: RenderLayer): readonly [number, number, number, number] | number {
  if (layer.cornerRadii) return layer.cornerRadii;
  return layer.cornerRadius ?? 0;
}

function hashPoints(pts: ReadonlyArray<{ x: number; y: number; inX: number; inY: number; outX: number; outY: number }>): string {
  // Cheap content hash: length + a running FNV over rounded coordinates.
  let h = 2166136261;
  const mix = (v: number): void => {
    const r = Math.round(v * 16);
    h ^= r & 0xffff;
    h = Math.imul(h, 16777619);
    h ^= (r >> 16) & 0xffff;
    h = Math.imul(h, 16777619);
  };
  for (const p of pts) {
    mix(p.x); mix(p.y); mix(p.inX); mix(p.inY); mix(p.outX); mix(p.outY);
  }
  return `${pts.length}:${(h >>> 0).toString(36)}`;
}

/**
 * The outline key and rings for a layer. `null` when the kind cannot be
 * outlined right now (e.g. text without a canvas) — the caller falls back to
 * the quad synthesis.
 */
export function extrusionOutlineFor(
  layer: RenderLayer,
  node: SceneNode | undefined,
  width: number,
  height: number,
): { key: string; rings: Ring[] } | null {
  if (!meshPathEnabled) return null;
  const W = Math.max(1, Math.round(width * 100) / 100);
  const H = Math.max(1, Math.round(height * 100) / 100);

  if (layer.kind === 'shape' && layer.primitive === 'ellipse') {
    const key = `ellipse:${W}x${H}`;
    let hit = outlines.get(key);
    if (hit === undefined) {
      hit = { rings: ellipseOutline(W, H) };
      outlines.set(key, hit);
    }
    return hit ? { key, rings: hit.rings } : null;
  }

  if (layer.kind === 'shape' && layer.primitive === 'path') {
    const subs = layerSubpaths(layer).filter((s) => !s.open && s.points.length >= 3);
    if (subs.length === 0) return null;
    const key = `path:${subs.map((s) => hashPoints(s.points)).join('/')}`;
    let hit = outlines.get(key);
    if (hit === undefined) {
      const rings = bezierRunsToRings(subs.map((s) => ({ points: s.points, open: false })), 0.6);
      hit = rings.length > 0 ? { rings } : null;
      outlines.set(key, hit);
    }
    return hit ? { key, rings: hit.rings } : null;
  }

  if (layer.kind === 'text') {
    if (!node) return null;
    // Text animators that move glyphs individually are not in the trace.
    if (layer.glyphs && layer.glyphs.length > 0) return null;
    const style = readMeasuredTextStyle(node);
    if (!style || !style.content.trim()) return null;
    const key = `text:${JSON.stringify([
      style.content, style.fontFamily, style.fontSize, style.fontWeight, style.fontStyle,
      style.letterSpacing, style.lineHeight, style.paragraphSpacing,
    ])}`;
    let hit = outlines.get(key);
    if (hit === undefined) {
      const runs = traceTextRuns(node);
      const rings = runs ? bezierRunsToRings(runs, 0.5) : [];
      hit = rings.length > 0 ? { rings } : null;
      outlines.set(key, hit);
    }
    return hit ? { key, rings: hit.rings } : null;
  }

  // Rect-shaped content: shapes, images, video, solids, precomps.
  const r = radiiOf(layer);
  const rk = typeof r === 'number' ? String(Math.round(r * 10) / 10) : r.map((v) => Math.round(v * 10) / 10).join(',');
  const key = `rect:${W}x${H}:${rk}`;
  let hit = outlines.get(key);
  if (hit === undefined) {
    hit = { rings: rectOutline(W, H, r) };
    outlines.set(key, hit);
  }
  return hit ? { key, rings: hit.rings } : null;
}

export interface ExtrusionMeshRequest {
  depth: number;
  bevel: number;
  bevelStyle: BevelProfile;
  /** Emit the (inset) front cap too — for outlines whose front the layer quad cannot inset. */
  frontCap?: boolean;
}

/**
 * The cached mesh for an outline + extrusion parameters. The returned `key`
 * is what the renderer caches GPU buffers under — it changes exactly when the
 * vertices do.
 */
export function extrusionMeshFor(
  outline: { key: string; rings: Ring[] },
  width: number,
  height: number,
  req: ExtrusionMeshRequest,
): { key: string; mesh: ExtrudedMesh } | null {
  const depth = Math.round(req.depth * 100) / 100;
  const bevel = Math.round(req.bevel * 100) / 100;
  if (depth <= 0) return null;
  const key = `${outline.key}|d${depth}|b${bevel}|${req.bevelStyle}${req.frontCap ? '|f' : ''}`;
  let mesh = meshes.get(key);
  if (mesh === undefined) {
    mesh = extrudeOutline(outline.rings, {
      depth,
      bevel,
      bevelStyle: req.bevelStyle,
      frontCap: !!req.frontCap,
      bevelSegments: req.bevelStyle === 'angular' ? 1 : 5,
      uvBox: { x: -width / 2, y: -height / 2, width, height },
    });
    meshes.set(key, mesh);
  }
  return mesh ? { key, mesh } : null;
}
