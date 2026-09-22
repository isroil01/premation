/**
 * Scene-node geometry for the Workspace interaction engine.
 *
 * Mirrors exactly how `buildSnapshot` places layers on the canvas — center
 * position (x, y) + fixed per-kind size, rotation in degrees, ellipse-vs-rect by
 * name — so hit-testing and selection overlays land pixel-on-pixel with what the
 * renderer draws. Comp space (1920×1080) is the Workspace's world space.
 */

import type { SceneNode } from '@core/types';
import { readNodeKind } from '@core/scene/sceneDerive';
import { SIZE } from '@core/rendering/buildSnapshot';
import { latestGeneratorBounds } from '@core/plugins/generator';
import { measureTextNodeLayout, measureTextNodeParagraphBox, measureTextNodeSize, measureTextNodeSelectionBox } from '@core/text/measureText';
import { hasTextPath, readParagraphBox } from '@core/text/textExtras';
import { applyTextPath, pathGlyphBounds, readTextPathConfig, textPathGeometry } from '@core/text/textPath';
import { useCompositionStore } from '@stores/compositionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
// Read-only throughout: `SceneNode.components` copies on every access, and the
// group walk below reads it for every descendant, every painted frame.
import { renderComponentsOf } from '@core/scene/SceneGraph';
import { defaultAnimation } from '@motion/animation';
import { getRemappedTime } from '@core/timeline/TimelineController';
import { useProjectStore } from '@stores/projectStore';
import { Mat, Rect, type Vec2, type Mat2D } from '@motion/workspace';

/** Active comp dimensions (hit box for full-frame comp-instance layers). */
function compositionSize(): { width: number; height: number } {
  const c = useCompositionStore.getState();
  return { width: c.width || 1920, height: c.height || 1080 };
}

/**
 * Where text on a path really is, layer-local: its glyphs laid out and bent
 * onto the path (static path options), as a centre + size. Null without text
 * metrics or a usable path.
 */
export function textPathExtent(
  node: SceneNode,
  overrideProps?: Record<string, unknown>,
  layout = measureTextNodeLayout(node, overrideProps),
): { w: number; h: number; cx: number; cy: number } | null {
  const cfg = readTextPathConfig(node);
  const table = cfg ? textPathGeometry(node, cfg) : null;
  if (!cfg || !table || !layout) return null;
  let align: string | undefined;
  let vertical = false;
  for (const c of renderComponentsOf(node)) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.align === 'string') align = p.align;
    if (p.orientation === 'vertical' || p.orientation === 'horizontal') vertical = p.orientation === 'vertical';
  }
  const b = pathGlyphBounds(applyTextPath(layout, {
    table,
    firstMargin: cfg.firstMargin,
    reversed: cfg.reversed,
    perpendicular: cfg.perpendicular,
    align,
    forceAlignment: cfg.forceAlignment,
    lastMargin: cfg.lastMargin,
    ...(vertical ? { vertical: true } : {}),
  }));
  if (!b) return null;
  return { w: Math.max(1, b.maxX - b.minX), h: Math.max(1, b.maxY - b.minY), cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 };
}

/** The workspace's plain rectangle value type. */
type WRect = ReturnType<typeof Rect.rect>;

export interface NodeGeometry {
  x: number;
  y: number;
  rotationDeg: number;
  /** Base (unscaled) size in comp px. */
  width: number;
  height: number;
  scaleX: number;
  scaleY: number;
  ellipse: boolean;
  /**
   * Where the box sits relative to the node's ORIGIN, in local px.
   *
   * Almost always (0, 0) — a layer's art is centred on its own position. A
   * GROUP is the exception: it has no geometry of its own, so its box is the
   * union of its children, which is wherever they happen to be. Keeping that as
   * an offset (rather than folding it into x/y) matters because x/y is what
   * every write path reads and writes back — moving a group must still move the
   * group, not teleport it onto its own content's centre.
   */
  offsetX: number;
  offsetY: number;
}

