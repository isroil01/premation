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
import { readMeasuredTextStyle, measureTextBoxes, applyFontVariations } from '@core/text/measureText';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { traceBitmap, smoothContour, type TracedContour } from '@core/geometry/traceBitmap';
import { loadLocalFace, outlineRuns } from '@core/text/fontOutlines';
import type { SceneNode } from '@core/types';

/** Oversampling factor for the trace. 4× is where staircase artefacts stop
 *  being visible at 1× after smoothing, and an 80 px glyph is still a 320 px
 *  raster — cheap. */
const OVERSAMPLE = 4;

interface BPt { x: number; y: number; inX: number; inY: number; outX: number; outY: number }

/**
 * Rasterise the text exactly as the measurer lays it out, and return the
 * alpha plane plus the offset from the raster's origin to the layer's centre.
 * Null when there is no canvas to draw with (headless).
 */
function rasterizeText(node: SceneNode): { alpha: Uint8ClampedArray; w: number; h: number; cx: number; cy: number; scale: number } | null {
  if (typeof document === 'undefined') return null;
  const style = readMeasuredTextStyle(node);
  if (!style || !style.content.trim()) return null;
  const boxes = measureTextBoxes(style);
  if (!boxes) return null;

  const pad = Math.ceil(style.fontSize * 0.25);
  const w = Math.ceil((boxes.ink.width + pad * 2) * OVERSAMPLE);
  const h = Math.ceil((boxes.ink.height + pad * 2) * OVERSAMPLE);
  if (w < 2 || h < 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;

  g.scale(OVERSAMPLE, OVERSAMPLE);
  const fontStyle = style.fontStyle === 'italic' ? 'italic ' : '';
  g.font = `${fontStyle}${style.fontWeight} ${style.fontSize}px "${style.fontFamily}", Inter, system-ui, sans-serif`;
  // Variable Width/Slant must match the on-screen glyph — font-file outlines
  // ignore `fvar`, so the trace path is the one that can honor them.
  applyFontVariations(g, style);
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.fillStyle = '#fff';
  const lines = style.content.split('\n');
  const n = lines.length;
  const gap = style.fontSize * style.lineHeight + style.paragraphSpacing;
  // The block centre sits at the ink box's centre in the raster. The
  // measurer's `ink.offsetY` is the ink centre relative to the draw origin,
  // so the draw origin is the raster centre minus that.
  const cx = w / OVERSAMPLE / 2;
  const cy = h / OVERSAMPLE / 2 - boxes.ink.offsetY;
  const spacing = style.letterSpacing;
  for (let i = 0; i < n; i++) {
    const dy = (i - (n - 1) / 2) * gap;
    const line = lines[i] ?? '';
    if (spacing === 0) {
      g.fillText(line, cx, cy + dy);
    } else {
      // Letter spacing: lay glyphs by hand, centred as a whole.
      const chars = [...line];
      const widths = chars.map((c) => g.measureText(c).width);
      const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * spacing;
      let x = cx - total / 2;
      g.textAlign = 'left';
      chars.forEach((c, k) => {
        g.fillText(c, x, cy + dy);
        x += widths[k]! + spacing;
      });
      g.textAlign = 'center';
    }
  }
  const img = g.getImageData(0, 0, w, h);
  return { alpha: img.data, w, h, cx: w / 2, cy: h / 2, scale: OVERSAMPLE };
}

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
      ),
    }));
}

export function canCreateShapesFromText(nodeId: string): boolean {
  const node = defaultSceneGraph.getNode(nodeId);
  return !!node && readNodeKind(node) === 'text' && !!readMeasuredTextStyle(node)?.content.trim();
}

/** The font's own outlines, or null when the face cannot be read. */
async function fontRuns(node: SceneNode): Promise<{ runs: Array<{ points: BPt[]; open: false }>; w: number; h: number } | null> {
  if (typeof document === 'undefined') return null;
  const style = readMeasuredTextStyle(node);
  if (!style || !style.content.trim()) return null;
  const face = await loadLocalFace(style.fontFamily, Number(style.fontWeight) || 400, style.fontStyle === 'italic');
  if (!face) return null;
  const boxes = measureTextBoxes(style);
  if (!boxes) return null;
  const g = document.createElement('canvas').getContext('2d');
  if (!g) return null;
  const fontStyle = style.fontStyle === 'italic' ? 'italic ' : '';
  g.font = `${fontStyle}${style.fontWeight} ${style.fontSize}px "${style.fontFamily}", Inter, system-ui, sans-serif`;
  g.textBaseline = 'middle';
  const runs = outlineRuns(style, boxes, face, g);
  if (runs.length === 0) return null;
  const pad = Math.ceil(style.fontSize * 0.25);
  return { runs, w: boxes.ink.width + pad * 2, h: boxes.ink.height + pad * 2 };
}

/** The traced outlines — the fallback when the font cannot be read. */
function tracedRuns(node: SceneNode): { runs: Array<{ points: BPt[]; open: false }>; w: number; h: number } | null {
  const raster = rasterizeText(node);
  if (!raster) return null;
  const contours = traceBitmap(raster.alpha, raster.w, raster.h, 4, {
    threshold: 128,
    // Tolerance in RASTER pixels: 1.5 at 4× is ~0.4 px at 1× — well under
    // what smoothing then rounds away.
    tolerance: 1.5,
    minArea: 6 * OVERSAMPLE,
  });
  const runs = contoursToRuns(contours, raster.cx, raster.cy, raster.scale);
  if (runs.length === 0) return null;
  return { runs, w: raster.w / raster.scale, h: raster.h / raster.scale };
}

/**
 * The text's outlines as closed Bézier runs in layer space, from the trace —
 * synchronous, so the render snapshot can build an extrusion mesh from it.
 * Null without a canvas (headless) or for empty text.
 */
export function traceTextRuns(node: SceneNode): Array<{ points: BPt[]; open: false }> | null {
  return tracedRuns(node)?.runs ?? null;
}

export type ShapesFromTextSource = 'outlines' | 'traced';

/**
 * Create the shape layer beside the text layer and hide the original.
 * Resolves to the new layer's id and which source produced it, or null when
 * the text could not be outlined at all.
 */
export async function createShapesFromText(nodeId: string): Promise<{ id: string; source: ShapesFromTextSource } | null> {
  const node = defaultSceneGraph.getNode(nodeId);
  if (!node || readNodeKind(node) !== 'text') return null;
  const style = readMeasuredTextStyle(node);
  // Installed-face outlines do not apply `wdth`/`slnt`. When the author set a
  // variable axis, prefer the variation-aware raster trace over a misleading
  // default-axis outline.
  const wantsVariations = style != null
    && ((style.fontWidth !== undefined && Number.isFinite(style.fontWidth))
      || (style.fontSlant !== undefined && Number.isFinite(style.fontSlant)));
  let source: ShapesFromTextSource = 'outlines';
  let built = wantsVariations ? null : await fontRuns(node);
  if (!built) {
    source = 'traced';
    built = tracedRuns(node);
  }
  if (!built) return null;
  const { runs } = built;

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
