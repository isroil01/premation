import { AnimationEngine } from '@motion/animation';
import {
  AnimEditCommand,
  beginAnimEdit,
  captureAnimEdit,
  diffTracks,
} from './animationCommands';

/** Fresh engine per test — the module helpers accept an explicit engine. */
function engine(): AnimationEngine {
  return new AnimationEngine();
}

/** Serialize the tracks portion of a snapshot for exact-equality assertions. */
function tracksOf(a: AnimationEngine): string {
  return JSON.stringify(a.snapshot().tracks);
}

describe('AnimationEngine track capture/restore', () => {
  test('getTrackKeyframes returns null for an absent track and a deep copy otherwise', () => {
    const a = engine();
    expect(a.getTrackKeyframes('n', 'x')).toBeNull();
    a.setKeyframe('n', 'x', 0, 10);
    const kfs = a.getTrackKeyframes('n', 'x');
    expect(kfs).toEqual([{ t: 0, value: 10, easing: undefined }]);
    // Mutating the returned copy must not affect the engine.
    kfs![0]!.value = 999;
    expect(a.sample('n', 'x', 0)).toBe(10);
  });

  test('setTrackKeyframes(null) removes the track and prunes the node', () => {
    const a = engine();
    a.setKeyframe('n', 'x', 0, 10);
    a.setTrackKeyframes('n', 'x', null);
    expect(a.isAnimated('n', 'x')).toBe(false);
    expect(a.hasAnimation('n')).toBe(false);
  });
});

describe('diffTracks', () => {
  test('detects added, removed and modified tracks only', () => {
    const before = { tracks: { n: { x: { nodeId: 'n', prop: 'x', keyframes: [{ t: 0, value: 0 }] } } }, expressions: {} };
    const after = {
      tracks: {
        n: {
          x: { nodeId: 'n', prop: 'x', keyframes: [{ t: 0, value: 5 }] }, // modified
          y: { nodeId: 'n', prop: 'y', keyframes: [{ t: 0, value: 1 }] }, // added
        },
      },
      expressions: {},
    };
    const changes = diffTracks(before, after);
    const byProp = Object.fromEntries(changes.map((c) => [c.prop, c]));
    expect(Object.keys(byProp).sort()).toEqual(['x', 'y']);
    expect(byProp.x!.before).toEqual([{ t: 0, value: 0 }]);
    expect(byProp.x!.after).toEqual([{ t: 0, value: 5 }]);
    expect(byProp.y!.before).toBeNull();
  });

  test('returns nothing when identical', () => {
    const mk = () => ({ tracks: { n: { x: { nodeId: 'n', prop: 'x', keyframes: [{ t: 0, value: 0 }] } } }, expressions: {} });
    expect(diffTracks(mk(), mk())).toEqual([]);
  });
});

describe('captureAnimEdit round-trip (execute/undo/redo)', () => {
  const cases: Array<[string, (a: AnimationEngine) => void, (a: AnimationEngine) => void]> = [
    [
      'add keyframe',
      (a) => { a.setKeyframe('n', 'x', 0, 10); },
      (a) => a.setKeyframe('n', 'x', 5, 50),
    ],
    [
      'move keyframe',
      (a) => { a.setKeyframe('n', 'x', 0, 10); a.setKeyframe('n', 'x', 2, 20); },
      (a) => a.moveKeyframe('n', 'x', 2, 4),
    ],
    [
      'delete keyframe',
      (a) => { a.setKeyframe('n', 'x', 0, 10); a.setKeyframe('n', 'x', 2, 20); },
      (a) => a.removeKeyframe('n', 'x', 2),
    ],
    [
      'change easing',
      (a) => { a.setKeyframe('n', 'x', 0, 10); a.setKeyframe('n', 'x', 2, 20); },
      (a) => a.setEasing('n', 'x', 0, 'easeInOut'),
    ],
    [
      'update value + bezier',
      (a) => { a.setKeyframe('n', 'x', 0, 10); a.setKeyframe('n', 'x', 2, 20); },
      (a) => a.updateKeyframe('n', 'x', 0, { value: 99, easing: 'bezier' }),
    ],
    [
      'remove whole track',
      (a) => { a.setKeyframe('n', 'x', 0, 10); a.setKeyframe('n', 'x', 2, 20); },
      (a) => a.removeTrack('n', 'x'),
    ],
  ];

  test.each(cases)('%s reverses exactly', (_label, seed, mutate) => {
    const a = engine();
    seed(a);
    const initial = tracksOf(a);

    const cmd = captureAnimEdit('edit', () => mutate(a), { engine: a });
    expect(cmd).not.toBeNull();
    const afterEdit = tracksOf(a);
    expect(afterEdit).not.toBe(initial); // the mutation actually did something

    cmd!.undo();
    expect(tracksOf(a)).toBe(initial); // exact restore

    cmd!.execute(); // redo
    expect(tracksOf(a)).toBe(afterEdit);

    cmd!.undo();
    expect(tracksOf(a)).toBe(initial);
  });

  test('a no-op mutation captures no command', () => {
    const a = engine();
    a.setKeyframe('n', 'x', 0, 10);
    const cmd = captureAnimEdit('noop', () => { /* nothing */ }, { engine: a });
    expect(cmd).toBeNull();
  });
});