/**
 * True for kinds that are selectable/draggable in the viewport.
 * Everything a user inserts should be grabbable on canvas: particles get an
 * emitter gizmo box, comp instances a full-frame box, nulls an AE-style
 * gizmo. Only kinds with no canvas presence stay out (group = children carry
 * the geometry; audio = no visual; adjustment = invisible full-frame overlay
 * that would swallow every click above the layers it grades).
 *
 * `svg` belongs here for the same reason `image` does. A statically-imported
 * SVG stays ONE intact layer that buildSnapshot rasterizes down the image path
 * (see its `kind === 'svg' ? 'image'` mapping), so it draws on canvas like any
 * other texture — but it was missing from this list, and this list is the very
 * first gate in `readGeometry`. A null geometry drops the node out of
 * `toWorkspaceNode` entirely: no worldBounds for the broad phase, no
 * hitTestLocal for the click, no corners for the marquee or the outline. The
 * icon rendered and could be picked in the Scene tree, yet was unclickable and
 * undraggable on canvas. Animated SVGs never showed the bug because that import
 * branch converts to real keyframed SHAPE layers, which were always allowed.
 */
export function isDrawableKind(kind: string): boolean {
  // A plugin's own layer kind — recognised by the dot, since every native kind
  // is a bare word. Included for exactly the reason `null` is: a `render:
  // 'none'` controller has no art of its own but must still be grabbable on
  // canvas, and this list is the FIRST gate in `readGeometry`. A kind missing
  // from it drops out of `toWorkspaceNode` entirely — no bounds, no hit test,
  // no marquee — so the layer would appear in the tree and be unclickable in
  // the viewport, which is precisely how `svg` was broken.
  if (kind.includes('.')) return true;
  return kind === 'shape' || kind === 'text' || kind === 'image' || kind === 'video'
    || kind === 'svg'
    || kind === 'light' || kind === 'camera'
    || kind === 'particle' || kind === 'comp' || kind === 'null' || kind === 'group';
}

/**
 * A group's box: the union of its descendants, in the group's LOCAL space.
 *
 * Groups carry no size of their own, and the fallback was a hardcoded 280×280
 * square sitting on the group's origin. Insert a motion-graphics template — a
 * group whose parts are laid out across the middle of the comp — and the
 * selection box drew as a small square in the comp's top-left corner while the
 * artwork rendered somewhere else entirely. Dragging that box moved every child
 * (correctly, through the parent chain), but because the handle and the content
 * were nowhere near each other it read as the whole view sliding around.
 *
 * Children's x/y are already local to this group, so their boxes need no
 * transform — only rotation/scale of a child would, and the union of AABBs is
 * the conventional (and cheap) answer there.
 */
/**
 * A child's ANIMATED props at the playhead, or undefined when it has no tracks.
 *
 * Gated on `hasAnimation` deliberately: `readGeometry(group)` walks every
 * descendant, and this runs inside that walk, so sampling a static child would
 * put an engine call on the hot path of every scene enumeration for nothing.
 */
function animatedPropsOf(nodeId: string): Record<string, unknown> | undefined {
  if (!defaultAnimation.hasAnimation(nodeId)) return undefined;
  const s = useProjectStore.getState();
  const rawTime = s.tabs[s.activeTabId ?? '']?.time ?? 0;
  const av = defaultAnimation.evaluateNode(nodeId, getRemappedTime(nodeId, rawTime));
  const out: Record<string, unknown> = {};
  for (const [k, v] of av.entries()) out[k] = v;
  return out;
}

