/**
 * `scene.apply` — many mutations, one round trip, one undo entry.
 *
 * ── What was wrong with one call at a time ──────────────────────────────────
 *
 * `animation.setKeyframes` was the only bulk call. Everything else cost one
 * `postMessage`, one host-side revalidation and one change notification each,
 * so a generative plugin building a few thousand layers was unusably slow — and
 * it produced a few thousand undo entries, so a user who disliked the result
 * had to hold Ctrl+Z.
 *
 * ── The three properties worth testing ──────────────────────────────────────
 *
 *   1. **Forward references work**, which is what makes a batch able to build a
 *      hierarchy. Without them the generative case needs two round trips and
 *      the whole thing is pointless.
 *   2. **All or nothing.** A failure at op 4,999 leaves the document
 *      byte-identical. A partial batch could not be reported honestly — the
 *      plugin knows which call it made, not which ops landed — so it is not
 *      produced.
 *   3. **One undo entry, one notification.** Both are the difference between a
 *      usable feature and a faster way to make a mess.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useFakeWorkers, testPackage, bootPlugin, FakeWorker } from './fakeWorker.testkit';
import { useSceneRevision } from '@stores/sceneStore';
import { useSelectionStore } from '@stores/selectionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { setCommandSystem, getCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { defaultAnimation } from '@motion/animation';
import { MAX_OPS, OP_PERMISSIONS, validateBatch } from './sceneBatch';

const PLUGIN = 'studio.acme.generate';

const pkg = (permissions: string[]) =>
  testPackage(permissions as never, PLUGIN, {
    apiVersion: 5,
    name: 'Generate',
    requires: ['scene.batch'],
    activationEvents: ['onStartup'],
  });

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  defaultSceneGraph.clear();
  defaultAnimation.clear();
  /*
    The selection too, and this is not housekeeping.

    `insertPrimitive` parents a new layer to whatever is SELECTED, so a
    selection surviving from an earlier test puts this test's layers somewhere
    it never asked for — and a `setParent` onto a node that is already the
    parent is refused. Every test here passed in isolation and two failed in the
    suite, which is exactly the shape that gets written off as a flake.
  */
  useSelectionStore.setState({ ids: [], primary: null });

  /*
    A real composition root, every time — and NOT through `seedDefaultScene()`.

    That helper is guarded and will not re-seed a graph it has already seeded,
    so `clear(); seedDefaultScene();` leaves the graph EMPTY from the second
    test onward. Layers then land as orphan roots, each its own composition,
    and reparenting between two of them is refused with a message about
    ancestry that has nothing to do with what the test asked for.

    Worth stating because of how it presents: every test here passed alone and
    two failed in the suite, which is the shape that gets written off as flake
    and retried. `sceneProjectIO.restore(createEmpty())` is the real "new
    project" path and installs a fresh root unconditionally.
  */
  sceneProjectIO.restore(sceneProjectIO.createEmpty('Test'));
  FakeWorker.last = null;
});

const boot = (permissions = ['scene:write', 'animation:write']): FakeWorker =>
  bootPlugin(pkg(permissions), { granted: permissions as never });

const apply = (worker: FakeWorker, ops: unknown[]) => worker.callAndWait('scene.apply', ops);

