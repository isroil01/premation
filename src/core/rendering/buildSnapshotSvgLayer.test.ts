/**
 * SVG layers through the render pipeline.
 *
 * The model tests prove the document is stored correctly; this proves it
 * actually reaches the compositor. Our engine is texture-based — one GPU
 * backend, no Canvas2D fallback (createRenderBackend) — so an SVG layer has to
 * arrive as an IMAGE layer carrying a rasterizable src, or it renders as a
 * white placeholder quad and nobody finds out until they look at the canvas.
 *
 * The `fill` assertion is the subtle one: for a textured layer `fill` is a
 * RECOLOUR override the SVG rasterizer paints over every path, so inheriting
 * the kind's category colour would turn every imported SVG into a flat
 * silhouette.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { sanitizeSvg } from '@core/svg/svgSanitize';
import { makeSvgComponent } from '@core/svg/svgLayer';
import { scanSvgMarkup } from '@core/svg/svgCapabilities';
import { svgToDataUrl } from '@core/svg/svgSanitize';
import { decodeSvgDataUrl } from './AppTextureProvider';

const SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">' +
  '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
  '<rect width="64" height="32" fill="url(#g)"/></svg>';

function svgNode(id: string): SceneNode {
  const clean = sanitizeSvg(SOURCE, id)!;
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 100, y: 50 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'svg', x: 100, y: 50, rotation: 0, width: 64, height: 32 },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
      makeSvgComponent(`${id}_svg`, {
        sourceMarkup: SOURCE,
        sanitizedMarkup: clean.markup,
        size: { width: clean.width, height: clean.height, viewBox: clean.viewBox },
        capabilities: scanSvgMarkup(SOURCE),
        fileName: 'logo.svg',
      }),
    ],
  } as unknown as SceneNode;
}

describe('buildSnapshot — SVG layers', () => {
  const comp = { width: 800, height: 600, background: '#101014' };

  function snapshotOf(node: SceneNode) {
    const graph = new SceneGraph();
    graph.addNode(node);
    return buildSnapshot(graph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
  }

  test('emits one image layer carrying the sanitized document as a data URL', () => {
    const snap = snapshotOf(svgNode('svg1'));
    expect(snap.layers).toHaveLength(1);

    const layer = snap.layers[0]!;
    expect(layer.kind).toBe('image');
    expect(layer.src).toMatch(/^data:image\/svg\+xml;base64,/);

    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(layer.src!.split(',')[1]!), (c) => c.charCodeAt(0)),
    );
    // The rendered document is the id-SCOPED one, so two copies of the same
    // file cannot collide on `#g` and share a gradient.
    expect(decoded).toMatch(/url\(#svg1__g\)/);
  });

  test('carries no fill, so the rasterizer does not recolour the artwork', () => {
    expect(snapshotOf(svgNode('svg2')).layers[0]!.fill).toBeUndefined();
  });

  test('honours the layer transform and size like any other media layer', () => {
    const layer = snapshotOf(svgNode('svg3')).layers[0]!;
    expect(layer.x).toBe(100);
    expect(layer.y).toBe(50);
    expect(layer.width).toBe(64);
    expect(layer.height).toBe(32);
    expect(layer.opacity).toBe(1);
  });

  test('a hidden SVG layer reports invisible rather than drawing', () => {
    const node = svgNode('svg4');
    (node as { visible: boolean }).visible = false;
    expect(snapshotOf(node).layers[0]!.visible).toBe(false);
  });

  test('the rasterizer decodes exactly what the layer encoded', () => {
    // Encoder and decoder live on opposite sides of the pipeline, so a mismatch
    // shows up only as wrong pixels. `atob` alone yields one char per BYTE, which
    // renders every non-ASCII glyph as mojibake — hence the UTF-8 round-trip.
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>안녕 — café</text></svg>';
    expect(decodeSvgDataUrl(svgToDataUrl(markup))).toBe(markup);
  });

  test('a layer whose document is non-ASCII survives the round trip', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>안녕</text></svg>';
    const clean = sanitizeSvg(source, 'svg5')!;
    const node = {
      id: 'svg5', name: 'svg5', parent: null, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [
        { id: 'svg5_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'svg', x: 0, y: 0, width: 10, height: 10 } },
        makeSvgComponent('svg5_svg', {
          sourceMarkup: source,
          sanitizedMarkup: clean.markup,
          size: { width: clean.width, height: clean.height, viewBox: clean.viewBox },
          capabilities: scanSvgMarkup(source),
          fileName: 'k.svg',
        }),
      ],
    } as unknown as SceneNode;

    expect(decodeSvgDataUrl(snapshotOf(node).layers[0]!.src!)).toMatch(/안녕/);
  });
});
