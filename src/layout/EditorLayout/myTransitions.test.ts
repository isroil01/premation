/**
 * My Transitions: a saved transition's length is its last key (captured
 * presets start at 0), and a user preset travels to the engine as its body —
 * the engine's registry only knows the built-ins.
 */

import { presetSpanSeconds } from './MyTransitions';
import { saveUserPreset, deletePreset, withUserPresetBody, BUILTIN_PRESETS } from '@core/animation/animationPresets';
import { setCoreServiceRefs } from '@core/services/coreServices';

beforeEach(() => {
  // Presets persist through SettingsManager; the smallest thing that is one.
  const store = new Map<string, unknown>();
  setCoreServiceRefs({
    settings: {
      get: <T>(k: string, fallback: T): T => (store.has(k) ? (store.get(k) as T) : fallback),
      set: <T>(k: string, v: T): void => { store.set(k, v); },
    },
  } as unknown as Parameters<typeof setCoreServiceRefs>[0]);
});

it('a transition lasts until its last key', () => {
  expect(presetSpanSeconds({ tracks: [] })).toBe(0);
  expect(
    presetSpanSeconds({
      tracks: [
        { prop: 'opacity', keyframes: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }] },
        { prop: 'scale', keyframes: [{ t: 0.2, value: 50 }, { t: 0.8, value: 100 }] },
      ],
    } as never),
  ).toBeCloseTo(0.8);
});

it('applyPreset carries a user preset body, and nothing for a built-in', () => {
  saveUserPreset('Test Push', { tracks: [{ prop: 'opacity', keyframes: [{ t: 0, value: 0 }, { t: 1, value: 100 }] }] } as never, 'My Transitions');
  try {
    const { body } = withUserPresetBody('Test Push');
    expect(body).toBeDefined();
    expect(JSON.parse(body!).tracks).toHaveLength(1);
    expect(withUserPresetBody(BUILTIN_PRESETS[0]!.name)).toEqual({});
  } finally {
    deletePreset('Test Push');
  }
});
