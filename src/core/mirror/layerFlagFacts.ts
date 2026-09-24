/**
 * The AE switch column (`core/scene/layerFlags.ts`'s three questions) over the
 * document MIRROR (B4) — for the Layers panel's row switches and its context
 * menu. Pure: they take a mirror reader and never touch the engine.
 *
 *   mirrorLayerFlagOn(layer, flag)            is it on? (`readLayerFlag`)
 *   mirrorLayerFlagAvailable(m, id, flag)     can this layer carry it? (`layerFlagAvailable`)
 *   mirrorDescribeLayerFlag(m, id, flag)      what the switch is called on it (`describeLayerFlag`)
 *   mirrorLayerHasAudio(layer)                does it make sound? (the timeline's A/V test)
 *
 * The values are the layer's `LayerSwitches`, which the engine derives from
 * `readLayerFlag` itself (engine/model.ts `layerSwitches`), so they agree by
 * construction.
 */

import type { LayerInfo } from '@motion/engine-api';
import { COLLAPSE_FACE, QUALITY_FACE, layerFlagDef, type LayerFlag, type LayerFlagFace } from '@core/scene/layerFlags';
import { uiKindOf } from './layerKinds';
import { mirrorCanBe3D } from './layerFacts';
import { mirrorCollapseSwitchKind, mirrorSwitchAvailable } from './layerSwitchFacts';
import type { MirrorFieldRead } from './layerFields';

type FlagRead = Pick<MirrorFieldRead, 'layer' | 'property' | 'tree'>;

/** Is `flag` on for this layer? (false for a layer the mirror does not have) */
export function mirrorLayerFlagOn(layer: Pick<LayerInfo, 'switches'> | undefined, flag: LayerFlag): boolean {
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
    case 'frameBlend': return s.frameBlend !== 'off';
    case 'quality': return s.quality !== 'best';
  }
}

/**
 * Can this layer carry `flag` at all? A composition (not a layer — the mirror
 * has no layer for it) carries none.
 */
export function mirrorLayerFlagAvailable(m: FlagRead, id: string, flag: LayerFlag): boolean {
  const layer = m.layer(id);
  if (!layer) return false;
  switch (flag) {
    case 'threeD': return mirrorCanBe3D(layer, m.tree(id));
    case 'collapse':
    case 'frameBlend':
    case 'quality':
      return mirrorSwitchAvailable(m, id, flag);
    default: return true;
  }
}

/** How the switch reads on this layer: the sunburst's meaning, Quality's position, else the static face. */
export function mirrorDescribeLayerFlag(m: FlagRead, id: string, flag: LayerFlag): LayerFlagFace {
  if (flag === 'collapse') return COLLAPSE_FACE[mirrorCollapseSwitchKind(m, id) === 'collapse' ? 'collapse' : 'raster'];
  if (flag === 'quality') return QUALITY_FACE[m.layer(id)?.switches.quality ?? 'best'];
  const def = layerFlagDef(flag);
  return { label: def.label, title: def.title, icon: def.icon, glyph: def.glyph };
}

/** Does this layer make sound? An audio layer, or a video whose source has an audio track. */
export function mirrorLayerHasAudio(layer: Pick<LayerInfo, 'kind' | 'source' | 'hasAudio'> | undefined): boolean {
  if (!layer) return false;
  const kind = uiKindOf(layer);
  return kind === 'audio' || (kind === 'video' && layer.hasAudio);
}