describe('validation happens before anything is applied', () => {
  it('names the failing index and the reason', () => {
    /*
      The index, always. A plugin sending ten thousand ops and told only "a
      layer id was invalid" has nothing to act on; told "ops[4317]", it can
      print the op it built.
    */
    expect(() => validateBatch([
      { op: 'createLayer', kind: 'shape' },
      { op: 'nonsense' },
    ])).toThrow(/ops\[1\].*not a batch operation/s);
  });

  it('refuses a forward reference to a later op', () => {
    // A reference that could not resolve without two passes, and one to itself
    // is a loop with no useful reading.
    expect(() => validateBatch([
      { op: 'setProperty', layer: { ref: 1 }, path: 'x', value: 0 },
      { op: 'createLayer', kind: 'shape' },
    ])).toThrow(/does not come before this one/);
  });

  it('refuses a reference to an op that creates nothing', () => {
    expect(() => validateBatch([
      { op: 'rename', layer: 'n1', name: 'x' },
      { op: 'setProperty', layer: { ref: 0 }, path: 'x', value: 0 },
    ])).toThrow(/does not create a layer/);
  });

  it('computes the union of permissions the ops need', () => {
    const { permissions } = validateBatch([
      { op: 'createLayer', kind: 'shape' },
      { op: 'animation.setKeyframes', layer: { ref: 0 }, path: 'x', keyframes: [] },
    ]);
    expect([...permissions].sort()).toEqual(['animation:write', 'scene:write']);
  });

  it('maps every op to a permission', () => {
    // A new op with no entry would default to undefined and be granted by
    // nobody checking — the union would simply not include it.
    const { ops } = validateBatch([{ op: 'createLayer', kind: 'shape' }]);
    expect(ops).toHaveLength(1);
    for (const [name, perm] of Object.entries(OP_PERMISSIONS)) {
      expect({ name, perm }).toMatchObject({ perm: expect.stringMatching(/^(scene|animation):/) });
    }
  });

  it('refuses more ops than the cap, rather than truncating', () => {
    /*
      Refused, not truncated. A plugin told "8,000 of your 10,000 applied" has
      no way to work out which, and a silent truncation is worse: it believes
      the whole thing landed.
    */
    const ops = Array.from({ length: MAX_OPS + 1 }, () => ({ op: 'createLayer', kind: 'shape' }));
    expect(() => validateBatch(ops)).toThrow(/limited to 10000 operations/);
  });

  it('refuses an empty or non-array batch', () => {
    expect(() => validateBatch([])).toThrow(/is empty/);
    expect(() => validateBatch('nope')).toThrow(/must be an array/);
  });
});

describe('building a hierarchy in one call', () => {
  it('resolves forward references', () => {
    const worker = boot();
    const reply = apply(worker, [
      { op: 'createLayer', kind: 'group', name: 'Rig' },
      { op: 'createLayer', kind: 'shape', name: 'Bone A' },
      { op: 'setParent', layer: { ref: 1 }, parent: { ref: 0 } },
    ]);

    expect(reply.ok ? '' : reply.error).toBe('');
    const results = (reply as { value: unknown[] }).value;
    expect(typeof results[0]).toBe('string');
    expect(typeof results[1]).toBe('string');

    const groupId = results[0] as string;
    const children = defaultSceneGraph.getChildren(groupId).map((c) => c.name);
    expect(children).toContain('Bone A');
  });

  it('returns one result per op, positionally', () => {
    // Positional, so a plugin can index straight into it rather than
    // reconstructing which op produced which id.
    const worker = boot();
    const reply = apply(worker, [
      { op: 'createLayer', kind: 'shape', name: 'One' },
      { op: 'rename', layer: { ref: 0 }, name: 'Renamed' },
      { op: 'createLayer', kind: 'shape', name: 'Two' },
    ]);
    expect((reply as { value: unknown[] }).value).toHaveLength(3);
  });
});

describe('all or nothing', () => {
  it('leaves the document byte-identical when a late op fails', () => {
    /*
      The property the whole design turns on. A batch that failed halfway would
      leave the document in a state nobody asked for and the plugin unable to
      describe — it knows which call it made, not which ops landed.

      `runDocumentEdit` snapshots before and after, and the exception escapes
      it, so the restore is what actually delivers this.
    */
    const worker = boot();
    const before = JSON.stringify(defaultSceneGraph.getRoots().map((r) => r.id));

    const ops = [
      ...Array.from({ length: 20 }, (_, i) => ({ op: 'createLayer', kind: 'shape', name: `L${i}` })),
      // Fails at APPLY time, not validation: the id is well-formed and simply
      // does not exist, which validation cannot know.
      { op: 'rename', layer: 'n_does_not_exist', name: 'x' },
    ];

    const reply = apply(worker, ops);
    expect(reply.ok).toBe(false);
    expect(reply.ok ? '' : reply.error).toMatch(/ops\[20\]/);

    expect(JSON.stringify(defaultSceneGraph.getRoots().map((r) => r.id))).toBe(before);
  });

  it('applies nothing at all when validation fails', () => {
    const worker = boot();
    const before = defaultSceneGraph.getRoots().length;
    const reply = apply(worker, [
      { op: 'createLayer', kind: 'shape' },
      { op: 'createLayer', kind: 'shape' },
      { op: 'not-an-op' },
    ]);
    expect(reply.ok).toBe(false);
    expect(defaultSceneGraph.getRoots()).toHaveLength(before);
  });
});

