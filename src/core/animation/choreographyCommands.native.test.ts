/**
 * Re-editable choreography, against the real engine.
 *
 * `planStagger.test.ts` pins the maths. What is tested here is the promise the
 * panel makes, which is a much stronger one and is entirely about state the
 * planner never sees:
 *
 *   1. A re-apply REPLACES. Nudging the spacing from 3 frames to 6 must leave
 *      the composition exactly as if 6 had been chosen the first time — not as
 *      if a 6-frame choreography had been laid on top of a 3-frame one. This
 *      is the failure the whole capture mechanism exists to prevent, and it is
 *      invisible to any test that only looks at the last thing written.
 *
 *   2. The capture is EXACT, not diffed. The generators are lossy and some of
 *      them install effects; re-running with the old params is not a revert.
 *      A property that had NO track before must have no track after, which is
 *      the case a naive "write the old values back" gets wrong.
 *
 *   3. One undo entry per gesture, restore included. Two entries would mean
 *      two undos to get back, with a state nobody asked to visit in between.
 *
 * Runs on the APP's engine (setupAppEngine): the gestures are engine edits
 * (choreographyEdits.ts), so the fixture layers are made and seeded through it.
 *
 * Plus the thing that is easy to break by accident: the Animation menu's
 * Stagger row resolves a command id registered in `Providers.tsx`, and this
 * module deliberately re-registers that id. If the override stops being the
 * one that wins, the menu silently goes back to the old fixed 0.3s.
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { useSelectionStore } from '@stores/selectionStore';
import { useChoreographyStore } from '@stores/choreographyStore';
import { DEFAULT_STAGGER_PARAMS, type StaggerParams } from './choreography';
import {
  activeCompId,
  buildChoreographyCommands,
  currentStaggerParams,
  reapplyChoreography,
  revertChoreography,
  runChoreography,
  staggerTargets,
} from './choreographyCommands';

let h: Harness;
let LAYERS: string[] = [];

async function addLayer(name: string, x = 100, y = 200): Promise<string> {
  const { layer } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name, init: [] });
  await h.run({ type: 'setProperty', prop: { layer, path: 'transform/position' }, value: { kind: 'vec2', value: { x, y } } });
  return layer;
}

/** Keys through the engine: seconds → flicks on the given API property. */
async function key(layer: string, path: string, keys: Array<[number, number]>): Promise<void> {
  await h.run({
    type: 'addKeyframes',
    keys: keys.map(([t, v]) => ({ prop: { layer, path }, time: Math.round(t * 705_600_000), value: { kind: 'scalar', value: v }, spatialIn: [], spatialOut: [] })),
  });
}

async function seedOpacity(ids: readonly string[] = LAYERS): Promise<void> {
  for (const id of ids) await key(id, 'transform/opacity', [[0, 0], [0.5, 100]]);
}

/**
 * Everything the engine holds for these layers, as a comparable string.
 *
 * Whole tracks, not just the props the last run touched — a track left behind
 * by a previous archetype is exactly the kind of residue this file exists to
 * catch, and comparing only the current props would step right over it.
 */
async function engineState(ids: readonly string[] = LAYERS): Promise<string> {
  const view = await docView();
  return JSON.stringify(
    ids.map((id) => [
      id,
      view.tracksFor(id)
        // A 3D layer's Scale is keyed as a whole vec3 by the engine: a Z that
        // never moves is that whole-property key, not motion. (The 3D switch a
        // tilting entrance turns on outlives a re-apply, as it always has.)
        .filter((t) => !(t.prop === 'scaleZ' && t.keyframes.every((k) => k.value === 1)))
        // Key ids are the engine's (minted per write), and the engine spells out
        // a key's default fields: compared without either.
        .map((t) => [t.prop, t.keyframes.map(({ id: _id, easing, continuous, roving, ...k }) => ({
          ...k,
          ...(easing && easing !== 'linear' ? { easing } : {}),
          ...(continuous ? { continuous } : {}),
          ...(roving ? { roving } : {}),
        }))])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]),
  );
}

async function historyDepth(): Promise<number> {
  return (await historyLabels()).length;
}

function params(patch: Partial<StaggerParams> = {}): StaggerParams {
  return { ...DEFAULT_STAGGER_PARAMS, ...patch };
}

beforeEach(async () => {
  h = await setupAppEngine();
  LAYERS = [];
  for (let i = 0; i < 3; i++) LAYERS.push(await addLayer(`ch_${i}`, 100 + i * 120, 200 + i * 40));
  await engineIdle();
  useChoreographyStore.setState({ byComp: {}, lastParams: null });
  useSelectionStore.setState({ ids: [...LAYERS] } as never);
});
afterEach(async () => { await h.dispose(); });