function groupContentBounds(
  node: SceneNode,
  depth = 0,
  live = false,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (depth > 16) return null; // cycle guard; a healthy tree is far shallower
  const children = defaultSceneGraph.getChildren(node.id);
  if (children.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const child of children) {
    const g = readGeometry(child, live ? animatedPropsOf(child.id) : undefined, { liveChildren: live });
    if (!g) continue;
    // A nested group contributes its own union, offset by its position.
    const halfW = Math.abs(g.width * g.scaleX) / 2;
    const halfH = Math.abs(g.height * g.scaleY) / 2;
    const cx = g.x + g.offsetX * g.scaleX;
    const cy = g.y + g.offsetY * g.scaleY;
    minX = Math.min(minX, cx - halfW);
    minY = Math.min(minY, cy - halfH);
    maxX = Math.max(maxX, cx + halfW);
    maxY = Math.max(maxY, cy + halfH);
  }
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Read a node's on-canvas geometry from its components (base/authoring props),
 * with `overrideProps` (typically the animated values at the playhead) winning.
 *
 * `opts.liveChildren` decides what a GROUP's box means, and the two answers are
 * genuinely different questions rather than one with a bug in it:
 *
 *   • OFF (default) — the union of the children at their BASE props: the
 *     element's settled LAYOUT box. That is what a transition asks for when it
 *     computes how far the element must travel to clear the frame; measuring
 *     mid-animation children would size the move from a pose the element is
 *     only passing through, and under-shoot.
 *   • ON — the union at the PLAYHEAD. That is what the editor CHROME needs: a
 *     selection outline, a hit area and a marquee target have to sit on the
 *     artwork as drawn, and with base props an animated group was unclickable
 *     everywhere it was visible and clickable where it was not.
 */
export function readGeometry(
  node: SceneNode,
  overrideProps?: Record<string, unknown>,
  opts?: { liveChildren?: boolean },
): NodeGeometry | null {
  const kind = readNodeKind(node);
  if (!isDrawableKind(kind)) return null;

  let x: number | undefined;
  let y: number | undefined;
  let rotation: number | undefined;
  let scaleX: number | undefined;
  let scaleY: number | undefined;
  let scale: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let shapeType: string | undefined;
  let radius: number | undefined;
  for (const c of renderComponentsOf(node)) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.x === 'number') x = p.x;
    if (typeof p.y === 'number') y = p.y;
    if (typeof p.rotation === 'number') rotation = p.rotation;
    if (typeof p.scaleX === 'number') scaleX = p.scaleX;
    if (typeof p.scaleY === 'number') scaleY = p.scaleY;
    if (typeof p.scale === 'number') scale = p.scale;
    if (typeof p.width === 'number') width = p.width;
    if (typeof p.height === 'number') height = p.height;
    if (typeof p.shapeType === 'string') shapeType = p.shapeType;
    if (typeof p.radius === 'number') radius = p.radius;
    else if (typeof p.outerRadius === 'number') radius = p.outerRadius;
    else if (typeof p.r === 'number') radius = p.r;
  }

  if (overrideProps) {
    if (typeof overrideProps.x === 'number') x = overrideProps.x;
    if (typeof overrideProps.y === 'number') y = overrideProps.y;
    if (typeof overrideProps.rotation === 'number') rotation = overrideProps.rotation;
    if (typeof overrideProps.scaleX === 'number') scaleX = overrideProps.scaleX;
    if (typeof overrideProps.scaleY === 'number') scaleY = overrideProps.scaleY;
    if (typeof overrideProps.scale === 'number') scale = overrideProps.scale;
    if (typeof overrideProps.width === 'number') width = overrideProps.width;
    if (typeof overrideProps.height === 'number') height = overrideProps.height;
  }

  // Measure exact bounding box of shape Geometry points if available
  let pointsBounds: { w: number; h: number } | null = null;
  if (kind === 'shape') {
    for (const c of renderComponentsOf(node)) {
      if (c.props && Array.isArray((c.props as any).points)) {
        const pts = (c.props as any).points as Array<{ x: number; y: number }>;
        if (pts.length > 0) {
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const pt of pts) {
            if (typeof pt.x === 'number' && typeof pt.y === 'number') {
              minX = Math.min(minX, pt.x);
              maxX = Math.max(maxX, pt.x);
              minY = Math.min(minY, pt.y);
              maxY = Math.max(maxY, pt.y);
            }
          }
          if (isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY)) {
            pointsBounds = { w: Math.max(10, maxX - minX), h: Math.max(10, maxY - minY) };
          }
        }
      }
    }
  }

  // Text layers size to their MEASURED content (point text, AE-style).
  //
  // The FONT box, not the ink box and not the render box:
  //   • the render box is the typographic line box plus padding — right for the
  //     raster, far too loose for an outline;
  //   • the ink box hugs these exact glyphs, so the outline would resize on
  //     every keystroke, which reads as broken. AE sizes text bounds from font
  //     metrics for the same reason: `HELLO` and `Hello` get the same height.
  //
  // The font box is NOT concentric with the layer origin — the draw baseline is
  // `textBaseline: 'middle'`, whose origin sits inside the em box rather than at
  // the band's centre — so it carries a vertical offset. Assuming concentricity
  // is exactly what used to leave capitals hanging ~4px above their own box.
  // PARAGRAPH text (a node carrying `boxWidth`) has a user-defined box: the
  // selection rectangle IS the authored width, and dragging a handle must
  // reflow the text inside it rather than scale the type. POINT text keeps
  // deriving its box from the glyphs.
  // Text on a PATH is point text: its box width sizes nothing, and its bounds
  // are where the glyphs actually ride the curve (null without metrics — the
  // measured point-text box then stands in).
  const onPath = kind === 'text' && hasTextPath(node);
  const pathExtent = onPath ? textPathExtent(node, overrideProps) : null;
  const authoredBoxWidth = kind === 'text' && !onPath
    ? (() => {
        const fromOverride = overrideProps?.boxWidth;
        if (typeof fromOverride === 'number' && fromOverride > 0) return fromOverride;
        for (const c of renderComponentsOf(node)) {
          const v = (c.props as Record<string, unknown>).boxWidth;
          if (typeof v === 'number' && v > 0) return v;
        }
        return undefined;
      })()
    : undefined;
  // A FIXED-height paragraph box is authored in both directions: the box IS the
  // selection, hit and snap rectangle, centred on the layer origin — so an
  // empty or overflowing box is grabbed by its frame, as in AE. No measurement.
  const fixedBox = kind === 'text' ? readParagraphBox(node, overrideProps) : null;
  const textBox = kind === 'text' && !fixedBox?.fixedHeight ? measureTextNodeSelectionBox(node, overrideProps) : null;
  // An AUTO-HEIGHT box with an authored height keeps that box's top edge: its
  // text is drawn `lineOffsetY` below the origin, and so is its selection.
  const anchoredBox = textBox && fixedBox && !fixedBox.fixedHeight && fixedBox.boxHeight > 0
    ? measureTextNodeParagraphBox(node, overrideProps)
    : null;
  const measured = pathExtent
    ? { w: pathExtent.w, h: pathExtent.h, dy: pathExtent.cy }
    : fixedBox?.fixedHeight
    ? { w: fixedBox.boxWidth, h: fixedBox.boxHeight, dy: 0 }
    : textBox
    ? { w: authoredBoxWidth ?? textBox.width, h: textBox.height, dy: textBox.offsetY + (anchoredBox?.lineOffsetY ?? 0) }
    : kind === 'text'
      ? (() => {
          // No metrics from this runtime (jsdom): fall back to the render box,
          // which is concentric by construction.
          const r = measureTextNodeSize(node, overrideProps);
          return r ? { w: r.w, h: r.h, dy: 0 } : null;
        })()
      : null;
  const size = measured ? { w: measured.w, h: measured.h }
             : pointsBounds ? pointsBounds
             // Devices FIRST: a light's `radius` prop is its falloff reach
             // (~45% of the comp's long edge by default), not a shape radius.
             // Letting the generic radius branch see it wrapped the light in a
             // comp-sized 2·radius selection box — a giant "blueprint" border
             // around what is really an icon. The wash is not the layer; the
             // device is. Both get a small fixed grab box at the device point,
             // like AE's icon-sized camera/light handles.
             : kind === 'light' ? { w: 48, h: 48 }
             : kind === 'camera' ? { w: 48, h: 48 }
             : radius && radius > 0 ? { w: radius * 2, h: radius * 2 }
             : kind === 'particle' ? { w: 140, h: 140 }
             : kind === 'null' ? { w: 60, h: 60 }
             : kind === 'group' ? { w: 280, h: 280 }
             : kind === 'comp' ? { w: compositionSize().width, h: compositionSize().height }
             // `SIZE` is keyed by RENDER kind, and an SVG layer renders as an
             // image — so it has no key of its own. Import always stamps the
             // document's intrinsic size on the Transform (placeInComp), so this
             // is only the floor for a node that somehow lost its dimensions;
             // inheriting the image default beats an arbitrary 100×100 square.
             : kind === 'svg' ? SIZE.image
             : (SIZE as any)[kind] ?? { w: 100, h: 100 };
  const name = (node.name ?? '').toLowerCase();

  // For text nodes, point text MUST use measured content box.
  // For shape/other nodes, use valid authored width/height if present, else pointsBounds / radius / default size.
  const hasAuthoredDim = typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0;
  let finalW = (kind === 'text' && measured) ? measured.w : (hasAuthoredDim ? width : (pointsBounds ? pointsBounds.w : size.w));
  let finalH = (kind === 'text' && measured) ? measured.h : (hasAuthoredDim ? height : (pointsBounds ? pointsBounds.h : size.h));
  let offsetX = pathExtent ? pathExtent.cx : 0;
  // Text carries the font box's vertical offset from the draw origin; every
  // other kind is centred on its own position.
  let offsetY = (kind === 'text' && measured) ? measured.dy : 0;

  // Full-frame solids: selection / handles must match the fill. Legacy inserts
  // left makeNode's 100×100 at (160,120) while the renderer drew full-comp —
  // the "tiny blueprint in the corner" bug.
  const isSolid = kind === 'shape'
    && renderComponentsOf(node).some((c) => c.type === 'fx' && (c.props as { solid?: boolean }).solid === true);
  let finalX = x ?? node.transform.position.x;
  let finalY = y ?? node.transform.position.y;
  if (isSolid) {
    const comp = compositionSize();
    const unseeded = !hasAuthoredDim || (width === 100 && height === 100);
    if (unseeded) {
      finalW = comp.width;
      finalH = comp.height;
      finalX = comp.width / 2;
      finalY = comp.height / 2;
    }
  }

  /*
    A plugin GENERATOR wraps its instances, not its emitter box.

    The authored width/height of a generator layer is the emitter's extent — a
    property-panel number — while what the user sees is wherever the particles
    went, which is usually much larger and rarely concentric. Selecting one by
    its emitter box means clicking a rectangle with nothing in it and missing
    every particle outside it.

    UNION rather than replacement: the emitter box stays grabbable even when the
    simulation has thrown everything off-screen, so a generator whose particles
    have all died is still a layer you can click.
  */
  if (kind.includes('.')) {
    const gb = latestGeneratorBounds(node.id);
    if (gb && gb.width > 0 && gb.height > 0) {
      const minX = Math.min(offsetX - finalW / 2, gb.x);
      const minY = Math.min(offsetY - finalH / 2, gb.y);
      const maxX = Math.max(offsetX + finalW / 2, gb.x + gb.width);
      const maxY = Math.max(offsetY + finalH / 2, gb.y + gb.height);
      finalW = Math.max(1, maxX - minX);
      finalH = Math.max(1, maxY - minY);
      offsetX = (minX + maxX) / 2;
      offsetY = (minY + maxY) / 2;
    }
  }

  // A group wraps its content — measure it rather than guessing a square.
  // Authored width/height on a group is a stale artifact of `makeNode` (which
  // stamps 280×280 on every group it creates), so it must NOT win here.
  if (kind === 'group') {
    const b = groupContentBounds(node, 0, opts?.liveChildren === true);
    if (b) {
      finalW = Math.max(1, b.maxX - b.minX);
      finalH = Math.max(1, b.maxY - b.minY);
      // Children are positioned in this group's local space, so the union's
      // centre is already the offset from the group's own origin.
      offsetX = (b.minX + b.maxX) / 2;
      offsetY = (b.minY + b.maxY) / 2;
    }
  }

  return {
    x: finalX,
    y: finalY,
    rotationDeg: rotation ?? node.transform.rotation,
    width: finalW,
    height: finalH,
    scaleX: scaleX ?? scale ?? 1,
    scaleY: scaleY ?? scale ?? 1,
    // Explicit shapeType wins; the name regex only covers legacy nodes.
    ellipse: shapeType ? shapeType === 'ellipse' : /circle|ellip|dot|orb/.test(name),
    offsetX,
    offsetY,
  };
}

