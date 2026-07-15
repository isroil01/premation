/**
 * audioScene (Prompt 8) — read audio layers out of the scene graph as the flat
 * {@link AudioLayerState} list the {@link AudioEngine} needs. Kept separate so
 * both the playback hook and the inspector can share one derivation.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { flattenScene, readNodeKind } from '@core/scene/sceneDerive';
import type { SceneNode } from '@core/types';
import { assetUrl } from '@core/api/client';
import { useAssetStore } from '@stores/assetStore';
import type { AudioLayerState } from './AudioEngine';

interface CompRef {
  id: string;
  props: Record<string, unknown>;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** The `Audio` data component carrying the asset ref + level/trim. */
export function audioComponent(node: SceneNode): CompRef | undefined {
  return node.components.find((c) => c.type === 'Audio') as CompRef | undefined;
}

/** True when the node is an audio layer. */
export function isAudioNode(node: SceneNode): boolean {
  return readNodeKind(node) === 'audio' && audioComponent(node) !== undefined;
}

/** Read one audio node into transport state (null when it lacks a usable src). */
export function readAudioLayer(node: SceneNode): AudioLayerState | null {
  const a = audioComponent(node);
  if (!a) return null;
  const p = a.props;
  const assetId = typeof p.__assetId === 'string' ? p.__assetId : '';
  let src = typeof p.__src === 'string' ? assetUrl(p.__src) : '';
  if (assetId) {
    const asset = useAssetStore.getState().assets.find((a) => a.id === assetId);
    if (asset && asset.src) {
      src = asset.src;
    }
  }
  if (!src || !assetId) return null;
  const duration = num(p.__duration) ?? 0;
  return {
    nodeId: node.id,
    assetId,
    src,
    level: num(p.__level) ?? 100,
    startSec: num(p.__start) ?? 0,
    inSec: num(p.__in) ?? 0,
    outSec: num(p.__out) ?? duration,
    muted: node.visible === false || p.__muted === true,
  };
}

/** All audio layers currently in the scene. */
export function readAudioLayers(): AudioLayerState[] {
  const out: AudioLayerState[] = [];
  for (const node of flattenScene(defaultSceneGraph)) {
    if (readNodeKind(node) !== 'audio') continue;
    const layer = readAudioLayer(node);
    if (layer) out.push(layer);
  }
  return out;
}