describe('runChoreography records what it did', () => {
  it('files a record against the composition, with the params it used', async () => {
    const record = (await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 5 }) }))!;

    expect(record).not.toBeNull();
    expect(record.kind).toBe('in');
    expect(record.nodeIds).toEqual(LAYERS);
    expect(record.params.seed).toBe(5);
    expect(record.keyframes).toBeGreaterThan(0);
    expect(useChoreographyStore.getState().byComp[activeCompId()]).toBe(record);
  });

  it('reports the key range it wrote', async () => {
    const record = (await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ baseOffsetFrames: 6 }) }))!;
    expect(record.range).not.toBeNull();
    expect(record.range!.end).toBeGreaterThan(record.range!.start);
  });

  it('records the per-layer offsets in whole frames', async () => {
    const record = (await runChoreography({
      kind: 'in',
      nodeIds: LAYERS,
      params: params({ baseOffsetFrames: 4, swingPct: 0 }),
    }))!;
    expect(record.offsetFrames).toEqual([0, 4, 8]);
  });

  it('makes the applied params the last-used ones', async () => {
    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ baseOffsetFrames: 9 }) });
    expect(useChoreographyStore.getState().lastParams?.baseOffsetFrames).toBe(9);
  });

  it('captures a property that had NO track, so a revert can remove it again', async () => {
    const record = (await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params() }))!;
    // Every fixture layer starts unanimated, so every captured entry must be
    // the null case. If capture recorded an empty array instead, restore would
    // leave the generated tracks in place and "Remove" would do nothing.
    expect(record.captured.length).toBeGreaterThan(0);
    expect(record.captured.every((c) => c.keyframes === null)).toBe(true);
  });

  it('does nothing, and files nothing, for layers that are not there', async () => {
    expect(await runChoreography({ kind: 'in', nodeIds: ['ghost'], params: params() })).toBeNull();
    expect(useChoreographyStore.getState().byComp[activeCompId()]).toBeUndefined();
  });
});

describe('re-apply replaces rather than layers', () => {
  it('lands exactly where applying the new params first would have', async () => {
    // The assertion the whole feature rests on. Compounding is invisible to a
    // test that only checks the last write: the new keyframes are all present
    // either way, and it is the STALE ones from the first run that separate a
    // replace from a pile-up.
    const first = params({ seed: 3, baseOffsetFrames: 3 });
    // Order by timeline, not position: a tilting entrance turns the layer's 3D
    // switch on, and the engine re-centres a comp-sized solid's anchor when it
    // does, so a position order would compare two different layouts.
    const second = params({ seed: 41, baseOffsetFrames: 7, feel: 'snappy', order: 'timeline' });

    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: second });
    const fresh = (await engineState());

    await revertChoreography();
    useChoreographyStore.setState({ byComp: {}, lastParams: null });

    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: first });
    await reapplyChoreography(second);

    expect((await engineState())).toBe(fresh);
  });

  it('survives repeated re-applies without drifting', async () => {
    const target = params({ seed: 12, baseOffsetFrames: 5 });
    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: target });
    const once = (await engineState());

    for (let i = 0; i < 4; i++) await reapplyChoreography(params({ seed: 90 + i, baseOffsetFrames: 2 + i }));
    await reapplyChoreography(target);

    expect((await engineState())).toBe(once);
  });

  it('re-applies to the RECORDED layers, not to whatever is selected now', async () => {
    await runChoreography({ kind: 'in', nodeIds: [LAYERS[0]!], params: params() });
    useSelectionStore.setState({ ids: [LAYERS[2]!] } as never);

    const again = (await reapplyChoreography(params({ baseOffsetFrames: 8 })))!;

    expect(again.nodeIds).toEqual([LAYERS[0]]);
    expect((await docView()).tracksFor(LAYERS[2]!)).toHaveLength(0);
  });

  it('keeps the ORIGINAL capture, not the state the last run left', async () => {
    // Otherwise the second re-apply would restore the first re-apply's output
    // and the composition could never get back to where it started.
    const first = (await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 2 }) }))!;
    const again = (await reapplyChoreography(params({ seed: 77, baseOffsetFrames: 11 })))!;
    expect(again.captured.every((c) => c.keyframes === null)).toBe(true);
    expect(again.captured.length).toBeGreaterThanOrEqual(first.captured.length);
  });

  it('is one undo entry, restore included', async () => {
    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 4 }) });
    const before = (await historyDepth());
    await reapplyChoreography(params({ seed: 21, baseOffsetFrames: 9 }));
    expect((await historyDepth())).toBe(before + 1);
  });

  it('does nothing when there is no record to re-apply', async () => {
    expect(await reapplyChoreography(params())).toBeNull();
  });
});

describe('revert', () => {
  it('puts the composition back to before the choreography', async () => {
    // Seeded with an existing track so this tests a genuine restore rather
    // than "delete everything", which would pass on empty layers.
    await key(LAYERS[0]!, 'transform/rotation', [[0, 0], [1, 90]]);
    const original = (await engineState());

    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 6 }) });
    expect((await engineState())).not.toBe(original);

    expect(await revertChoreography()).toBe(true);
    expect((await engineState())).toBe(original);
  });

  it('removes tracks the choreography created, not just their values', async () => {
    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params() });
    await revertChoreography();
    for (const id of LAYERS) expect((await docView()).tracksFor(id)).toHaveLength(0);
  });

  it('forgets the record, so there is nothing left to re-apply', async () => {
    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params() });
    await revertChoreography();
    expect(useChoreographyStore.getState().byComp[activeCompId()]).toBeUndefined();
    expect(await revertChoreography()).toBe(false);
  });
});

