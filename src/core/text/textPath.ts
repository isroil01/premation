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
import { maskSegments, type MaskPath } from '@core/effects/mask';
import { arcTable, pointAndTangentAtLength, type ArcTable, type Pt } from '@core/scene/trimPath';
import type { TextLayout, PlacedGlyph } from './textLayout';
import { resolveAlign } from './textExtras';

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
  /**
   * AE's Force Alignment: the first character sits at First Margin, the last
   * at Last Margin, and the characters between are spread evenly. Optional so
   * a config written before it round-trips unchanged.
   */
  forceAlignment?: boolean;
  /** Offset of the text's END from the path's end, px (negative pulls it in).
   *  Drives right alignment and the far end of Force Alignment. Keyframeable. */
  lastMargin?: number;
}

/**
 * Every Path Options parameter, all keyframeable. The three switches animate
 * as 0/1 tracks read with a 0.5 threshold, which is how a hold keyframe on a
 * checkbox behaves.
 */
export const TEXT_PATH_PARAMS = ['firstMargin', 'lastMargin', 'reversed', 'perpendicular', 'forceAlignment'] as const;
export type TextPathParam = (typeof TEXT_PATH_PARAMS)[number];

export function textPathPropPath(param: TextPathParam): string {
  return `textPath.${param}`;
}

/** The param a `textPath.<param>` path names, or null. */
export function parseTextPathPropPath(path: string): TextPathParam | null {
  const m = /^textPath\.([A-Za-z]+)$/.exec(path);
  const p = m?.[1];
  return p && (TEXT_PATH_PARAMS as ReadonlyArray<string>).includes(p) ? (p as TextPathParam) : null;
}

/** A config param as the number its track holds (booleans are 0/1). */
export function textPathParamValue(cfg: TextPath, param: TextPathParam): number {
  switch (param) {
    case 'firstMargin': return cfg.firstMargin;
    case 'lastMargin': return cfg.lastMargin ?? 0;
    case 'reversed': return cfg.reversed ? 1 : 0;
    case 'perpendicular': return cfg.perpendicular ? 1 : 0;
    case 'forceAlignment': return cfg.forceAlignment ? 1 : 0;
  }
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
  forceAlignment?: boolean;
  lastMargin?: number;
  /**
   * The layout is VERTICAL type (verticalLayout.ts): each column rides the
   * path — a glyph's offset DOWN its column becomes the arc length, and the
   * column's x becomes the normal displacement (the first, right-hand column
   * on the path's left). Glyphs turn with the column frame, which maps the
   * column's down direction onto the tangent: upright CJK stand across the
   * path, rotated Latin lies along it, as in AE.
   */
  vertical?: boolean;
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
  // The justify variants ride a path by their last-line alignment — a path has
  // no box width to stretch a line to.
  const align = resolveAlign(geo.align).line;
  const lastMargin = geo.lastMargin ?? 0;

  // Force Alignment needs each glyph's rank within its line and the line's
  // glyph count, to share the slack evenly between characters.
  const rank = new Array<number>(layout.glyphs.length);
  const lineCount = new Map<number, number>();
  if (geo.forceAlignment) {
    layout.glyphs.forEach((g, i) => {
      const n = lineCount.get(g.line) ?? 0;
      rank[i] = n;
      lineCount.set(g.line, n + 1);
    });
  }

  const vertical = !!geo.vertical;
  return layout.glyphs.map((g, gi) => {
    const line = layout.lines[g.line];
    const lineLeft = line?.left ?? 0;
    const lineWidth = line?.width ?? 0;
    // Offset within the line: along it for horizontal type, down the column
    // (whose top `LineBox.y` holds) for vertical.
    const inLine = vertical ? g.y - (line?.y ?? 0) : g.x - lineLeft;

    let along: number;
    if (geo.forceAlignment) {
      // From First Margin (pen of the first glyph) to the path end + Last
      // Margin (advance end of the last glyph); the slack between the two is
      // added one share per character boundary.
      const span = table.total + lastMargin - firstMargin;
      const n = lineCount.get(g.line) ?? 1;
      const extra = n > 1 ? (span - lineWidth) / (n - 1) : (span - lineWidth) / 2;
      along = firstMargin + inLine + (n > 1 ? extra * rank[gi]! : extra);
    } else {
      // Where this line begins along the path. Last Margin moves right-aligned
      // text (and half-moves centred text); at 0 this is the original maths.
      let base: number;
      if (align === 'center') base = (table.total - lineWidth) / 2 + lastMargin / 2;
      else if (align === 'right') base = table.total - lineWidth + lastMargin;
      else base = 0;
      along = firstMargin + base + inLine;
    }
    const arc = reversed ? table.total - along : along;
    const { x, y, angle } = pointAndTangentAtLength(table, arc);

    // Reversed text walks backwards, so the heading points the wrong way; flip
    // it or every glyph renders mirrored.
    const heading = reversed ? angle + Math.PI : angle;
    // The glyph's own baseline offset rides the path's normal.
    const normal = heading + Math.PI / 2;
    if (vertical) {
      // The column frame's +y (down) maps onto the heading, so its +x maps
      // onto −normal and every glyph turns by heading − 90° on top of its own
      // (sideways) angle.
      const off = -g.x;
      return {
        ...g,
        x: x + Math.cos(normal) * off,
        y: y + Math.sin(normal) * off,
        angle: perpendicular ? heading - Math.PI / 2 + (g.angle ?? 0) : g.angle ?? 0,
      };
    }
    const off = g.y;

    return {
      ...g,
      x: x + Math.cos(normal) * off,
      y: y + Math.sin(normal) * off,
      angle: perpendicular ? heading : 0,
    };
  });
}

