/**
 * Per-layer quality (AE's Quality/Sampling switch). 'best' bilinear-samples;
 * 'draft' samples nearest-neighbour for a faster, rougher preview of that
 * layer. Stored on the `fx` component like the other per-layer switches.
 *
 * WHERE IT IS ACTUALLY READ. This docstring used to claim "the renderer reads
 * it to toggle `imageSmoothingEnabled`", and no such reader existed — every
 * `imageSmoothingEnabled` site in the repo hardcodes `true`. Meanwhile the
 * value WAS folded into the content hash, so toggling the switch invalidated
 * the layer's cached texture and re-rasterized a byte-identical image. Strictly
 * worse than the field not existing.
 *
 * The real chain, as of the wiring-audit fix:
 *   buildSnapshot        → RenderLayer.quality
 *   snapshotToFrameScene → Renderable.sampling = 'nearest'
 *   CompositionPass      → nearest-clamp sampler instead of linear-clamp
 *
 * `src/core/rendering/__tests__/contentHashReaders.test.ts` fails if any
 * content-hash field loses its reader again, this one included.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import type { SceneNode } from '@core/types';

export type LayerQuality = 'best' | 'draft';

/** Read a layer's quality (defaults to 'best' — absent means antialiased). */
export function readNodeQuality(node: SceneNode): LayerQuality {
  const fx = node.components.find((c) => c.type === 'fx');
  return fx?.props.quality === 'draft' ? 'draft' : 'best';
}

export function getNodeQuality(nodeId: string): LayerQuality {
  const node = defaultSceneGraph.getNode(nodeId);
  return node ? readNodeQuality(node) : 'best';
}

export function setNodeQuality(nodeId: string, quality: LayerQuality): void {
  // Store only the non-default 'draft' so the common case adds nothing to file.
  defaultSceneGraph.setLayerQuality(nodeId, quality === 'draft' ? 'draft' : undefined);
  getEventBus().emit('AnimationChanged', { nodeId });
}

export function toggleNodeQuality(nodeId: string): void {
  setNodeQuality(nodeId, getNodeQuality(nodeId) === 'draft' ? 'best' : 'draft');
}
