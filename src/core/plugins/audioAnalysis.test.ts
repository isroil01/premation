/**
 * Audio analysis — reading loudness so a plugin can animate from sound.
 *
 * "Convert audio to keyframes" is one of the oldest reasons anyone writes a
 * motion-graphics plugin, and it was unreachable: a plugin could keyframe an
 * audio layer's LEVEL (that has always been an ordinary animatable property,
 * `audioLevelDb`) but had no way to find out how loud the audio actually was.
 * Driving a scale from a kick drum needs the second thing, not the first.
 *
 * The boundary being tested is what is deliberately NOT here. Peaks are a lossy
 * envelope; raw samples are not offered, because a plugin that could read PCM
 * could reconstruct the recording, and combined with `net:fetch` that is
 * exfiltration of the user's media rather than analysis of it.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { audioEngine } from '@core/audio/AudioEngine';
import { createHostApi } from './hostApi';
import { METHOD_PERMISSIONS } from './protocol';
import type { PluginManifest } from './manifest';

const manifest = {
  id: 'studio.acme.beat',
  name: 'Beat',
  version: '1.0.0',
  description: 'Animates from sound.',
  apiVersion: 2,
  main: 'main.js',
  permissions: ['audio:read'],
  activationEvents: ['onStartup'],
  contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
} as unknown as PluginManifest;

const api = createHostApi(manifest, {
  registerCommand: () => {},
  openPanel: () => {},
  closePanel: () => {},
  warn: () => {},
  granted: () => new Set(['audio:read']) as never,
});

const ASSET = 'asset_kick';

/** An audio layer pointing at `ASSET`, added straight to the graph. */
function audioLayer(id: string): string {
  defaultSceneGraph.addNode({
    id,
    name: 'Music',
    parent: null,
    children: [],
    components: [
      { id: `${id}_t`, type: 'Transform', props: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } },
      { id: `${id}_a`, type: 'Audio', props: { __assetId: ASSET, __start: 0 } },
    ],
  } as never);
  return id;
}

/** A ramp from silence to full over 2 s, so amplitude is a known function of t. */
function seedWaveform(): void {
  const buckets = 100;
  const peaks = new Float32Array(buckets);
  for (let i = 0; i < buckets; i++) peaks[i] = i / (buckets - 1);
  jest.spyOn(audioEngine, 'getWaveform').mockImplementation((id: string) =>
    (id === ASSET ? { buckets, peaks, duration: 2 } : undefined) as never);
}

beforeAll(() => {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
  seedDefaultScene();
  seedWaveform();
});

describe('reading the envelope', () => {
  it('returns the peaks, their count and the clip duration', () => {
    const id = audioLayer('aud1');
    const w = api['audio.getPeaks']!(id) as { buckets: number; duration: number; peaks: number[] };
    expect(w.buckets).toBe(100);
    expect(w.duration).toBe(2);
    expect(w.peaks).toHaveLength(100);
  });

  it('★ hands back a real Array, not a Float32Array', () => {
    // The structured clone would carry the typed array across intact, but an
    // author reaching for `.map`/`.filter` on what looks like an array should
    // get one rather than a TypedArray with different semantics.
    const id = audioLayer('aud2');
    const w = api['audio.getPeaks']!(id) as { peaks: number[] };
    expect(Array.isArray(w.peaks)).toBe(true);
  });

  it('samples the amplitude at a time', () => {
    const id = audioLayer('aud3');
    // The ramp runs 0 → 1 across 2 s, so the midpoint is around the middle.
    const mid = api['audio.getAmplitude']!(id, 1) as number;
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    expect(api['audio.getAmplitude']!(id, 0)).toBeCloseTo(0, 2);
  });

  it('reads zero outside the clip rather than throwing', () => {
    const id = audioLayer('aud4');
    expect(api['audio.getAmplitude']!(id, 99)).toBe(0);
    expect(api['audio.getAmplitude']!(id, -1)).toBe(0);
  });

  it('refuses a time that is not a number', () => {
    const id = audioLayer('aud5');
    expect(() => api['audio.getAmplitude']!(id, Number.NaN)).toThrow(/finite number/);
  });
});

describe('when there is no audio to read', () => {
  it('★ answers null rather than throwing, for a layer with no audio', () => {
    /*
      Not the plugin's mistake, and not distinguishable to it either: the layer
      may be a shape, or audio whose file has not finished decoding. Polling
      until peaks arrive is the correct shape for both, and an exception would
      make the ordinary case look like a failure.
    */
    defaultSceneGraph.addNode({
      id: 'shape9', name: 'Shape', parent: null, children: [],
      components: [{ id: 'shape9_t', type: 'Transform', props: { x: 0, y: 0 } }],
    } as never);
    expect(api['audio.getPeaks']!('shape9')).toBeNull();
    expect(api['audio.getAmplitude']!('shape9', 0)).toBeNull();
  });

  it('answers null for a layer that does not exist', () => {
    expect(api['audio.getPeaks']!('gone')).toBeNull();
  });
});

describe('the boundary', () => {
  it('★ offers no way to read raw samples', () => {
    // Peaks are lossy by construction. A verb handing back PCM would let a
    // plugin reconstruct the recording, and with `net:fetch` take it away.
    const audioVerbs = Object.keys(METHOD_PERMISSIONS).filter((k) => k.startsWith('audio.'));
    expect(audioVerbs.sort()).toEqual(['audio.getAmplitude', 'audio.getPeaks']);
  });

  it('does not ride on assets:read, which the user granted for images', () => {
    // Widening an existing permission's meaning is the one thing a permission
    // may never do — the user already decided what `assets:read` covered.
    expect(METHOD_PERMISSIONS['audio.getPeaks']).toBe('audio:read');
    expect(METHOD_PERMISSIONS['audio.getAmplitude']).toBe('audio:read');
  });

  it('leaves level and pan where they were — ordinary animatable properties', () => {
    // `audioLevelDb` is a normal track. A second way to read it would be a
    // parallel path that can disagree with `animation.sample`.
    expect(Object.keys(METHOD_PERMISSIONS)).not.toContain('audio.getLevel');
    expect(Object.keys(METHOD_PERMISSIONS)).not.toContain('audio.setLevel');
  });
});