describe('the stagger gesture shifts what is already there', () => {

  it('offsets each layer by its planned frames and leaves the leader alone', async () => {
    await seedOpacity();
    const record = (await runChoreography({
      kind: 'stagger',
      nodeIds: LAYERS,
      params: params({ baseOffsetFrames: 6, swingPct: 0 }),
    }))!;
    const view = await docView();
    const starts = LAYERS.map((id) => view.getTrackKeyframes(id, 'opacity')![0]!.t);
    expect(starts[0]).toBeCloseTo(0, 6);
    expect(starts[1]).toBeCloseTo(6 / record.fps, 6);
    expect(starts[2]).toBeCloseTo(12 / record.fps, 6);
  });

  it('does not compound on a re-apply', async () => {
    // The old fixed command shifted by a further 0.3s on every press, so three
    // presses meant 0.9s and the only way back was three undos.
    await seedOpacity();
    const target = params({ baseOffsetFrames: 4, swingPct: 0 });
    await runChoreography({ kind: 'stagger', nodeIds: LAYERS, params: target });
    const once = (await engineState());

    await reapplyChoreography(params({ baseOffsetFrames: 20, swingPct: 0 }));
    await reapplyChoreography(target);

    expect((await engineState())).toBe(once);
  });

  it('captures the real keyframes, so a revert restores the original timing', async () => {
    await seedOpacity();
    const original = (await engineState());
    await runChoreography({ kind: 'stagger', nodeIds: LAYERS, params: params({ baseOffsetFrames: 9 }) });
    await revertChoreography();
    expect((await engineState())).toBe(original);
  });

  it('only offers layers that actually have keyframes', async () => {
    expect(staggerTargets()).toEqual([]);
    await key(LAYERS[1]!, 'transform/opacity', [[0, 50]]);
    expect(staggerTargets()).toEqual([LAYERS[1]]);
  });
});

describe('the Stagger Animations command id', () => {
  const staggerCommand = () =>
    buildChoreographyCommands().find((c) => String(c.id) === 'animation.sequenceLayers')!;

  it('is still registered under the id the Animation menu resolves', async () => {
    expect(staggerCommand()).toBeDefined();
  });

  it('needs two animated layers, like the row it replaces', async () => {
    expect(staggerCommand().enabled!()).toBe(false);
    for (const id of LAYERS) await key(id, 'transform/opacity', [[0, 100]]);
    expect(staggerCommand().enabled!()).toBe(true);
  });

  it('falls back to the legacy 0.3s until something has been applied', async () => {
    // The menu row is labelled "(0.3s)" and cannot be edited from here, so the
    // first press has to keep that promise.
    expect(currentStaggerParams(30).baseOffsetFrames).toBe(9);
    expect(currentStaggerParams(24).baseOffsetFrames).toBe(7);
    expect(currentStaggerParams(30).swingPct).toBe(0);
  });

  it('uses the last-applied params once there are any', async () => {
    await runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ baseOffsetFrames: 13, swingPct: 40 }) });
    expect(currentStaggerParams(30).baseOffsetFrames).toBe(13);
    expect(currentStaggerParams(30).swingPct).toBe(40);
  });

  it('is the LAST registration of that id, so it is the one that wins', async () => {
    // `Providers.tsx` registers `animation.sequenceLayers` too — the old fixed
    // 0.3s shift — and this module deliberately re-registers it. Registration
    // replaces, so which one the menu gets comes down to the order inside
    // `buildStaticCommands`, and nothing else in the codebase says so out
    // loud. Move `buildChoreographyCommands` above `buildBuiltinCommands` and
    // every symptom is silent: the row still works, it just quietly stops
    // being parametric.
    const { buildStaticCommands } = require('@providers/Providers') as typeof import('@providers/Providers');
    const ids = buildStaticCommands().map((c) => String(c.id));
    const at = ids.reduce<number[]>((acc, id, i) => (id === 'animation.sequenceLayers' ? [...acc, i] : acc), []);
    expect(at.length).toBe(2);

    const winner = buildStaticCommands()[at[at.length - 1]!]!;
    expect(winner.label).toBe('Stagger Animations');
    expect(String(winner.description)).toContain('last stagger settings');
  });

  it('applies, and files a stagger record', async () => {
    await seedOpacity();
    void staggerCommand().execute({} as never);
    await new Promise((r) => setTimeout(r, 0));
    await engineIdle();
    for (let i = 0; i < 20 && !useChoreographyStore.getState().byComp[activeCompId()]; i++) await new Promise((r) => setTimeout(r, 5));
    const record = useChoreographyStore.getState().byComp[activeCompId()];
    expect(record?.kind).toBe('stagger');
    expect(record?.nodeIds).toEqual(LAYERS);
  });
});