describe('composite (AI preset) edits are one reversible transaction', () => {
  test('multi-track authoring undoes in a single step', () => {
    const a = engine();
    const initial = tracksOf(a);
    const cmd = captureAnimEdit('AI: Reveal', () => {
      a.setKeyframe('n', 'opacity', 0, 0);
      a.setKeyframe('n', 'opacity', 0.6, 100);
      a.setKeyframe('n', 'y', 0, 24);
      a.setKeyframe('n', 'y', 0.6, 0);
    }, { engine: a });
    expect(cmd!.size).toBe(2); // two tracks touched
    const authored = tracksOf(a);

    cmd!.undo();
    expect(tracksOf(a)).toBe(initial);
    cmd!.execute();
    expect(tracksOf(a)).toBe(authored);
  });
});

describe('beginAnimEdit (drag) records the whole drag as one command', () => {
  test('captures grab→release, reversible in one step', () => {
    const a = engine();
    a.setKeyframe('n', 'x', 0, 0);
    a.setKeyframe('n', 'x', 2, 100);
    const initial = tracksOf(a);

    const tx = beginAnimEdit(a);
    // Simulate many live pointermove mutations.
    a.updateKeyframe('n', 'x', 2, { t: 3 });
    a.updateKeyframe('n', 'x', 3, { value: 80 });
    a.updateKeyframe('n', 'x', 3, { value: 60 });
    const afterDrag = tracksOf(a);

    const cmd = tx.commit('Edit keyframe');
    expect(cmd).not.toBeNull();
    cmd!.undo();
    expect(tracksOf(a)).toBe(initial);
    cmd!.execute();
    expect(tracksOf(a)).toBe(afterDrag);
  });
});

describe('command merging (scrub coalescing)', () => {
  test('mergeFrom keeps the original before and adopts the latest after', () => {
    const a = engine();
    a.setKeyframe('n', 'x', 0, 0);
    const initial = tracksOf(a);

    const c1 = captureAnimEdit('set', () => a.setKeyframe('n', 'x', 0, 10), { engine: a, mergeKey: 'k' })!;
    const c2 = captureAnimEdit('set', () => a.setKeyframe('n', 'x', 0, 20), { engine: a, mergeKey: 'k' })!;
    c1.mergeFrom(c2);
    const merged = tracksOf(a);

    c1.undo();
    expect(tracksOf(a)).toBe(initial); // all the way back to before the first edit
    c1.execute();
    expect(tracksOf(a)).toBe(merged); // forward to the latest value
    expect(a.sample('n', 'x', 0)).toBe(20);
  });
});

describe('AnimEditCommand shape', () => {
  test('is a well-formed undoable Command', () => {
    const a = engine();
    const cmd = new AnimEditCommand(a, [], 'noop');
    expect(cmd.id).toBe('anim.edit');
    expect(typeof cmd.execute).toBe('function');
    expect(typeof cmd.undo).toBe('function');
  });
});
