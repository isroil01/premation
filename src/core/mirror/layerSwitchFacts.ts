/**
 * The timeline's Collapse / Quality / Frame Blending switches and "Select
 * Label Group" over the document MIRROR (B4) — the twins of
 * `layerFlags.collapseSwitchKind` / `layerFlagAvailable` and
 * `labelColor.nodesWithLabelColor`. Pure: they take a mirror reader and never
 * touch the engine.
 *
 * The switch VALUES are the layer's `LayerSwitches` (`collapse`, `quality`,
 * `frameBlend`); what is decided here is whether a layer HAS the switch:
 *
 *   collapse    a placed composition (Collapse Transformations) or a vector
 *               layer (Continuous Rasterize, `mirrorSupportsContinuousRaster`)
 *   quality     anything with pixels to sample (not null / camera / light /
 *               audio / group — a nested precomp group has pixels)
 *   frameBlend  a layer with source frames: video, or a composition
 */

import type { LayerInfo } from '@motion/engine-api';
import { uiKindOf } from './layerKinds';
import { mirrorLabelColor } from './layerLabels';
import { mirrorSupportsContinuousRaster } from './continuousRaster';
import type { MirrorFieldRead } from './layerFields';
import type { LayerFlag } from '@core/scene/layerFlags';
import { mirrorCanBe3D } from './layerFacts';

export type MirrorSwitch = 'collapse' | 'quality' | 'frameBlend';

/** What the sunburst means on this layer, or null when it means nothing (the twin of `collapseSwitchKind`). */
export function mirrorCollapseSwitchKind(m: Pick<MirrorFieldRead, 'layer' | 'property' | 'tree'>, id: string): 'collapse' | 'raster' | null {
  const layer = m.layer(id);
  if (!layer) return null;
  if (uiKindOf(layer) === 'comp') return 'collapse';
  return mirrorSupportsContinuousRaster(m, id) ? 'raster' : null;
}

const NO_PIXELS = new Set(['null', 'camera', 'light', 'audio', 'group']);

/** Whether the layer has this switch at all (the twin of `layerFlagAvailable` for the three timeline switches). */
export function mirrorSwitchAvailable(m: Pick<MirrorFieldRead, 'layer' | 'property' | 'tree'>, id: string, flag: MirrorSwitch): boolean {
  const layer = m.layer(id);
  if (!layer) return false;
  const kind = uiKindOf(layer);
  // A legacy nested precomp group (API kind `precomp`, no source item) is a composition.
  const precomp = layer.kind === 'precomp';
  switch (flag) {
    case 'collapse': return mirrorCollapseSwitchKind(m, id) !== null;
    case 'frameBlend': return kind === 'video' || precomp;
    case 'quality': return precomp || !NO_PIXELS.has(kind ?? '');
    default: return false;
  }
}

/** Whether the layer's Frame Blending switch is on (any mode). */
export function frameBlendOn(layer: Pick<LayerInfo, 'switches'> | undefined): boolean {
  return !!layer && layer.switches.frameBlend !== 'off';
}

/**
 * Every layer carrying the same label colour as `id` (the twin of
 * `nodesWithLabelColor`, "Select Label Group"). Unlabelled matches unlabelled.
 * [] when the layer is gone.
 */
export function mirrorLayersWithLabel(m: { layer(id: string): LayerInfo | undefined; layerIds(): readonly string[] }, id: string): string[] {
  const layer = m.layer(id);
  if (!layer) return [];
  const color = mirrorLabelColor(layer);
  return m.layerIds().filter((l) => mirrorLabelColor(m.layer(l)) === color);
}

/**
 * Whether one AE switch-column flag is set on a layer — the twin of
 * `layerFlags.readLayerFlag`, off the layer's `LayerSwitches`. A cycling switch
 * (Quality) is "on" when it is off its default (`best`).
 */
export function mirrorLayerFlag(layer: Pick<LayerInfo, 'switches'> | undefined, flag: LayerFlag): boolean {
  if (!layer) return false;
  const s = layer.switches;
  switch (flag) {
    case 'threeD': return s.threeD;
    case 'guide': return s.guide;
    case 'motionBlur': return s.motionBlur;
    case 'adjustment': return s.adjustment;
    case 'preserveTransparency': return s.preserveTransparency;
    case 'fxEnabled': return s.effectsEnabled;
    case 'shy': return s.shy;
    case 'collapse': return s.collapse;
    case 'frameBlend': return frameBlendOn(layer);
    case 'quality': return s.quality !== 'best';
  }
}

/**
 * Whether a layer has this switch at all — the twin of `layerFlags.layerFlagAvailable`
 * (a composition's root is not a layer, so it has none).
 */
export function mirrorLayerFlagAvailable(m: Pick<MirrorFieldRead, 'layer' | 'property' | 'tree'>, id: string, flag: LayerFlag): boolean {
  const layer = m.layer(id);
  if (!layer) return false;
  switch (flag) {
    case 'threeD': return mirrorCanBe3D(layer, m.tree(id));
    case 'collapse':
    case 'frameBlend':
    case 'quality': return mirrorSwitchAvailable(m, id, flag);
    default: return true;
  }
}