/**
 * The layer-local extent of glyphs placed on a path (`applyTextPath`): each
 * non-blank glyph counts as the circle circumscribing its advance × font-size
 * box, so the extent holds however the path turns it. Null when nothing is drawn.
 */
export function pathGlyphBounds(glyphs: ReadonlyArray<PlacedGlyph>): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of glyphs) {
    if (g.char.trim() === '') continue;
    const r = Math.hypot(Math.max(g.advance, g.inkWidth), g.style.fontSize) / 2;
    minX = Math.min(minX, g.x - r);
    maxX = Math.max(maxX, g.x + r);
    minY = Math.min(minY, g.y - r);
    maxY = Math.max(maxY, g.y + r);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
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
    ...(t.forceAlignment === true ? { forceAlignment: true } : {}),
    ...(typeof t.lastMargin === 'number' && Number.isFinite(t.lastMargin) && t.lastMargin !== 0 ? { lastMargin: t.lastMargin } : {}),
  };
}

/** Resolve the text path for a frame, overriding params with animated values. */
export function resolveTextPath(
  node: SceneNode,
  av: Map<string, number> | undefined,
): TextPath | null {
  const base = readTextPathConfig(node);
  if (!base) return null;
  const flag = (param: TextPathParam, fb: boolean): boolean => {
    const v = av?.get(textPathPropPath(param));
    return v === undefined ? fb : v >= 0.5;
  };
  const lastMargin = av?.get(textPathPropPath('lastMargin')) ?? base.lastMargin;
  const forceAlignment = flag('forceAlignment', base.forceAlignment === true);
  return {
    ...base,
    firstMargin: av?.get(textPathPropPath('firstMargin')) ?? base.firstMargin,
    reversed: flag('reversed', base.reversed),
    perpendicular: flag('perpendicular', base.perpendicular),
    ...(forceAlignment ? { forceAlignment: true } : { forceAlignment: undefined }),
    ...(lastMargin ? { lastMargin } : { lastMargin: undefined }),
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

/** Build the sampler for a node's text path, or null when it isn't usable. */
export function textPathGeometry(node: SceneNode, cfg: TextPath): ArcTable | null {
  const mask = resolveTextPathMask(node, cfg);
  if (!mask) return null;
  const { pts, closed } = flattenMaskPath(mask);
  if (pts.length < 2) return null;
  const table = arcTable(pts, closed);
  return table.total > 0 ? table : null;
}
