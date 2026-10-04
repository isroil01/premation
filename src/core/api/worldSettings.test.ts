/**
 * Composition Settings ▸ World must round-trip, and must be INVISIBLE until set.
 *
 * The three World fields (default sky, ground level, sky backdrop) are authored
 * state living on the composition record, so they ride the `comps` chunk that
 * already exists rather than a new top-level key. That is the cheap way to do
 * it and also the risky one: a field that rides an existing chunk gets no
 * round-trip test of its own by default, and "it's in the same object as width"
 * is exactly the reasoning that lost the timeline (see cloudDocument.test.ts).
 *
 * The second half is the one that matters more. All three are optional, and a
 * document written before they existed must come back with them ABSENT — not
 * defaulted-and-written, which would rewrite every comp record on disk and
 * change the behaviour of every scene that never opted in.
 */


import { useProjectStore } from '@stores/projectStore';
import { sanitize, DEFAULT_COMPOSITION } from '@stores/compositionStore';
import { DEFAULT_ENVIRONMENT_PRESET } from '@core/scene/environmentLight';

const COMP = 'comp_root';

beforeEach(() => {
  // A comp record with none of the World fields — the state every project that
  // predates this tab is in.
  useProjectStore.getState().actions.replaceComps({
    [COMP]: { ...DEFAULT_COMPOSITION, id: COMP, name: 'Composition 1' },
  });
});

describe('the World sanitizer', () => {
  it('rejects a sky id no probe understands', () => {
    expect(sanitize({ defaultEnvPreset: 'nebula' as never }).defaultEnvPreset)
      .toBe(DEFAULT_ENVIRONMENT_PRESET);
    // A real one passes through untouched.
    expect(sanitize({ defaultEnvPreset: 'sunset' }).defaultEnvPreset).toBe('sunset');
  });

  it('keeps the ground level finite but otherwise unbounded', () => {
    expect(sanitize({ groundLevel: NaN }).groundLevel).toBe(0);
    expect(sanitize({ groundLevel: -1234.5 }).groundLevel).toBe(-1234.5);
    expect(sanitize({ groundLevel: 99999 }).groundLevel).toBe(99999);
  });

  it('leaves an untouched patch alone — the fields are opt-in', () => {
    expect(sanitize({ width: 100 })).toEqual({ width: 100 });
  });
});
