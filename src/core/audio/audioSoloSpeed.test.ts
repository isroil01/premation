/**
 * Solo, speed changes, and the timing operations that must carry audio.
 *
 * Solo was a picture-only switch: the renderer honoured it, sound ignored it
 * entirely. Harmless-looking while only dedicated audio layers made noise;
 * actively broken once video clips became voices, because soloing a title still
 * left the footage under it audible.
 *
 * Speed is the known gap. Stretch, reverse and time remap retime the picture by
 * choosing a different source frame; audio would have to be RESAMPLED, which
 * needs a pitch decision and a DSP pass that does not exist. The clip's audio is
 * therefore muted with a visible reason rather than left to drift.
 */

import type { SceneNode } from '@core/types';

const getLayersForNode = jest.fn();
const fpsForNode = jest.fn(() => 30);
const assets: Array<{ id: string; src: string; metadata?: { duration?: number } }> = [];
const nodes: SceneNode[] = [];
const layerTimes: Record<string, { stretch?: number; reverse?: boolean }> = {};
const remapTracks: Record<string, boolean> = {};

jest.mock('@core/timeline/TimelineController', () => ({
  getTimelineController: () => ({ getLayersForNode, fpsForNode }),
}));
jest.mock('@stores/assetStore', () => ({ useAssetStore: { getState: () => ({ assets }) } }));
jest.mock('@core/api/client', () => ({ assetUrl: (s: string) => s }));
jest.mock('@core/scene/DefaultSceneGraph', () => ({ __esModule: true, default: {} }));
jest.mock('@core/scene/sceneDerive', () => ({
  flattenScene: () => nodes,
  readNodeKind: (n: SceneNode) =>
    (n.components[0]?.props as Record<string, unknown> | undefined)?.__kind ?? 'shape',
}));
jest.mock('@core/scene/layerTime', () => ({
  readNodeLayerTime: (n: SceneNode) => layerTimes[n.id],
}));
jest.mock('@motion/animation', () => ({
  defaultAnimation: {
    tracksFor: (id: string) =>
      remapTracks[id] ? [{ prop: 'timeRemap', keyframes: [{ t: 0, value: 0 }] }] : [],
    sample: () => undefined,
  },
}));

import { readAudioLayers, readVideoAudioVoices, speedAltersAudio } from './audioScene';

function videoNode(id: string, over: Partial<SceneNode> = {}): SceneNode {
  return {
    id, name: id, visible: true,
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: 'video', assetId: 'a1', src: 'blob:c.mp4' } }],
    ...over,
  } as unknown as SceneNode;
}

function audioNode(id: string, over: Partial<SceneNode> = {}): SceneNode {
  return {
    id, name: id, visible: true,
    components: [{
      id: `${id}_a`, type: 'Audio',
      props: { __kind: 'audio', __assetId: 'a2', __src: 'blob:m.mp3', __out: 8, __duration: 8 },
    }],
    ...over,
  } as unknown as SceneNode;
}

const clip = (id: string, start: number, duration: number, sourceIn = 0) => ({
  id, enabled: true, clip: { start, duration, sourceIn },
});

beforeEach(() => {
  getLayersForNode.mockReset().mockReturnValue([]);
  fpsForNode.mockReset().mockReturnValue(30);
  assets.length = 0;
  nodes.length = 0;
  for (const k of Object.keys(layerTimes)) delete layerTimes[k];
  for (const k of Object.keys(remapTracks)) delete remapTracks[k];
});

describe('solo covers video-clip voices', () => {
  it('silences a video clip when another layer is soloed', () => {
    nodes.push(audioNode('music', { solo: true } as Partial<SceneNode>), videoNode('clip'));
    const byNode = Object.fromEntries(readAudioLayers().map((l) => [l.nodeId, l]));
    expect(byNode.music!.muted).toBe(false);
    expect(byNode.clip!.muted).toBe(true);
  });

  it('keeps a soloed VIDEO layer audible and silences the music', () => {
    nodes.push(audioNode('music'), videoNode('clip', { solo: true } as Partial<SceneNode>));
    const byNode = Object.fromEntries(readAudioLayers().map((l) => [l.nodeId, l]));
    expect(byNode.clip!.muted).toBe(false);
    expect(byNode.music!.muted).toBe(true);
  });

  it('changes nothing when no layer is soloed', () => {
    nodes.push(audioNode('music'), videoNode('clip'));
    expect(readAudioLayers().every((l) => !l.muted)).toBe(true);
  });

  it('keeps soloed-out voices in the list, muted rather than dropped', () => {
    // The waveform, decode cache and inspector still need to see them.
    nodes.push(audioNode('music', { solo: true } as Partial<SceneNode>), videoNode('clip'));
    expect(readAudioLayers()).toHaveLength(2);
  });
});

describe('speed changes mute the clip audio', () => {
  it('detects time stretch', () => {
    layerTimes.clip = { stretch: 50 };
    expect(speedAltersAudio(videoNode('clip'))).toBe(true);
    expect(readVideoAudioVoices(videoNode('clip'))[0]!.muted).toBe(true);
  });

  it('detects reverse', () => {
    layerTimes.clip = { reverse: true };
    expect(readVideoAudioVoices(videoNode('clip'))[0]!.muted).toBe(true);
  });

  it('detects time-remap keyframes', () => {
    remapTracks.clip = true;
    expect(readVideoAudioVoices(videoNode('clip'))[0]!.muted).toBe(true);
  });

  it('leaves audio alone at 100% stretch', () => {
    layerTimes.clip = { stretch: 100 };
    expect(speedAltersAudio(videoNode('clip'))).toBe(false);
    expect(readVideoAudioVoices(videoNode('clip'))[0]!.muted).toBe(false);
  });
});

describe('timing operations carry the audio (source-direct, so structurally)', () => {
  it('splitting at frame N gives two voices with the correct source ranges', () => {
    // Split a 0-120f bar at frame 60: [0,60) reading source 0, and [60,120)
    // reading source 60. Both halves must play their OWN part of the file.
    getLayersForNode.mockReturnValue([clip('c1', 0, 60, 0), clip('c2', 60, 60, 60)]);
    const voices = readVideoAudioVoices(videoNode('clip'));
    expect(voices).toHaveLength(2);
    expect(voices[0]).toMatchObject({ startSec: 0, inSec: 0, outSec: 2 });
    expect(voices[1]).toMatchObject({ startSec: 2, inSec: 2, outSec: 4 });
  });

  it('trimming in by N frames starts the audio at the same source time as the picture', () => {
    // Bar trimmed to start 45 frames (1.5s) into the source, placed at 1s.
    getLayersForNode.mockReturnValue([clip('c1', 30, 90, 45)]);
    const [v] = readVideoAudioVoices(videoNode('clip'));
    expect(v).toMatchObject({ startSec: 1, inSec: 1.5, outSec: 4.5 });
  });

  it('moving the bar moves the audio with it', () => {
    getLayersForNode.mockReturnValue([clip('c1', 150, 60, 0)]);
    expect(readVideoAudioVoices(videoNode('clip'))[0]).toMatchObject({ startSec: 5, inSec: 0 });
  });
});
