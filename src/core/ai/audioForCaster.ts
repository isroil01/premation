/**
 * Detect scene audio and analyse it for the caster beat grid.
 *
 * Decoding stays in the renderer (Web Audio). Analysis is pure in `@motion/audio`.
 * Decode overlaps the brief LLM call (the host passes a Promise into `runCaster`).
 */

import { analyseAudio } from '@motion/audio';
import type { AudioGrid } from '@motion/caster';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { useAssetStore } from '@stores/assetStore';

/** Skip decode on huge files — a 10-minute wav would stall the generative path. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

let cache: { key: string; grid: AudioGrid | undefined } | null = null;

export function readAudioAssetId(node: { components: { props: Record<string, unknown> }[] }): string | undefined {
  for (const c of node.components) {
    const v = c.props.__assetId ?? c.props.assetId;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * `traverse`, NOT `flattenScene` — the same fix as `core/audio/beatGrid.ts`,
 * for the same reason. On a fresh unsaved project layers hang off the VIRTUAL
 * `comp_root`, so `getRoots()` is empty and a roots-downwards walk sees no
 * layers at all. This silently cost the caster its beat grid on exactly the
 * projects most likely to be generated into: brand-new ones.
 */
function findAudioLayerId(): string | undefined {
  let found: string | undefined;
  defaultSceneGraph.traverse((n) => {
    if (found === undefined && readNodeKind(n) === 'audio') found = n.id;
  });
  return found;
}

/**
 * Analyse the first audio layer for caster timing.
 *
 * Returns undefined when there is no audio, decode fails, or tempo is unreliable.
 * Results are cached per asset+src so repeat generative prompts don't re-decode.
 */
export async function analyseSceneAudioForCaster(): Promise<AudioGrid | undefined> {
  const nodeId = findAudioLayerId();
  if (!nodeId) return undefined;

  const node = defaultSceneGraph.getNode(nodeId);
  if (!node) return undefined;

  const assetId = readAudioAssetId(node);
  const src = useAssetStore.getState().assets.find((a) => a.id === assetId)?.src;
  if (!src) return undefined;

  const key = `${assetId}:${src}`;
  if (cache?.key === key) return cache.grid;

  try {
    const res = await fetch(src);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > MAX_AUDIO_BYTES) {
      cache = { key, grid: undefined };
      return undefined;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_AUDIO_BYTES) {
      cache = { key, grid: undefined };
      return undefined;
    }

    const AudioCtor =
      (globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return undefined;

    const actx = new AudioCtor();
    void actx.suspend?.();
    const decoded = await actx.decodeAudioData(buf);
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    const a = analyseAudio(channels, decoded.sampleRate);
    void actx.close();

    const grid =
      a.tempoConfidence < 0.25 || a.beats.length < 4
        ? undefined
        : { beats: a.beats, durationSec: a.durationSec, tempoConfidence: a.tempoConfidence };
    cache = { key, grid };
    return grid;
  } catch {
    cache = { key, grid: undefined };
    return undefined;
  }
}

/** Test seam — drop the decode cache. */
export function resetAudioForCasterCache(): void {
  cache = null;
}
