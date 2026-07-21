/**
 * Text on a path (AE "Path Options").
 *
 * The path is one of the text layer's **own masks**, which is exactly how After
 * Effects models this: you draw a mask on the text layer and point Path Options
 * at it. That choice is not just for familiarity — masks are already editable on
 * canvas with the Direct Selection tool and already serialize, so text on a path
 * inherits a real path editor for free. Nothing else in the scene graph lets one
 * layer reference another's geometry, so the alternative would have meant
 * inventing cross-layer refs first.
 *
 * The geometry here is pure and sampler-driven, like trimPath: masks flatten to
 * a polyline, {@link applyTextPath} maps an already-laid-out line of glyphs onto
 * it, and the backend just paints what it is handed.
 */

import type { SceneNode } from '@core/types';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { bumpScene } from '@stores/sceneStore';
import { maskSegments, type MaskPath } from '@core/effects/mask';
import { arcTable, pointAndTangentAtLength, type ArcTable, type Pt } from '@core/scene/trimPath';
import type { TextLayout, PlacedGlyph } from './textLayout';

export interface TextPath {
  /** Which of the layer's masks to ride. Empty = the first one. */
  pathId: string;
  /** Shift the text along the path, px. Keyframeable — this is the "crawl". */
  firstMargin: number;
  /** Walk the path backwards (and flip the glyphs so they stay readable). */
  reversed: boolean;
  /** Rotate each glyph to the path's heading. Off = upright glyphs that still
   *  follow the curve, which AE calls turning Perpendicular To Path off. */
  perpendicular: boolean;
}

export const TEXT_PATH_PARAMS = ['firstMargin'] as const;
export type TextPathParam = (typeof TEXT_PATH_PARAMS)[number];

export function textPathPropPath(param: TextPathParam): string {
  return `textPath.${param}`;
}

export function defaultTextPath(): TextPath {
  return { pathId: '', firstMargin: 0, reversed: false, perpendicular: true };
}

/** How finely each cubic is chorded. Text sits right on the curve, so the
 *  8/segment used for boolean ops is visibly faceted at glyph scale. */
const FLATTEN_PER_SEGMENT = 24;

// ── Pure geometry (tested) ───────────────────────────────────────────

function cubicAt(
  p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number,
): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

/**
 * Flatten a mask to a polyline in layer-local space.
 *
 * Sampling is uniform in `t`, not in arc length, so points bunch on tight
 * curves. That is invisible here because {@link applyTextPath} places glyphs by
 * arc length over the *resulting* polyline — the chords are what get measured,
 * so denser chords simply mean a better approximation, never a spacing error.
 */
export function flattenMaskPath(path: MaskPath, perSegment = FLATTEN_PER_SEGMENT): {
  pts: Pt[];
  closed: boolean;
} {
  const segs = maskSegments(path);
  if (segs.length === 0) return { pts: [], closed: !!path.closed };
  const pts: Pt[] = [{ x: segs[0]!.x0, y: segs[0]!.y0 }];
  for (const s of segs) {
    const p0 = { x: s.x0, y: s.y0 };
    const c1 = { x: s.cx1, y: s.cy1 };
    const c2 = { x: s.cx2, y: s.cy2 };
    const p1 = { x: s.x1, y: s.y1 };
    const straight = c1.x === p0.x && c1.y === p0.y && c2.x === p1.x && c2.y === p1.y;
    if (straight) {
      pts.push(p1);
      continue;
    }
    for (let i = 1; i <= perSegment; i++) pts.push(cubicAt(p0, c1, c2, p1, i / perSegment));
  }
  // A closed path's last point is the first; the arc table closes it itself.
  if (path.closed && pts.length > 1) pts.pop();
  return { pts, closed: !!path.closed };
}

export interface TextPathGeometry {
  table: ArcTable;
  firstMargin: number;
  reversed: boolean;
  perpendicular: boolean;
  align?: string;
}

