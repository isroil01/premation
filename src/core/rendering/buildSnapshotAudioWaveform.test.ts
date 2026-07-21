/**
 * Integration: a shape carrying an `audioWaveform` block that references an audio
 * layer produces real path geometry through buildSnapshot, deterministically —
 * and draws nothing (degenerate path) when the source audio isn't decoded.
 *
 * The generator looks the source up via the `defaultSceneGraph` singleton (the
 * same graph the app renders), so this test builds into that singleton and
 * passes it to buildSnapshot. Peaks are injected via the test seam so no Web
 * Audio is needed.
 */

import { buildSnapshot } from './buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { __setWaveProviderForTest, defaultAudioWaveform } from '@core/audio/audioWaveformGen';
import type { WaveformPeaks } from '@core/audio/waveform';

const COMP = { width: 800, height: 600, background: '#101014' };

const WAVE: WaveformPeaks = {
  buckets: 8,
  peaks: new Float32Array([0, 0.3, 0.6, 0.9, 1, 0.7, 0.4, 0.1]),
  duration: 2,
};

function audioNode(id: string, assetId: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'audio', x: 0, y: 0 } },
      { id: `${id}_a`, type: 'Audio', props: { __assetId: assetId, __src: 'blob:x', __duration: 2, __start: 0 } },
    ],
  } as unknown as SceneNode;
}

function waveShape(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, width: 400, height: 200 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

function snap() {
  return buildSnapshot(defaultSceneGraph, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, COMP).layers;
}

describe('buildSnapshot — audio waveform generator', () => {
  beforeEach(() => {
    defaultSceneGraph.clear();
    __setWaveProviderForTest();
  });
  afterEach(() => {
    defaultSceneGraph.clear();
    __setWaveProviderForTest();
  });

  it('turns the shape into a non-empty waveform path when peaks are available', () => {
    defaultSceneGraph.addNode(audioNode('aud1', 'asset1'));
    defaultSceneGraph.addNode(waveShape('wave1'));
    defaultSceneGraph.setAudioWaveform('wave1', { ...defaultAudioWaveform('aud1'), samples: 64, thickness: 0 });
    __setWaveProviderForTest((assetId) => (assetId === 'asset1' ? WAVE : undefined));

    const layer = snap().find((l) => l.id === 'wave1')!;
    expect(layer.primitive).toBe('path');
    // 2·samples points (mirrored outline).
    expect(layer.pathPoints).toHaveLength(128);
    // Real geometry — at least one column rises off the midline.
    expect(layer.pathPoints!.some((p) => Math.abs(p.y) > 1)).toBe(true);
  });

  it('is deterministic — same scene renders identical geometry twice', () => {
    defaultSceneGraph.addNode(audioNode('aud1', 'asset1'));
    defaultSceneGraph.addNode(waveShape('wave1'));
    defaultSceneGraph.setAudioWaveform('wave1', { ...defaultAudioWaveform('aud1'), samples: 40 });
    __setWaveProviderForTest((assetId) => (assetId === 'asset1' ? WAVE : undefined));

    const a = snap().find((l) => l.id === 'wave1')!.pathPoints;
    const b = snap().find((l) => l.id === 'wave1')!.pathPoints;
    expect(a).toEqual(b);
  });

  it('renders a degenerate (draw-nothing) path when the source is not decoded', () => {
    defaultSceneGraph.addNode(audioNode('aud1', 'asset1'));
    defaultSceneGraph.addNode(waveShape('wave1'));
    defaultSceneGraph.setAudioWaveform('wave1', defaultAudioWaveform('aud1'));
    // provider returns undefined → not decoded
    __setWaveProviderForTest(() => undefined);

    const layer = snap().find((l) => l.id === 'wave1')!;
    expect(layer.primitive).toBe('path');
    expect(layer.pathPoints).toHaveLength(2); // zero-area placeholder
    expect(layer.pathPoints!.every((p) => p.x === 0 && p.y === 0)).toBe(true);
  });

  it('renders a degenerate path when the source layer id is dangling', () => {
    defaultSceneGraph.addNode(waveShape('wave1'));
    defaultSceneGraph.setAudioWaveform('wave1', defaultAudioWaveform('does-not-exist'));
    __setWaveProviderForTest((assetId) => (assetId === 'asset1' ? WAVE : undefined));

    const layer = snap().find((l) => l.id === 'wave1')!;
    expect(layer.pathPoints).toHaveLength(2);
  });
});