/** local → world matrix: translate(center) · rotate(deg) · scale. */
export function worldMatrix(g: NodeGeometry): Mat2D {
  const tr = Mat.multiply(Mat.translation(g.x, g.y), Mat.rotation((g.rotationDeg * Math.PI) / 180));
  return Mat.multiply(tr, Mat.scaling(g.scaleX, g.scaleY));
}

/** Untransformed local bounds — centred on the origin, or on the content
 *  offset for a node (a group) whose box isn't its own position. */
export function localBounds(g: NodeGeometry): WRect {
  return Rect.rect(g.offsetX - g.width / 2, g.offsetY - g.height / 2, g.width, g.height);
}

/** World-space axis-aligned bounding box (handles rotation). */
export function worldBounds(g: NodeGeometry): WRect {
  return Rect.transform(localBounds(g), worldMatrix(g));
}

/** Precise local-space hit test (rect or inscribed ellipse). */
export function makeHitTestLocal(g: NodeGeometry): (p: Vec2) => boolean {
  const rx = g.width / 2;
  const ry = g.height / 2;
  const ox = g.offsetX;
  const oy = g.offsetY;
  if (g.ellipse) {
    return (p) => ((p.x - ox) * (p.x - ox)) / (rx * rx) + ((p.y - oy) * (p.y - oy)) / (ry * ry) <= 1;
  }
  return (p) => Math.abs(p.x - ox) <= rx && Math.abs(p.y - oy) <= ry;
}
