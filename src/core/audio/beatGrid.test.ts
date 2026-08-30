/**
 * The beat grid's judgement calls, which are all in the pure half.
 *
 * The DSP belongs to `@motion/audio` and is tested there; the decode needs a
 * real AudioContext and is exercised in the app. What is tested here is what
 * happens at the edges — when the music runs out before the layers do, when
 * the playhead is past every beat, and when there is barely a grid at all —
 * because those are the paths that silently animate the wrong number of layers
 * or stack them all on one frame.
 */

import { beatsForLayers, everyNthBeat, findAudioLayer } from './beatGrid';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';

/** A steady grid at 120 BPM (0.5s per beat), starting at `from`. */
const steady = (count: number, from = 0, interval = 0.5): number[] =>
  Array.from({ length: count }, (_, i) => from + i * interval);

describe('beatsForLayers', () => {
  it('takes the beats at and after the playhead', () => {
    const beats = steady(10); // 0, 0.5, 1.0, ...
    expect(beatsForLayers(beats, 1.0, 3)).toEqual([1, 1.5, 2]);
  });

  it('counts a beat exactly under the playhead as upcoming', () => {
    // Landing the playhead on a beat and being given the NEXT one is the
    // classic off-by-one: the user parked on the downbeat deliberately.
    expect(beatsForLayers(steady(6), 1.5, 2)).toEqual([1.5, 2]);
  });

  it('tolerates floating-point drift at the boundary', () => {
    const beats = [0.1 + 0.2]; // 0.30000000000000004
    expect(beatsForLayers(beats, 0.3, 1)).toEqual(beats);
  });

  it('keeps counting at the last interval when the music runs out', () => {
    // Four layers, two beats left. Dropping two would animate less than was
    // selected; piling them on the last beat would look like a bug.
    const out = beatsForLayers([2, 2.5], 0, 4);
    expect(out).toEqual([2, 2.5, 3, 3.5]);
  });

  it('infers an interval from the whole grid when only one beat is left', () => {
    // The tail has no gap to measure, so the tempo comes from the grid.
    const out = beatsForLayers(steady(5), 2.0, 3);
    expect(out[0]).toBe(2);
    expect(out[1]! - out[0]!).toBeCloseTo(0.5, 6);
    expect(out[2]! - out[1]!).toBeCloseTo(0.5, 6);
  });

  it('falls back to one-second spacing when there is no tempo to infer', () => {
    expect(beatsForLayers([4], 0, 3)).toEqual([4, 5, 6]);
  });

  it('still returns a usable rhythm when the playhead is past every beat', () => {
    // Past the end of the music: one per second from the playhead beats
    // stacking every layer on the same frame.
    expect(beatsForLayers(steady(4), 99, 3)).toEqual([99, 100, 101]);
  });

  it('never returns times that go backwards', () => {
    const out = beatsForLayers([1, 0.5, 2], 0, 6);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]!);
  });

  it('asks for none, gets none', () => {
    expect(beatsForLayers(steady(8), 0, 0)).toEqual([]);
    expect(beatsForLayers(steady(8), 0, -2)).toEqual([]);
  });

  it('handles an empty grid without dividing by zero', () => {
    expect(beatsForLayers([], 3, 2)).toEqual([3, 4]);
  });
});

describe('everyNthBeat', () => {
  it('halves the grid for half-time phrasing', () => {
    expect(everyNthBeat(steady(6), 2)).toEqual([0, 1, 2]);
  });

  it('keeps the downbeat when thinning', () => {
    // Dropping the first beat would shift the whole piece off the bar.
    expect(everyNthBeat(steady(8, 1.25), 4)[0]).toBe(1.25);
  });

  it('treats 1, 0 and nonsense as every beat', () => {
    const beats = steady(4);
    expect(everyNthBeat(beats, 1)).toEqual(beats);
    expect(everyNthBeat(beats, 0)).toEqual(beats);
    expect(everyNthBeat(beats, -3)).toEqual(beats);
  });

  it('rounds a fractional n rather than producing an empty grid', () => {
    expect(everyNthBeat(steady(6), 2.4)).toEqual([0, 1, 2]);
  });
});

describe('findAudioLayer', () => {
  /** A layer parented to the VIRTUAL `comp_root` — no engine node behind it,
   *  which is what a fresh unsaved project looks like. */
  function addLayer(id: string, kind: string): void {
    defaultSceneGraph.addChild('comp_root', {
      id,
      name: id,
      parent: 'comp_root',
      children: [],
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      visible: true,
      locked: false,
      components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: kind } }],
    } as never);
  }

  beforeEach(() => {
    for (const id of ['solid_a', 'music_a', 'music_b']) {
      if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode?.(id);
    }
  });

  it('finds an audio layer hanging off the virtual comp root', () => {
    // The regression. `getRoots()` is empty for these layers, so a
    // roots-downwards walk (`flattenScene`) returns NOTHING and the audio is
    // invisible — which disabled every beat command on a fresh project while
    // the music sat in the timeline. Only `traverse` sees them.
    addLayer('solid_a', 'solid');
    addLayer('music_a', 'audio');
    expect(defaultSceneGraph.getRoots()).toHaveLength(0);
    expect(findAudioLayer()).toBe('music_a');
  });

  it('prefers the layer it was pointed at', () => {
    addLayer('music_a', 'audio');
    addLayer('music_b', 'audio');
    expect(findAudioLayer('music_b')).toBe('music_b');
  });

  it('ignores a preference that is not an audio layer', () => {
    addLayer('solid_a', 'solid');
    addLayer('music_a', 'audio');
    expect(findAudioLayer('solid_a')).toBe('music_a');
  });

  it('reports nothing when the scene has no audio', () => {
    addLayer('solid_a', 'solid');
    expect(findAudioLayer()).toBeUndefined();
  });
});