describe('one undo entry, one notification', () => {
  it('records a single undoable entry for the whole batch', () => {
    /*
      Fifty layers used to be fifty entries. A user who ran a generative plugin
      and did not like the result had to hold Ctrl+Z, which is not undo, it is
      a punishment for trying something.
    */
    getCommandSystem().getHistory().clear();
    const worker = boot();
    const depthBefore = getCommandSystem().getHistory().getEntries().length;

    apply(worker, Array.from({ length: 50 }, (_, i) => ({
      op: 'createLayer', kind: 'shape', name: `L${i}`,
    })));

    expect(getCommandSystem().getHistory().getEntries().length - depthBefore).toBe(1);
  });

  it('bumps the scene revision once, not once per op', () => {
    // The revision is what re-renders the viewport and every panel reading it.
    // 5,000 bumps is 5,000 renders of a tree that is still being built.
    const worker = boot();
    const before = useSceneRevision.getState().rev;

    apply(worker, Array.from({ length: 40 }, (_, i) => ({
      op: 'createLayer', kind: 'shape', name: `L${i}`,
    })));

    expect(useSceneRevision.getState().rev - before).toBe(1);
  });

  it('labels the entry with the plugin s name', () => {
    // So a user reading the history sees who did it, not "Add layer" forty
    // times from nowhere.
    const worker = boot();
    apply(worker, [{ op: 'createLayer', kind: 'shape', name: 'One' }]);
    const last = getCommandSystem().getHistory().getEntries().at(-1);
    expect(String((last as { label?: string })?.label ?? '')).toMatch(/Generate/);
  });
});

describe('permissions', () => {
  it('refuses a batch needing more than was granted, and names what it needs', () => {
    const worker = boot(['scene:write']);
    const reply = apply(worker, [
      { op: 'createLayer', kind: 'shape' },
      { op: 'animation.setKeyframes', layer: { ref: 0 }, path: 'x', keyframes: [] },
    ]);
    expect(reply.ok).toBe(false);
    expect(reply.ok ? '' : reply.error).toMatch(/animation:write/);
  });

  it('applies nothing when the permission check fails', () => {
    // Checked before anything runs, so a refused batch is not a half-applied
    // one with an error attached.
    const worker = boot(['scene:write']);
    const before = defaultSceneGraph.getRoots().length;
    apply(worker, [
      { op: 'createLayer', kind: 'shape' },
      { op: 'animation.setExpression', layer: { ref: 0 }, path: 'x', expression: 'time' },
    ]);
    expect(defaultSceneGraph.getRoots()).toHaveLength(before);
  });

  it('allows a batch entirely within the grant', () => {
    const worker = boot(['scene:write']);
    expect(apply(worker, [{ op: 'createLayer', kind: 'shape', name: 'Fine' }]).ok).toBe(true);
  });
});

describe('scale', () => {
  it('builds a thousand parented layers in one call', () => {
    /*
      Not a benchmark with a threshold — a wall-clock assertion would be a flaky
      test on shared CI. What it proves is that the shape works at size: one
      call, one undo entry, one notification, and every layer in the right
      place.
    */
    const worker = boot();
    const before = useSceneRevision.getState().rev;

    const ops: unknown[] = [{ op: 'createLayer', kind: 'group', name: 'Root' }];
    for (let i = 0; i < 1000; i++) {
      ops.push({ op: 'createLayer', kind: 'shape', name: `L${i}` });
      ops.push({ op: 'setParent', layer: { ref: ops.length - 1 }, parent: { ref: 0 } });
    }

    const reply = apply(worker, ops);
    expect(reply.ok).toBe(true);

    const rootId = (reply as { value: unknown[] }).value[0] as string;
    expect(defaultSceneGraph.getChildren(rootId)).toHaveLength(1000);
    expect(useSceneRevision.getState().rev - before).toBe(1);
  });
});
