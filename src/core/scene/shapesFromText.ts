/**
 * Create Shapes From Text — a text layer's glyphs as an editable shape layer.
 *
 * AE's Layer ▸ Create Shapes from Text. The new layer is a path layer whose
 * Geometry carries one closed run per glyph contour — outer rings and the
 * counters of letters like O and A as holes — positioned to coincide with the
 * text layer, which is hidden rather than deleted (AE keeps it too).
 *
 * ## Where the outlines come from
 *
 * From the FONT when it can be read: the installed face is opened through the
 * Local Font Access API and its `glyf` or CFF outlines are parsed
 * (`openType.ts`), laid out to match the rasteriser (`fontOutlines.ts`). Those
 * are the font's own Béziers — as few anchors as the designer drew.
 *
 * When the face cannot be read — a web font, or local-font permission refused
 * — the text is rasterised at 4× and TRACED (`traceBitmap`) then smoothed. The
 * result looks like the glyph but has more anchors than the font's data, so
 * the layer's name says which path produced it: "(outlines)" or "(traced)". A
 * traced outline presented as a font outline would mislead the next person to
 * twirl it open.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { readMeasuredTextStyle, measureParagraphBox, measureTextBoxes, measureTextSize } from '@core/text/measureText';
import { textExtrasForNode } from '@core/text/textExtras';
import { paintTextInBox, type TextPaintSpec } from '@core/rendering/raster/textPaint';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { traceBitmap, smoothContour, type TracedContour } from '@core/geometry/traceBitmap';
import { loadLocalFace, outlineRuns } from '@core/text/fontOutlines';
import { axisValuesOf, fontVariationString, resolveFontAxes, type VariationBase } from '@core/text/fontAxes';
import { variantFamily } from '@core/text/fontFaceVariants';
import { defaultAnimation } from '@motion/animation';
import { getRemappedTime, getTimelineController } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';

/** Oversampling factor for the trace. 4× is where staircase artefacts stop
 *  being visible at 1× after smoothing, and an 80 px glyph is still a 320 px
 *  raster — cheap. */
const OVERSAMPLE = 4;

interface BPt { x: number; y: number; inX: number; inY: number; outX: number; outY: number }

/**
 * Rasterise a text spec EXACTLY as the layer's own texture is drawn — the
 * same painter (`paintTextInBox`), the same box, the same origin — at 4×,
 * as a white silhouette (fill and stroke both white, so the layer stroke is
 * part of the outline the way it is part of the pixels).
 *
 * The raster is the layer box (`spec.width × spec.height`) scaled by
 * OVERSAMPLE; its centre is the layer's centre. Null when there is no canvas
 * to draw with (headless).
 */
