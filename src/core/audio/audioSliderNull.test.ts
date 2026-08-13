/**
 * The AE-shaped output: a null carrying Both Channels / Left / Right sliders.
 *
 * ## What this file is really guarding
 *
 * Two different time axes meet here, and using one for both steps is the
 * natural mistake:
 *
 *   audio source frame → comp time    ← the AUDIO layer's clip timings
 *   comp time → keyframe time         ← the NULL's own remapping
 *
 * A fresh null is untrimmed and unstretched, so its remapping is the identity
 * on the day it is made. Passing the audio layer's id to the second step
 * therefore produces identical keyframes in every test that only ever converts
 * once — and drifts the moment someone slides the null. So the assertion here
 * is about WHICH NODE ID each step is asked about, not only about the numbers.
 *
 * ## What the medium cannot see (rule 5·0)
 *
 * Everything below the module boundary is mocked, so this proves the
 * composition and not that `insertPrimitive` really makes a null, that
 * `addSliderControl` really renders an inspector row, or that the palette
 * command reaches any of it. Those are wiring facts; they were checked in the
 * running app.
 */

import { defaultAnimation } from '@motion/animation';

let clipTimings: Array<{ id: string; enabled: boolean; startSec: number; inSec: number; outSec: number }> = [];
let selection: string[] = [];
const compToKeyframeCalls: Array<{ nodeId: string; compTime: number; prop: string }> = [];
const inserted: Array<{ kind: string; name: string }> = [];
const sliders: Array<{ nodeId: string; name: string }> = [];

jest.mock('@core/timeline/TimelineController', () => ({
  getTimelineController: () => ({ fps: 10 }),
  compToKeyframeTime: (nodeId: string, compTime: number, prop: string) => {
    compToKeyframeCalls.push({ nodeId, compTime, prop });
    return compTime;
  },
}));
/**
 * NODE-AWARE on purpose. A mock that ignored the id would make the audio layer
 * and the null indistinguishable to the source-frame → comp-time step, and
 * that is precisely the confusion under test: with `() => clipTimings`,
 * swapping the id in that call fails NOTHING. Only the null has no timings.
 */
jest.mock('./audioScene', () => ({
  readAudioClipTimings: (id: string) => (id === 'AUDIO_ID' ? clipTimings : []),
}));
jest.mock('@core/animation/animationCommands', () => ({
  runAnimEdit: (_label: string, mutate: () => void) => mutate(),
}));
jest.mock('@core/scene/sceneInsert', () => ({
  insertPrimitive: (kind: string, name: string) => {
    inserted.push({ kind, name });
    selection = ['NULL_ID']; // insertPrimitive selects what it made
  },
}));
jest.mock('@stores/selectionStore', () => ({
  useSelectionStore: { getState: () => ({ ids: selection }) },
}));
jest.mock('@core/animation/expressionControls', () => ({
  CONTROL_PREFIX: 'ctrl_',
  addSliderControl: (nodeId: string, name: string) => {
    sliders.push({ nodeId, name });
    return name;
  },
}));
jest.mock('@core/scene/DefaultSceneGraph', () => ({
  __esModule: true,
  default: { getNode: (id: string) => ({ id, name: id === 'AUDIO_ID' ? 'Music' : 'Null' }) },
}));

import { applyAudioSliderNull, DEFAULT_AUDIO_KEYFRAME_OPTIONS } from './audioKeyframes';

/** Stereo, 100 Hz, 4 frames at 10 fps; left ramps so nothing thins to nothing. */
function fixture(): AudioBuffer {
  const rep = (v: number) => Array<number>(10).fill(v);
  const ch = [
    new Float32Array([...rep(1.0), ...rep(0.5), ...rep(0.0), ...rep(0.25)]),
    new Float32Array([...rep(0.5), ...rep(0.5), ...rep(0.5), ...rep(0.5)]),
  ];
  return {
    duration: 0.4, length: 40, sampleRate: 100, numberOfChannels: 2,
    getChannelData: (i: number) => ch[i]!,
  } as unknown as AudioBuffer;
}

const OPTS = { ...DEFAULT_AUDIO_KEYFRAME_OPTIONS, minDelta: 0 };

