/**
 * An SVG document layer as an ENGINE CLIENT fragment: the markup sanitized in
 * the page (DOMPurify + id scoping, svgSanitize.ts — content preparation, not
 * document state) and the layer laid into a {@link FragmentBuilder}, sent as
 * ONE `pasteLayers`. The same layer sceneInsert.ts `insertSvgLayer` builds
 * off-document (pinned by svgFragment.test.ts): the `svg` kind Transform
 * sized by `placeInComp`'s rule, a Style, the `svg` component (source +
 * sanitized markup, intrinsic size, capabilities), continuous
 * rasterization on.
 */

import { scanSvgCapabilities, svgCapabilityWarnings, type SvgCapabilities } from '@core/svg/svgCapabilities';
import { sanitizeSvg } from '@core/svg/svgSanitize';
import { makeSvgComponent } from '@core/svg/svgLayer';
import { FragmentBuilder, KIND_PROP, type BuiltFragment } from './fragmentBuilder';

export interface SvgLayerFragmentOptions {
  /** The target composition's size (the layer is sized to ~28% of its shorter edge, as every menu insert). */
  compWidth: number;
  compHeight: number;
  /** Where the layer lands (default: the comp centre). */
  x?: number;
  y?: number;
  /** The router's scan, when it already made one (one parse per import). */
  capabilities?: SvgCapabilities;
  /** A document the Live SVG path plays time-rasterized. */
  livePlayback?: boolean;
  idPrefix?: string;
}

export interface SvgLayerFragment {
  built: BuiltFragment;
  /** The scratch id of the layer (the ids in its sanitized markup are scoped to it). */
  layer: string;
  /** What sanitizing removed / what will not animate (the import toast). */
  warnings: string[];
}

/** sceneInsert.ts placeInComp's size rule for a `customW × customH` source. */
function placedSize(w: number, h: number, compW: number, compH: number): { width: number; height: number } {
  const target = Math.max(240, Math.min(960, Math.round(Math.min(compW, compH) * 0.28)));
  let width = w > 0 ? w : target;
  let height = h > 0 ? h : target;
  if (width < 220 && height < 220) {
    const aspect = (width / height) || 1;
    if (aspect >= 1) {
      width = target;
      height = Math.round(target / aspect);
    } else {
      height = target;
      width = Math.round(target * aspect);
    }
  }
  return { width, height };
}

/** The layer, or null when the markup cannot be read (the sanitizer refused it). */
export function buildSvgLayerFragment(svgText: string, name: string, opts: SvgLayerFragmentOptions): SvgLayerFragment | null {
  const b = new FragmentBuilder({ idPrefix: opts.idPrefix ?? 'svg' });
  const id = b.newId('svg');
  const capabilities = opts.capabilities ?? scanSvgCapabilities(new DOMParser().parseFromString(svgText, 'image/svg+xml'));
  // Ids baked into the stored markup are scoped to the layer id (stable for
  // the layer's life — the texture cache keys on the markup).
  const clean = sanitizeSvg(svgText, id.replace(/[^\w-]/g, '_'), capabilities);
  if (!clean) return null;
  const { width, height } = placedSize(clean.width, clean.height, opts.compWidth, opts.compHeight);
  const x = opts.x ?? opts.compWidth / 2;
  const y = opts.y ?? opts.compHeight / 2;
  b.addChild(null, {
    id,
    name,
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [KIND_PROP]: 'svg', x, y, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0, width, height },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100 } },
      makeSvgComponent(`${id}_svg`, {
        sourceMarkup: svgText,
        sanitizedMarkup: clean.markup,
        size: { width: clean.width, height: clean.height, viewBox: clean.viewBox },
        capabilities,
        fileName: name,
        livePlayback: opts.livePlayback === true,
      }),
    ],
  });
  // A vector layer rasterizes continuously (continuousRaster.ts).
  b.setFx(id, 'continuousRasterize', true);
  const built = b.build();
  if (!built) return null;
  return { built, layer: id, warnings: svgCapabilityWarnings(capabilities) };
}