/**
 * Map laid-out glyphs onto a path.
 *
 * Each glyph keeps its horizontal offset within its line — that offset becomes
 * an arc length — and its vertical offset becomes a displacement along the
 * path's normal, so multi-line text rides the curve in parallel and animator
 * `dy` still lifts a glyph off it.
 *
 * Alignment keeps meaning: left starts at the path's start, right ends at its
 * end, centre straddles the middle. Without that, `align` would silently do
 * nothing the moment a path was attached.
 */
export function applyTextPath(layout: TextLayout, geo: TextPathGeometry): PlacedGlyph[] {
  const { table, firstMargin, reversed, perpendicular } = geo;
  if (table.total <= 0) return layout.glyphs;
  const align = geo.align ?? 'left';

  return layout.glyphs.map((g) => {
    const line = layout.lines[g.line];
    const lineLeft = line?.left ?? 0;
    const lineWidth = line?.width ?? 0;

    // Where this line begins along the path.
    let base: number;
    if (align === 'center') base = (table.total - lineWidth) / 2;
    else if (align === 'right') base = table.total - lineWidth;
    else base = 0;

    const along = firstMargin + base + (g.x - lineLeft);
    const arc = reversed ? table.total - along : along;
    const { x, y, angle } = pointAndTangentAtLength(table, arc);

    // Reversed text walks backwards, so the heading points the wrong way; flip
    // it or every glyph renders mirrored.
    const heading = reversed ? angle + Math.PI : angle;
    // The glyph's own baseline offset rides the path's normal.
    const normal = heading + Math.PI / 2;
    const off = g.y;

    return {
      ...g,
      x: x + Math.cos(normal) * off,
      y: y + Math.sin(normal) * off,
      angle: perpendicular ? heading : 0,
    };
  });
}

// ── Scene integration ────────────────────────────────────────────────

const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
const bool = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);
const str = (v: unknown, fb: string): string => (typeof v === 'string' ? v : fb);

function fxProps(node: SceneNode): Record<string, unknown> | undefined {
  return node.components.find((c) => c.type === 'fx')?.props as Record<string, unknown> | undefined;
}

/** Static text-path config on a node, or null when none. */
export function readTextPathConfig(node: SceneNode): TextPath | null {
  const raw = fxProps(node)?.textPath;
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<TextPath>;
  const d = defaultTextPath();
  return {
    pathId: str(t.pathId, d.pathId),
    firstMargin: num(t.firstMargin, d.firstMargin),
    reversed: bool(t.reversed, d.reversed),
    perpendicular: bool(t.perpendicular, d.perpendicular),
  };
}

/** Resolve the text path for a frame, overriding params with animated values. */
export function resolveTextPath(
  node: SceneNode,
  av: Map<string, number> | undefined,
): TextPath | null {
  const base = readTextPathConfig(node);
  if (!base) return null;
  return {
    ...base,
    firstMargin: av?.get(textPathPropPath('firstMargin')) ?? base.firstMargin,
  };
}

/** The mask a text-path config points at, or null when it resolves to nothing. */
export function resolveTextPathMask(node: SceneNode, cfg: TextPath): MaskPath | null {
  const mask = fxProps(node)?.mask as { paths?: MaskPath[] } | undefined;
  const paths = mask?.paths;
  if (!paths || paths.length === 0) return null;
  if (!cfg.pathId) return paths[0]!;
  return paths.find((p) => p.id === cfg.pathId) ?? null;
}

/** Add / update / clear the text-path config on a layer. */
export function setTextPath(nodeId: string, cfg: TextPath | null): void {
  defaultSceneGraph.setTextPath(nodeId, cfg ?? undefined);
  bumpScene();
}

export function updateTextPath(nodeId: string, patch: Partial<TextPath>): void {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return;
  const base = readTextPathConfig(node) ?? defaultTextPath();
  setTextPath(nodeId, { ...base, ...patch });
}

/** Build the sampler for a node's text path, or null when it isn't usable. */
export function textPathGeometry(node: SceneNode, cfg: TextPath): ArcTable | null {
  const mask = resolveTextPathMask(node, cfg);
  if (!mask) return null;
  const { pts, closed } = flattenMaskPath(mask);
  if (pts.length < 2) return null;
  const table = arcTable(pts, closed);
  return table.total > 0 ? table : null;
}