function rasterizeTextSpec(spec: TextPaintSpec, oversample: number): { alpha: Uint8ClampedArray; w: number; h: number; scale: number } | null {
  if (typeof document === 'undefined') return null;
  if (!(spec.text ?? '').trim()) return null;
  const w = Math.ceil(spec.width * oversample);
  const h = Math.ceil(spec.height * oversample);
  if (w < 2 || h < 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.scale(oversample, oversample);
  paintTextInBox(g, { ...spec, color: '#ffffff', textStroke: '#ffffff' });
  const img = g.getImageData(0, 0, w, h);
  return { alpha: img.data, w, h, scale: oversample };
}

/**
 * The paint spec for a text NODE — the same fields buildSnapshot puts on the
 * render layer and MotionRendererBackend feeds the texture provider, read
 * straight off the components. For Create Shapes From Text, which has a node
 * and no render layer; the render snapshot builds its spec from the layer.
 */
export function textPaintSpecFromNode(node: SceneNode): TextPaintSpec | null {
  const style = readMeasuredTextStyle(node);
  if (!style || !style.content.trim()) return null;
  const size = measureTextSize(style);
  if (!size) return null;
  let align: string | undefined;
  let textStroke: string | undefined;
  let textStrokeWidth: number | undefined;
  let strokeOverFill: boolean | undefined;
  for (const c of node.components) {
    const p = c.props as Record<string, unknown>;
    if (typeof p.align === 'string') align = p.align;
    if (typeof p.textStroke === 'string') textStroke = p.textStroke;
    if (typeof p.textStrokeWidth === 'number') textStrokeWidth = p.textStrokeWidth;
    if (typeof p.strokeOverFill === 'boolean') strokeOverFill = p.strokeOverFill;
  }
  return {
    text: style.content,
    fontSize: style.fontSize,
    color: '#ffffff',
    width: size.w,
    height: size.h,
    fontFamily: style.fontFamily,
    fontWeight: style.fontWeight,
    fontWidth: style.fontWidth,
    fontSlant: style.fontSlant,
    fontStyle: style.fontStyle,
    align,
    letterSpacing: style.letterSpacing,
    lineHeight: style.lineHeight,
    paragraphSpacing: style.paragraphSpacing,
    textTransform: style.textTransform,
    fontVariant: style.fontVariant,
    verticalAlign: style.verticalAlign,
    verticalScale: style.verticalScale,
    horizontalScale: style.horizontalScale,
    baselineShift: style.baselineShift,
    textStroke,
    textStrokeWidth,
    strokeOverFill,
    // An auto-height box's top-anchor offset, exactly as buildSnapshot passes it.
    textExtras: textExtrasForNode(node, style.softBreakLines, {
      fitScale: style.fitScale,
      boxOffsetY: style.boxAnchorHeight ? measureParagraphBox(style)?.lineOffsetY : undefined,
    }),
  };
}

/** Turn angle at which a traced glyph vertex is a corner — see `smoothContour`. */
const TEXT_CORNER_ANGLE_DEG = 38;

/** Trace, smooth, and express contours in LAYER space (centre-origin, 1×). */
function contoursToRuns(
  contours: ReadonlyArray<TracedContour>,
  cx: number,
  cy: number,
  scale: number,
): Array<{ points: BPt[]; open: false }> {
  return contours
    .filter((c) => c.points.length >= 3)
    .map((c) => ({
      open: false as const,
      points: smoothContour(
        c.points.map((p) => ({ x: (p.x - cx) / scale, y: (p.y - cy) / scale })),
        0.55,
        // TYPE: keep corners. 38° sits above the ~18–32° steps a simplified
        // bowl or counter turns by, and far below a stem's 90° or an apex.
        TEXT_CORNER_ANGLE_DEG,
      ),
    }));
}

export function canCreateShapesFromText(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readNodeKind(node) === 'text' && !!readMeasuredTextStyle(node)?.content.trim();
}

/**
 * The variation a text node DRAWS with at `compTime`: keyframed weight, width,
 * slant and `text.axis.<tag>` tracks over the static props, read the way
 * buildSnapshot reads them (weight continuous, clamped to 1–1000). Without a
 * time, the static props.
 */
export function drawnVariationOf(
  node: SceneNode,
  style: { fontWeight: string; fontWidth?: number; fontSlant?: number },
  compTime?: number,
): VariationBase & { fontWeight: string } {
  const av = compTime === undefined ? undefined : defaultAnimation.evaluateNode(node.id, getRemappedTime(node.id, compTime));
  const num = (k: string): number | undefined => {
    const v = av?.get(k);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const w = num('fontWeight');
  const fontWidth = num('fontWidth') ?? style.fontWidth;
  const fontSlant = num('fontSlant') ?? style.fontSlant;
  const fontAxes = resolveFontAxes(node, av);
  return {
    fontWeight: w !== undefined ? String(Math.max(1, Math.min(1000, w))) : style.fontWeight,
    ...(fontWidth !== undefined ? { fontWidth } : {}),
    ...(fontSlant !== undefined ? { fontSlant } : {}),
    ...(fontAxes ? { fontAxes } : {}),
  };
}

/** The font's own outlines, or null when the face cannot be read. */
async function fontRuns(node: SceneNode, compTime?: number): Promise<{ runs: Array<{ points: BPt[]; open: false }>; w: number; h: number } | null> {
  if (typeof document === 'undefined') return null;
  const style = readMeasuredTextStyle(node);
  if (!style || !style.content.trim()) return null;
  const drawn = drawnVariationOf(node, style, compTime);
  const face = await loadLocalFace(style.fontFamily, Number(drawn.fontWeight) || 400, style.fontStyle === 'italic');
  if (!face) return null;
  const boxes = measureTextBoxes(style);
  if (!boxes) return null;
  const g = document.createElement('canvas').getContext('2d');
  if (!g) return null;
  const fontStyle = style.fontStyle === 'italic' ? 'italic ' : '';
  // Pens are measured with the face the painter draws: axes beyond weight
  // reach the canvas only through an alias FontFace (fontFaceVariants.ts).
  const variation = drawn.fontWidth !== undefined || drawn.fontSlant !== undefined || drawn.fontAxes ? fontVariationString(drawn) : undefined;
  const alias = variation ? variantFamily({ fontFamily: style.fontFamily, fontWeight: drawn.fontWeight, fontStyle: style.fontStyle }, variation, undefined) : null;
  g.font = `${fontStyle}${drawn.fontWeight} ${style.fontSize}px "${alias ?? style.fontFamily}", Inter, system-ui, sans-serif`;
  g.textBaseline = 'middle';
  // A variable face is outlined at that same instance (openType.ts `instance`).
  const runs = outlineRuns(style, boxes, face, g, axisValuesOf(drawn));
  if (runs.length === 0) return null;
  // The LAYER box, so the shape layer's box is the text layer's box.
  const size = measureTextSize(style);
  if (!size) return null;
  return { runs, w: size.w, h: size.h };
}

/**
 * Trace a text spec's silhouette into closed Bézier runs in LAYER space —
 * centre-origin, 1×, the origin being the box centre the layer's texture is
 * drawn around. Synchronous, so the render snapshot can build an extrusion
 * mesh from it. Null without a canvas (headless) or for empty text.
 */
export function traceTextSpec(spec: TextPaintSpec, oversample: number = OVERSAMPLE): Array<{ points: BPt[]; open: false }> | null {
  const raster = rasterizeTextSpec(spec, oversample);
  if (!raster) return null;
  const contours = traceBitmap(raster.alpha, raster.w, raster.h, 4, {
    threshold: 128,
    // Tolerance in RASTER pixels: ~0.4 px at 1× whatever the oversample —
    // well under what smoothing then rounds away.
    tolerance: 0.375 * oversample,
    minArea: 6 * oversample,
  });
  const runs = contoursToRuns(contours, raster.w / 2, raster.h / 2, raster.scale);
  return runs.length > 0 ? runs : null;
}

/** The traced outlines — the fallback when the font cannot be read. */
function tracedRuns(node: SceneNode): { runs: Array<{ points: BPt[]; open: false }>; w: number; h: number } | null {
  const spec = textPaintSpecFromNode(node);
  if (!spec) return null;
  const runs = traceTextSpec(spec);
  if (!runs) return null;
  return { runs, w: spec.width, h: spec.height };
}

/** A text node's traced outlines in layer space (see `traceTextSpec`). */
export function traceTextRuns(node: SceneNode): Array<{ points: BPt[]; open: false }> | null {
  return tracedRuns(node)?.runs ?? null;
}

export type ShapesFromTextSource = 'outlines' | 'traced';

/**
 * A text node's glyph outlines in LAYER space, from the font when that is
 * faithful and from a trace otherwise — the choice Create Shapes and Create
 * Masks from Text share, so both make the same geometry from the same layer.
 *
 * `compTime` samples keyframed font axes (weight, width, slant, any
 * `text.axis.<tag>`): a variable face is outlined at the instance drawn then.
 */
export async function outlineTextNode(node: SceneNode, compTime?: number): Promise<{
  runs: Array<{ points: BPt[]; open: false }>;
  w: number;
  h: number;
  source: ShapesFromTextSource;
} | null> {
  if (readNodeKind(node) !== 'text') return null;
  const spec = textPaintSpecFromNode(node);
  // `outlineRuns` lays out plain centred lines: no case transform, small
  // caps, scale, baseline shift, stroke, or left/right alignment. When the
  // author set any of those, prefer the trace — which is painted by the
  // layer's own rasteriser and so has them all — over a misleading outline.
  // (Variation axes are NOT a reason: a variable face's outlines are instanced
  // at the layer's axes, and a static face ignores them exactly as it draws.)
  const wantsPaintedLayout = spec != null && (
    !!spec.textTransform || !!spec.fontVariant || !!spec.verticalAlign
    || spec.verticalScale !== undefined || spec.horizontalScale !== undefined || spec.baselineShift !== undefined
    || (spec.textStrokeWidth ?? 0) > 0
    || spec.textExtras !== undefined
    || (spec.align !== undefined && spec.align !== 'center' && spec.text.includes('\n'))
  );
  let source: ShapesFromTextSource = 'outlines';
  let built = wantsPaintedLayout ? null : await fontRuns(node, compTime);
  if (!built) {
    source = 'traced';
    built = tracedRuns(node);
  }
  return built ? { ...built, source } : null;
}

/**
 * Create the shape layer beside the text layer and hide the original.
 * Resolves to the new layer's id and which source produced it, or null when
 * the text could not be outlined at all.
 */
export async function createShapesFromText(nodeId: string): Promise<{ id: string; source: ShapesFromTextSource } | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'text') return null;
  const built = await outlineTextNode(node, getTimelineController().currentSeconds);
  if (!built) return null;
  const { runs, source } = built;

  const t = node.components.find((c) => c.type === 'Transform')?.props as Record<string, unknown> | undefined;
  const styleComp = node.components.find((c) => c.type === 'Style' || c.type === 'Text')?.props as Record<string, unknown> | undefined;
  const num = (v: unknown, fb: number): number => (typeof v === 'number' ? v : fb);
  const id = `shape_from_text_${nodeId}_${Date.now().toString(36)}`;
  const parent = node.parent ?? 'comp_root';
  const fill = typeof styleComp?.fill === 'string' ? (styleComp.fill as string) : '#ffffff';

  const shape: SceneNode = {
    id,
    name: `${node.name ?? 'Text'} Outlines (${source})`,
    parent,
    children: [],
    transform: {
      position: { x: num(t?.x, 0), y: num(t?.y, 0) },
      rotation: num(t?.rotation, 0),
      scale: { x: num(t?.scaleX, 1), y: num(t?.scaleY, 1) },
    },
    visible: true,
    locked: false,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: {
          [SCENE_KIND_PROP]: 'shape',
          x: num(t?.x, 0), y: num(t?.y, 0), rotation: num(t?.rotation, 0),
          scaleX: num(t?.scaleX, 1), scaleY: num(t?.scaleY, 1),
          width: built.w, height: built.h,
          shapeType: 'path',
        },
      },
      { id: `${id}_s`, type: 'Style', props: { fill, opacity: num(styleComp?.opacity, 100) } },
      // Runs, never the flat point list: a letter with a counter is two runs,
      // and the flat form is "what filled every donut's hole" (sceneInsert).
      { id: `${id}_g`, type: 'Geometry', props: { subpaths: runs } },
    ],
  };
  defaultSceneGraph.addChild(parent, shape);
  // AE hides the source text layer rather than deleting it; the shapes are a
  // derivative and the text is still the editable truth.
  const src = defaultSceneGraph.getNode(nodeId);
  if (src) src.visible = false;
  useSelectionStore.getState().set([id]);
  bumpScene();
  return { id, source };
}
