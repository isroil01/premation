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
 * Plus the thing that is easy to break by accident: the Animation menu's
 * Stagger row resolves a command id registered in `Providers.tsx`, and this
 * module deliberately re-registers that id. If the override stops being the
 * one that wins, the menu silently goes back to the old fixed 0.3s.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
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

const LAYERS = ['ch_a', 'ch_b', 'ch_c'];

function addLayer(id: string, x = 100, y = 200): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: id,
    parent: 'comp_root',
    children: [],
    transform: { position: { x, y }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_t`, type: 'Transform', props: { __kind: 'solid', x, y, width: 100, height: 100 } }],
  } as never);
}

/**
 * Everything the engine holds for these layers, as a comparable string.
 *
 * Whole tracks, not just the props the last run touched — a track left behind
 * by a previous archetype is exactly the kind of residue this file exists to
 * catch, and comparing only the current props would step right over it.
 */
function engineState(ids: readonly string[] = LAYERS): string {
  return JSON.stringify(
    ids.map((id) => [
      id,
      defaultAnimation.tracksFor(id)
        .map((t) => [t.prop, t.keyframes])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]),
  );
}

function historyDepth(): number {
  // `getIndex()` is the top of the UNDO stack; `getEntries()` also carries the
  // redo tail, which none of this touches.
  return getCommandSystem().getHistory().getIndex() + 1;
}

function params(patch: Partial<StaggerParams> = {}): StaggerParams {
  return { ...DEFAULT_STAGGER_PARAMS, ...patch };
}

/** Wipe the animation for the fixture layers without touching the scene. */
function clearAnimation(): void {
  for (const id of LAYERS) {
    for (const track of defaultAnimation.tracksFor(id)) {
      defaultAnimation.setTrackKeyframes(id, track.prop, null);
    }
  }
}

beforeAll(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) as never }));
});

beforeEach(() => {
  for (const id of LAYERS) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode?.(id);
  }
  LAYERS.forEach((id, i) => addLayer(id, 100 + i * 120, 200 + i * 40));
  clearAnimation();
  useChoreographyStore.setState({ byComp: {}, lastParams: null });
  useSelectionStore.setState({ ids: [...LAYERS] } as never);
});

describe('runChoreography records what it did', () => {
  it('files a record against the composition, with the params it used', () => {
    const record = runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 5 }) })!;

    expect(record).not.toBeNull();
    expect(record.kind).toBe('in');
    expect(record.nodeIds).toEqual(LAYERS);
    expect(record.params.seed).toBe(5);
    expect(record.keyframes).toBeGreaterThan(0);
    expect(useChoreographyStore.getState().byComp[activeCompId()]).toBe(record);
  });

  it('reports the key range it wrote', () => {
    const record = runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ baseOffsetFrames: 6 }) })!;
    expect(record.range).not.toBeNull();
    expect(record.range!.end).toBeGreaterThan(record.range!.start);
  });

  it('records the per-layer offsets in whole frames', () => {
    const record = runChoreography({
      kind: 'in',
      nodeIds: LAYERS,
      params: params({ baseOffsetFrames: 4, swingPct: 0 }),
    })!;
    expect(record.offsetFrames).toEqual([0, 4, 8]);
  });

  it('makes the applied params the last-used ones', () => {
    runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ baseOffsetFrames: 9 }) });
    expect(useChoreographyStore.getState().lastParams?.baseOffsetFrames).toBe(9);
  });

  it('captures a property that had NO track, so a revert can remove it again', () => {
    const record = runChoreography({ kind: 'in', nodeIds: LAYERS, params: params() })!;
    // Every fixture layer starts unanimated, so every captured entry must be
    // the null case. If capture recorded an empty array instead, restore would
    // leave the generated tracks in place and "Remove" would do nothing.
    expect(record.captured.length).toBeGreaterThan(0);
    expect(record.captured.every((c) => c.keyframes === null)).toBe(true);
  });

  it('does nothing, and files nothing, for layers that are not there', () => {
    expect(runChoreography({ kind: 'in', nodeIds: ['ghost'], params: params() })).toBeNull();
    expect(useChoreographyStore.getState().byComp[activeCompId()]).toBeUndefined();
  });
});

describe('re-apply replaces rather than layers', () => {
  it('lands exactly where applying the new params first would have', () => {
    // The assertion the whole feature rests on. Compounding is invisible to a
    // test that only checks the last write: the new keyframes are all present
    // either way, and it is the STALE ones from the first run that separate a
    // replace from a pile-up.
    const first = params({ seed: 3, baseOffsetFrames: 3 });
    const second = params({ seed: 41, baseOffsetFrames: 7, feel: 'snappy', order: 'byPositionX' });

    runChoreography({ kind: 'in', nodeIds: LAYERS, params: second });
    const fresh = engineState();

    revertChoreography();
    useChoreographyStore.setState({ byComp: {}, lastParams: null });
    clearAnimation();

    runChoreography({ kind: 'in', nodeIds: LAYERS, params: first });
    reapplyChoreography(second);

    expect(engineState()).toBe(fresh);
  });

  it('survives repeated re-applies without drifting', () => {
    const target = params({ seed: 12, baseOffsetFrames: 5 });
    runChoreography({ kind: 'in', nodeIds: LAYERS, params: target });
    const once = engineState();

    for (let i = 0; i < 4; i++) reapplyChoreography(params({ seed: 90 + i, baseOffsetFrames: 2 + i }));
    reapplyChoreography(target);

    expect(engineState()).toBe(once);
  });

  it('re-applies to the RECORDED layers, not to whatever is selected now', () => {
    runChoreography({ kind: 'in', nodeIds: [LAYERS[0]!], params: params() });
    useSelectionStore.setState({ ids: [LAYERS[2]!] } as never);

    const again = reapplyChoreography(params({ baseOffsetFrames: 8 }))!;

    expect(again.nodeIds).toEqual([LAYERS[0]]);
    expect(defaultAnimation.tracksFor(LAYERS[2]!)).toHaveLength(0);
  });

  it('keeps the ORIGINAL capture, not the state the last run left', () => {
    // Otherwise the second re-apply would restore the first re-apply's output
    // and the composition could never get back to where it started.
    const first = runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 2 }) })!;
    const again = reapplyChoreography(params({ seed: 77, baseOffsetFrames: 11 }))!;
    expect(again.captured.every((c) => c.keyframes === null)).toBe(true);
    expect(again.captured.length).toBeGreaterThanOrEqual(first.captured.length);
  });

  it('is one undo entry, restore included', () => {
    runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 4 }) });
    const before = historyDepth();
    reapplyChoreography(params({ seed: 21, baseOffsetFrames: 9 }));
    expect(historyDepth()).toBe(before + 1);
  });

  it('does nothing when there is no record to re-apply', () => {
    expect(reapplyChoreography(params())).toBeNull();
  });
});

describe('revert', () => {
  it('puts the composition back to before the choreography', () => {
    // Seeded with an existing track so this tests a genuine restore rather
    // than "delete everything", which would pass on empty layers.
    defaultAnimation.setKeyframe(LAYERS[0]!, 'rotation', 0, 0);
    defaultAnimation.setKeyframe(LAYERS[0]!, 'rotation', 1, 90);
    const original = engineState();

    runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ seed: 6 }) });
    expect(engineState()).not.toBe(original);

    expect(revertChoreography()).toBe(true);
    expect(engineState()).toBe(original);
  });

  it('removes tracks the choreography created, not just their values', () => {
    runChoreography({ kind: 'in', nodeIds: LAYERS, params: params() });
    revertChoreography();
    for (const id of LAYERS) expect(defaultAnimation.tracksFor(id)).toHaveLength(0);
  });

  it('forgets the record, so there is nothing left to re-apply', () => {
    runChoreography({ kind: 'in', nodeIds: LAYERS, params: params() });
    revertChoreography();
    expect(useChoreographyStore.getState().byComp[activeCompId()]).toBeUndefined();
    expect(revertChoreography()).toBe(false);
  });
});

describe('the stagger gesture shifts what is already there', () => {
  function seedAnimation(): void {
    for (const id of LAYERS) {
      defaultAnimation.setKeyframe(id, 'opacity', 0, 0);
      defaultAnimation.setKeyframe(id, 'opacity', 0.5, 100);
    }
  }

  it('offsets each layer by its planned frames and leaves the leader alone', () => {
    seedAnimation();
    const record = runChoreography({
      kind: 'stagger',
      nodeIds: LAYERS,
      params: params({ baseOffsetFrames: 6, swingPct: 0 }),
    })!;

    const starts = LAYERS.map((id) => defaultAnimation.getTrackKeyframes(id, 'opacity')![0]!.t);
    expect(starts[0]).toBeCloseTo(0, 6);
    expect(starts[1]).toBeCloseTo(6 / record.fps, 6);
    expect(starts[2]).toBeCloseTo(12 / record.fps, 6);
  });

  it('does not compound on a re-apply', () => {
    // The old fixed command shifted by a further 0.3s on every press, so three
    // presses meant 0.9s and the only way back was three undos.
    seedAnimation();
    const target = params({ baseOffsetFrames: 4, swingPct: 0 });
    runChoreography({ kind: 'stagger', nodeIds: LAYERS, params: target });
    const once = engineState();

    reapplyChoreography(params({ baseOffsetFrames: 20, swingPct: 0 }));
    reapplyChoreography(target);

    expect(engineState()).toBe(once);
  });

  it('captures the real keyframes, so a revert restores the original timing', () => {
    seedAnimation();
    const original = engineState();
    runChoreography({ kind: 'stagger', nodeIds: LAYERS, params: params({ baseOffsetFrames: 9 }) });
    revertChoreography();
    expect(engineState()).toBe(original);
  });

  it('only offers layers that actually have keyframes', () => {
    expect(staggerTargets()).toEqual([]);
    defaultAnimation.setKeyframe(LAYERS[1]!, 'opacity', 0, 50);
    expect(staggerTargets()).toEqual([LAYERS[1]]);
  });
});

describe('the Stagger Animations command id', () => {
  const staggerCommand = () =>
    buildChoreographyCommands().find((c) => String(c.id) === 'animation.sequenceLayers')!;

  it('is still registered under the id the Animation menu resolves', () => {
    expect(staggerCommand()).toBeDefined();
  });

  it('needs two animated layers, like the row it replaces', () => {
    expect(staggerCommand().enabled!()).toBe(false);
    for (const id of LAYERS) defaultAnimation.setKeyframe(id, 'opacity', 0, 100);
    expect(staggerCommand().enabled!()).toBe(true);
  });

  it('falls back to the legacy 0.3s until something has been applied', () => {
    // The menu row is labelled "(0.3s)" and cannot be edited from here, so the
    // first press has to keep that promise.
    expect(currentStaggerParams(30).baseOffsetFrames).toBe(9);
    expect(currentStaggerParams(24).baseOffsetFrames).toBe(7);
    expect(currentStaggerParams(30).swingPct).toBe(0);
  });

  it('uses the last-applied params once there are any', () => {
    runChoreography({ kind: 'in', nodeIds: LAYERS, params: params({ baseOffsetFrames: 13, swingPct: 40 }) });
    expect(currentStaggerParams(30).baseOffsetFrames).toBe(13);
    expect(currentStaggerParams(30).swingPct).toBe(40);
  });

  it('is the LAST registration of that id, so it is the one that wins', () => {
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

  it('applies, and files a stagger record', () => {
    for (const id of LAYERS) {
      defaultAnimation.setKeyframe(id, 'opacity', 0, 0);
      defaultAnimation.setKeyframe(id, 'opacity', 0.5, 100);
    }
    void staggerCommand().execute({} as never);
    const record = useChoreographyStore.getState().byComp[activeCompId()];
    expect(record?.kind).toBe('stagger');
    expect(record?.nodeIds).toEqual(LAYERS);
  });
});
