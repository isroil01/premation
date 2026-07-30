/**
 * SVG-layer scenes (§10 golden-image suite).
 *
 * Each corpus file yields TWO scenes rendered through the identical pipeline:
 *
 *   svg-<name>       the real SVG LAYER — sanitized, id-scoped, viewBox-backfilled
 *   svg-<name>-src   the SAME file, untouched, as a plain image layer
 *
 * The second is not a test in its own right; it is the *oracle*. `svg-<name>`
 * declares `fidelityTwin: 'svg-<name>-src'`, and the runner gates the diff
 * between the two at <1%.
 *
 * That is the difference between this suite and a normal golden-frame family.
 * A committed reference PNG is blessed from our own output, so if id scoping or
 * the viewBox backfill were broken TODAY we would bless the broken pixels and
 * the suite would happily guard the bug forever. Diffing against the untouched
 * source instead asks the only question that matters — "did our pipeline change
 * this file's pixels?" — and it can answer it on day one, with no human
 * eyeballing and nothing to re-bless.
 *
 * Both layers reach the compositor through the same `rasterizeSvg` in
 * AppTextureProvider, so any difference is attributable to what we store, not
 * to how it is drawn.
 */

import { defineScene, node, type Scene } from '../sceneKit';
import { SVG_CORPUS, type SvgCorpusEntry } from './svgCorpus';
import { sanitizeSvg, svgToDataUrl } from '@core/svg/svgSanitize';
import { makeSvgComponent } from '@core/svg/svgLayer';
import { scanSvgMarkup } from '@core/svg/svgCapabilities';

/** Uniform stage: one 200×200 layer centred in a 240×240 comp. */
const SIZE = 200;
const COMP = { width: 240, height: 240, background: '#101014' };

/** The real thing: a layer built exactly the way `insertSvgLayer` builds one. */
function svgLayerScene(entry: SvgCorpusEntry): Scene {
  const id = `svg-${entry.name}`;
  return defineScene({
    id,
    description: `SVG layer — ${entry.description}`,
    size: { w: COMP.width, h: COMP.height },
    comp: COMP,
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    fidelityTwin: `${id}-src`,
    fidelityTolerance: entry.fidelityTolerance,
    fidelityException: entry.exception,
    tolerance: entry.tolerance,
    build(graph) {
      // Scope on the NODE id, as the importer does — so the scene also proves
      // the scoped document is what actually renders.
      const clean = sanitizeSvg(entry.markup, id.replace(/[^\w-]/g, '_'));
      if (!clean) throw new Error(`corpus entry "${entry.name}" did not survive sanitization`);
      graph.addNode(
        node(id, {
          kind: 'svg',
          position: { x: COMP.width / 2, y: COMP.height / 2 },
          transform: { width: SIZE, height: SIZE },
          style: { opacity: 100 },
          components: [
            makeSvgComponent(`${id}_svg`, {
              sourceMarkup: entry.markup,
              sanitizedMarkup: clean.markup,
              size: { width: clean.width, height: clean.height, viewBox: clean.viewBox },
              capabilities: scanSvgMarkup(entry.markup),
              fileName: `${entry.name}.svg`,
            }),
          ],
        }),
      );
    },
  });
}

/** The oracle: the untouched file, drawn as an ordinary image layer. */
function sourceScene(entry: SvgCorpusEntry): Scene {
  const id = `svg-${entry.name}-src`;
  return defineScene({
    id,
    description: `Untouched source (fidelity oracle) — ${entry.description}`,
    size: { w: COMP.width, h: COMP.height },
    comp: COMP,
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    // Rendered as an oracle only: it has no committed reference of its own, so
    // the reference gate must skip it or every run would fail on a missing PNG.
    fidelityOnly: true,
    build(graph) {
      graph.addNode(
        node(id, {
          kind: 'image',
          position: { x: COMP.width / 2, y: COMP.height / 2 },
          transform: { width: SIZE, height: SIZE, src: svgToDataUrl(entry.markup) },
          style: { opacity: 100 },
        }),
      );
    },
  });
}

export const svgScenes: Scene[] = SVG_CORPUS.flatMap((entry) => [
  svgLayerScene(entry),
  sourceScene(entry),
]);
