/**
 * Solo, speed changes, and the timing operations that must carry audio.
 *
 * Solo was a picture-only switch: the renderer honoured it, sound ignored it
 * entirely. Harmless-looking while only dedicated audio layers made noise;
 * actively broken once video clips became voices, because soloing a title still
 * left the footage under it audible.
 *
 * Stretch and reverse keep audio via Web Audio playbackRate / buffer reverse
 * (varispeed). Time remap expands into piecewise rate segments. Freeze still
 * mutes — a held frame has no continuous soundtrack.
 */

import type { SceneNode } from '@core/types';

const getLayersForNode = jest.fn();
const fpsForNode = jest.fn(() => 30);
const assets: Array<{ id: string; src: string; metadata?: { duration?: number } }> = [];
const nodes: SceneNode[] = [];
const layerTimes: Record<string, { stretch?: number; reverse?: boolean; freeze?: boolean }> = {};
const remapTracks: Record<string, Array<{ t: number; value: number }>> = {};

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
  DEFAULT_LAYER_TIME: { stretch: 100, reverse: false, freeze: false, freezeTime: 0, frameBlend: 'none' },
  remapTime: (t: number, cfg: { freeze?: boolean; freezeTime?: number; stretch?: number; reverse?: boolean }, span: { start: number; end: number }) => {
    if (cfg.freeze) return cfg.freezeTime ?? 0;
    const stretch = cfg.stretch && cfg.stretch > 0 ? cfg.stretch : 100;
    let s = span.start + (t - span.start) * (100 / stretch);
    if (cfg.reverse) s = span.start + span.end - s;
    return s;
  },
}));
jest.mock('@motion/animation', () => ({
  defaultAnimation: {
    isAnimated: (id: string, prop: string) =>
      prop === 'timeRemap' && !!remapTracks[id]?.length,
    tracksFor: (id: string) =>
      remapTracks[id]?.length
        ? [{ prop: 'timeRemap', keyframes: remapTracks[id] }]
        : [],
    sample: (id: string, prop: string, t: number) => {
      const kfs = remapTracks[id];
      if (!kfs?.length || (prop !== 'timeRemap' && prop !== 'precompTime')) return undefined;
      // Linear between keys (enough for the tests).
      if (t <= kfs[0]!.t) return kfs[0]!.value;
      for (let i = 0; i < kfs.length - 1; i++) {
        const a = kfs[i]!;
        const b = kfs[i + 1]!;
        if (t <= b.t) {
          const u = (t - a.t) / (b.t - a.t || 1);
          return a.value + (b.value - a.value) * u;
        }
      }
      return kfs[kfs.length - 1]!.value;
    },
    timeSpan: () => ({ start: 0, end: 10 }),
  },
}));

import { readAudioLayers, readVideoAudioVoices, speedAltersAudio, videoAudioPlaybackRate } from './audioScene';

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

describe('stretch and reverse keep audio; remap segments; freeze mutes', () => {
  it('plays stretch via playbackRate (not muted)', () => {
    layerTimes.clip = { stretch: 50 };
    expect(speedAltersAudio(videoNode('clip'))).toBe(false);
    const v = readVideoAudioVoices(videoNode('clip'))[0]!;
    expect(v.muted).toBe(false);
    expect(v.playbackRate).toBeCloseTo(2);
    expect(videoAudioPlaybackRate(videoNode('clip'))).toBeCloseTo(2);
  });

  it('half-speed stretch is rate 0.5', () => {
    layerTimes.clip = { stretch: 200 };
    expect(readVideoAudioVoices(videoNode('clip'))[0]!.playbackRate).toBeCloseTo(0.5);
  });

  it('plays reverse (retimeReverse, not muted)', () => {
    layerTimes.clip = { reverse: true };
    const v = readVideoAudioVoices(videoNode('clip'))[0]!;
    expect(v.muted).toBe(false);
    expect(v.retimeReverse).toBe(true);
  });

  it('expands time-remap into audible varispeed segments', () => {
    // Linear remap 0→0, 2→4 over a 2s bar → rate 2.
    remapTracks.clip = [
      { t: 0, value: 0 },
      { t: 2, value: 4 },
    ];
    getLayersForNode.mockReturnValue([clip('c1', 0, 60, 0)]);
    const voices = readVideoAudioVoices(videoNode('clip'));
    expect(voices.length).toBeGreaterThanOrEqual(1);
    expect(voices.every((v) => !v.muted)).toBe(true);
    const avgRate =
      voices.reduce((s, v) => s + (v.playbackRate ?? 1) * (v.outSec - v.inSec), 0)
      / voices.reduce((s, v) => s + (v.outSec - v.inSec), 0);
    expect(avgRate).toBeCloseTo(2, 0);
  });

  it('mutes freeze frame', () => {
    layerTimes.clip = { freeze: true };
    expect(speedAltersAudio(videoNode('clip'))).toBe(true);
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
