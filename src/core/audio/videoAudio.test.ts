/**
 * A video layer's own audio track.
 *
 * Regression guard for the bug where importing an `.mp4` gave picture only:
 * the `<video>` elements the renderer scrubs are hard-muted (they are seeked,
 * not played) and nothing else ever looked at the file's audio, so every video
 * import silently dropped its sound in both preview and export.
 *
 * Video layers are now read into the SAME voice list as audio layers, so they
 * inherit clip-bar timing, gain, mute and the export mixdown.
 */

import type { SceneNode } from '@core/types';

const getLayersForNode = jest.fn();
const fpsForNode = jest.fn(() => 30);
const assets: Array<{ id: string; src: string; metadata?: { duration?: number } }> = [];
const nodes: SceneNode[] = [];

jest.mock('@core/timeline/TimelineController', () => ({
  getTimelineController: () => ({ getLayersForNode, fpsForNode }),
}));
jest.mock('@stores/assetStore', () => ({
  useAssetStore: { getState: () => ({ assets }) },
}));
jest.mock('@core/api/client', () => ({ assetUrl: (s: string) => s }));
jest.mock('@core/scene/DefaultSceneGraph', () => ({ __esModule: true, default: {} }));
jest.mock('@core/scene/sceneDerive', () => ({
  flattenScene: () => nodes,
  readNodeKind: (n: SceneNode) =>
    (n.components[0]?.props as Record<string, unknown> | undefined)?.__kind ?? 'shape',
}));

import { readVideoAudioVoices, readAudioLayers } from './audioScene';

/** A video layer as the importer builds it: kind + asset on the Transform. */
function videoNode(props: Record<string, unknown> = {}, id = 'vid1'): SceneNode {
  return {
    id,
    name: 'Clip',
    visible: true,
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { __kind: 'video', assetId: 'asset1', src: 'blob:clip.mp4', ...props },
      },
    ],
  } as unknown as SceneNode;
}

function clip(id: string, start: number, duration: number, sourceIn = 0, enabled = true) {
  return { id, enabled, clip: { start, duration, sourceIn } };
}

beforeEach(() => {
  getLayersForNode.mockReset().mockReturnValue([]);
  fpsForNode.mockReset().mockReturnValue(30);
  assets.length = 0;
  nodes.length = 0;
});

describe('readVideoAudioVoices', () => {
  it('yields a voice for a video layer, so its audio track is heard at all', () => {
    const voices = readVideoAudioVoices(videoNode());
    expect(voices).toHaveLength(1);
    expect(voices[0]).toMatchObject({ nodeId: 'vid1', assetId: 'asset1', src: 'blob:clip.mp4', levelDb: 0 });
  });

  it('takes timing from the clip bar, so trimming the bar trims the sound', () => {
    // Bar starts at frame 60 (2s), runs 60 frames (2s), reading from source
    // frame 30 (1s) — the picture's trim, which the audio must match exactly.
    getLayersForNode.mockReturnValue([clip('c1', 60, 60, 30)]);
    const [v] = readVideoAudioVoices(videoNode());
    expect(v).toMatchObject({ startSec: 2, inSec: 1, outSec: 3 });
  });

  it('a split bar yields one independently-keyed voice per clip', () => {
    getLayersForNode.mockReturnValue([clip('c1', 0, 30, 0), clip('c2', 150, 30, 30)]);
    const voices = readVideoAudioVoices(videoNode());
    expect(voices.map((v) => v.id)).toEqual(['c1', 'c2']);
    expect(voices[1]).toMatchObject({ startSec: 5, inSec: 1 });
  });

  it('honours the per-layer level and mute', () => {
    // Legacy percent is migrated, not reinterpreted: 40% is about -8 dB, not
    // +40 dB. Reading it as dB would make every existing project deafening.
    const [v] = readVideoAudioVoices(videoNode({ audioLevel: 40, audioMuted: true }));
    expect(v!.levelDb).toBeCloseTo(-7.96, 1);
    expect(v!.muted).toBe(true);
  });

  it('prefers an explicit dB level over the legacy percent', () => {
    const [v] = readVideoAudioVoices(videoNode({ audioLevel: 40, audioLevelDb: -3 }));
    expect(v!.levelDb).toBe(-3);
  });

  it('a hidden video layer is silent, like a hidden audio layer', () => {
    const n = videoNode();
    (n as { visible: boolean }).visible = false;
    expect(readVideoAudioVoices(n)[0]!.muted).toBe(true);
  });

  it('a disabled clip is muted', () => {
    getLayersForNode.mockReturnValue([clip('c1', 0, 30, 0, false)]);
    expect(readVideoAudioVoices(videoNode())[0]!.muted).toBe(true);
  });

  it('prefers the library asset URL over the stored src, so a relink sounds', () => {
    assets.push({ id: 'asset1', src: 'blob:relinked.mp4', metadata: { duration: 12 } });
    const [v] = readVideoAudioVoices(videoNode());
    expect(v).toMatchObject({ src: 'blob:relinked.mp4', outSec: 12 });
  });

  it('yields nothing when the layer has no resolvable asset', () => {
    expect(readVideoAudioVoices(videoNode({ assetId: undefined, src: undefined }))).toEqual([]);
  });
});

describe('readAudioLayers — both kinds reach the transport', () => {
  it('includes video layers alongside audio layers', () => {
    nodes.push(videoNode({}, 'vid1'), {
      id: 'aud1',
      name: 'Music',
      visible: true,
      components: [
        {
          id: 'aud1_a',
          type: 'Audio',
          props: { __kind: 'audio', __assetId: 'asset2', __src: 'blob:music.mp3', __out: 8, __duration: 8 },
        },
      ],
    } as unknown as SceneNode);

    const layers = readAudioLayers();
    expect(layers.map((l) => l.nodeId).sort()).toEqual(['aud1', 'vid1']);
  });
});