beforeEach(() => {
  clipTimings = [];
  selection = [];
  compToKeyframeCalls.length = 0;
  inserted.length = 0;
  sliders.length = 0;
  jest.spyOn(defaultAnimation, 'setKeyframes').mockImplementation(() => {});
  jest.spyOn(defaultAnimation, 'batch').mockImplementation((fn: () => void) => { fn(); });
});
afterEach(() => jest.restoreAllMocks());

describe('applyAudioSliderNull', () => {
  it('creates a null named after the audio layer', () => {
    applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    expect(inserted).toEqual([{ kind: 'null', name: 'Music Amplitude' }]);
  });

  it('adds the three AE sliders to the NULL, not the audio layer', () => {
    applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    expect(sliders).toEqual([
      { nodeId: 'NULL_ID', name: 'Both Channels' },
      { nodeId: 'NULL_ID', name: 'Left' },
      { nodeId: 'NULL_ID', name: 'Right' },
    ]);
  });

  it('writes one keyframe track per slider, on the null', () => {
    const res = applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    const calls = (defaultAnimation.setKeyframes as jest.Mock).mock.calls;
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      ['NULL_ID', 'ctrl_Both Channels'],
      ['NULL_ID', 'ctrl_Left'],
      ['NULL_ID', 'ctrl_Right'],
    ]);
    expect(res.nodeId).toBe('NULL_ID');
    expect(res.written.get('left')).toBe(4);
  });

  /**
   * THE directional assertion. Both steps read a node id, and a fresh null's
   * remapping is the identity, so the numbers alone cannot tell the two apart.
   */
  it('resolves keyframe TIME against the null, not the audio layer', () => {
    applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    expect(compToKeyframeCalls.length).toBeGreaterThan(0);
    expect(compToKeyframeCalls.every((c) => c.nodeId === 'NULL_ID')).toBe(true);
    expect(compToKeyframeCalls.some((c) => c.nodeId === 'AUDIO_ID')).toBe(false);
  });

  /**
   * The other half of the same pairing: the SOURCE-frame → comp-time step must
   * use the AUDIO layer's clip timings. With the clip starting at 5 s, frame 0
   * belongs at comp time 5, not 0.
   */
  it('offsets source frames by the AUDIO layer’s clip start', () => {
    clipTimings = [{ id: 'c', enabled: true, startSec: 5, inSec: 0, outSec: 0.4 }];
    applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    const times = compToKeyframeCalls.filter((c) => c.prop === 'ctrl_Left').map((c) => c.compTime);
    expect(times).toEqual([5, 5.1, 5.2, 5.3]);
  });

  /** Trimmed-away frames produce no keyframe rather than a clamped one. */
  it('drops frames trimmed out of the clip', () => {
    clipTimings = [{ id: 'c', enabled: true, startSec: 0, inSec: 0.1, outSec: 0.3 }];
    applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    const times = compToKeyframeCalls.filter((c) => c.prop === 'ctrl_Left').map((c) => c.compTime);
    // Source 0.1 and 0.2 survive; 0.0 is before the in-point, 0.3 is at/after out.
    expect(times).toEqual([0, 0.1]);
  });

  /**
   * Values come from the SHARED-peak envelopes, so the Right slider must not
   * reach 100 — the same claim `audioChannels.test.ts` makes about the maths,
   * asserted again here because this is the path that reaches a user.
   */
  it('writes shared-peak values, so Right tops out at half of Left', () => {
    applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    const calls = (defaultAnimation.setKeyframes as jest.Mock).mock.calls;
    const byProp = new Map(calls.map((c) => [c[1], c[2] as Array<{ value: number }>]));
    const left = byProp.get('ctrl_Left')!.map((k) => k.value);
    const right = byProp.get('ctrl_Right')!.map((k) => k.value);
    expect(left).toEqual([100, 50, 0, 25]);
    expect(right).toEqual([50, 50, 50, 50]);
  });

  /** A null that could not be created is reported, not silently half-done. */
  it('reports failure when the null cannot be made', () => {
    const spy = jest.spyOn(
      jest.requireMock('@core/scene/sceneInsert') as { insertPrimitive: () => void },
      'insertPrimitive',
    ).mockImplementation(() => { selection = []; });
    const res = applyAudioSliderNull('AUDIO_ID', fixture(), OPTS);
    expect(res.nodeId).toBeNull();
    expect(res.written.size).toBe(0);
    spy.mockRestore();
  });
});
