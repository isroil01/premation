/**
 * The choreography record store — small, but with three decisions in it that
 * are easy to get wrong and impossible to notice afterwards.
 *
 *   • One record PER COMPOSITION. Keyed globally, "Re-apply" on board B would
 *     offer to restage layers that live on board A, using a capture whose node
 *     ids mean nothing there.
 *   • Recording is also what sets `lastParams`. Two separate writes would
 *     eventually drift, and the Stagger menu row would start applying params
 *     that were never actually used.
 *   • `lastParams` starts as null. "Last used" has to mean used: the menu row
 *     is labelled with a fixed 0.3s and has to keep that promise until
 *     somebody has chosen otherwise.
 */

import { DEFAULT_STAGGER_PARAMS, type StaggerParams } from '@core/animation/choreography';
import { lastChoreography, lastStaggerParams, useChoreographyStore, type ChoreographyRecord } from './choreographyStore';

function params(patch: Partial<StaggerParams> = {}): StaggerParams {
  return { ...DEFAULT_STAGGER_PARAMS, ...patch };
}

function record(patch: Partial<ChoreographyRecord> = {}): ChoreographyRecord {
  return {
    kind: 'in',
    params: params(),
    nodeIds: ['n1', 'n2'],
    atCompTime: 0,
    fps: 30,
    captured: [{ nodeId: 'n1', prop: 'x', keyframes: null }],
    installs: {},
    range: { start: 0, end: 1 },
    offsetFrames: [0, 3],
    archetypes: ['rise'],
    keyframes: 6,
    at: 1,
    ...patch,
  };
}

beforeEach(() => {
  useChoreographyStore.setState({ byComp: {}, lastParams: null });
});

describe('useChoreographyStore', () => {
  it('starts with nothing recorded and no last params', () => {
    expect(useChoreographyStore.getState().byComp).toEqual({});
    expect(lastStaggerParams()).toBeNull();
  });

  it('files a record under its composition', () => {
    const entry = record();
    useChoreographyStore.getState().record('comp_a', entry);
    expect(lastChoreography('comp_a')).toBe(entry);
  });

  it('keeps compositions apart', () => {
    const a = record({ nodeIds: ['a'] });
    const b = record({ nodeIds: ['b'] });
    useChoreographyStore.getState().record('comp_a', a);
    useChoreographyStore.getState().record('comp_b', b);
    expect(lastChoreography('comp_a')).toBe(a);
    expect(lastChoreography('comp_b')).toBe(b);
  });

  it('replaces the composition record rather than accumulating them', () => {
    // Exactly one "last choreography" per board — a list would need a UI to
    // choose from, and choosing among five past runs is not the problem.
    useChoreographyStore.getState().record('comp_a', record({ at: 1 }));
    const second = record({ at: 2 });
    useChoreographyStore.getState().record('comp_a', second);
    expect(lastChoreography('comp_a')).toBe(second);
    expect(Object.keys(useChoreographyStore.getState().byComp)).toEqual(['comp_a']);
  });

  it('makes recording the only way last params are set', () => {
    useChoreographyStore.getState().record('comp_a', record({ params: params({ baseOffsetFrames: 11 }) }));
    expect(lastStaggerParams()?.baseOffsetFrames).toBe(11);
  });

  it('clears one composition without touching the others', () => {
    useChoreographyStore.getState().record('comp_a', record());
    useChoreographyStore.getState().record('comp_b', record());
    useChoreographyStore.getState().clear('comp_a');
    expect(lastChoreography('comp_a')).toBeUndefined();
    expect(lastChoreography('comp_b')).toBeDefined();
  });

  it('keeps the last params after a clear — the numbers outlive the keyframes', () => {
    // Removing a choreography is not a reason to forget the rhythm you dialled
    // in; the very next thing you do is usually apply it somewhere else.
    useChoreographyStore.getState().record('comp_a', record({ params: params({ swingPct: 55 }) }));
    useChoreographyStore.getState().clear('comp_a');
    expect(lastStaggerParams()?.swingPct).toBe(55);
  });

  it('clearing something that was never recorded is a no-op, not a new key', () => {
    const before = useChoreographyStore.getState().byComp;
    useChoreographyStore.getState().clear('comp_missing');
    expect(useChoreographyStore.getState().byComp).toBe(before);
  });

  it('sets last params directly for a caller that has not applied yet', () => {
    useChoreographyStore.getState().setLastParams(params({ order: 'random', seed: 7 }));
    expect(lastStaggerParams()?.order).toBe('random');
    expect(useChoreographyStore.getState().byComp).toEqual({});
  });

  it('answers safely for an unknown or missing composition', () => {
    expect(lastChoreography(undefined)).toBeUndefined();
    expect(lastChoreography('nope')).toBeUndefined();
  });
});
