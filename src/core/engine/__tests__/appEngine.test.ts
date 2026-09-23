/**
 * B3-0: the app's engine instance and the helpers every area migration uses —
 * engineInstance (boot, rebuild on project open/close, subscriptions across
 * rebuilds), uiEdits (`edit`, `GestureSession`), the legacy UI refresh, and the
 * inspector command builders.
 */

import { getEventBus } from '@core/events/EventBus';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useUIStore } from '@stores/uiStore';
import { useSceneRevision } from '@stores/sceneStore';
import type { EventBatch } from '@motion/engine-api';
import { setupAppEngine, historyLabels } from '../__testHelpers__/appEngine';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { type Harness } from '../__testHelpers__/harness';
import {
  engine,
  engineGeneration,
  engineIdle,
  localEngine,
  onEngineReplaced,
  rebuildEngine,
  subscribeEngine,
} from '../engineInstance';
import { edit, GestureSession, describeEngineError } from '../uiEdits';
import { keyframeToggleCommands, stopwatchCommands, valueCommands } from '../propertyCommands';
import type { LocalEngine } from '../LocalEngine';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
let s: Scene;
beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  useUIStore.setState({ notifications: [] } as never);
});
afterEach(async () => { await h.dispose(); });

const opacity = (id: string): number => {
  const n = defaultSceneGraph.getNode(id)!;
  for (const c of n.components) {
    const v = (c.props as Record<string, unknown>).opacity;
    if (typeof v === 'number') return v;
  }
  return 1;
};

describe('engineInstance', () => {
  test('engine() is the booted singleton', () => {
    expect(engine()).toBe(h.engine);
    expect(localEngine()).toBe(h.engine);
  });

  test('ProjectLoaded / ProjectUnloaded rebuild the engine; subscribers follow and get documentReset', async () => {
    const seen: EventBatch[] = [];
    const off = subscribeEngine((b) => seen.push(b));
    const replaced: LocalEngine[] = [];
    const off2 = onEngineReplaced((e) => replaced.push(e));
    const gen = engineGeneration();

    getEventBus().emit('ProjectLoaded', { projectId: 'p1' });
    const next = localEngine()!;
    expect(next).not.toBe(h.engine);
    expect(engineGeneration()).toBe(gen + 1);
    expect(replaced).toEqual([next]);
    expect(seen.at(-1)!.events[0]).toMatchObject({ type: 'documentReset', reason: 'opened' });

    // The new instance drives the same live document, and its events reach the old subscription.
    seen.length = 0;
    await edit('Hide', { type: 'setLayerSwitches', layers: [s.A], patch: { visible: false } });
    expect(defaultSceneGraph.getNode(s.A)!.visible).toBe(false);
    expect(seen.some((b) => b.toRevision > b.fromRevision && b.events.length > 0)).toBe(true);

    getEventBus().emit('ProjectUnloaded', { projectId: 'p1' });
    expect(seen.at(-1)!.events[0]).toMatchObject({ type: 'documentReset', reason: 'created' });
    off();
    off2();
  });

  test('a gesture begun on an old instance dies with it (nothing lands on the new history)', async () => {
    const g = new GestureSession('Drag');
    g.send({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.3 }, time: 0 });
    await engineIdle();
    rebuildEngine('opened');
    const before = historyLabels().length;
    g.send({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.1 }, time: 0 });
    await g.end();
    await engineIdle();
    expect(historyLabels().length).toBe(before);
    expect(localEngine()!.isGestureOpen).toBe(false);
  });
});

describe('edit()', () => {
  test('several commands are ONE undo entry with the given label; undo restores all', async () => {
    const res = await edit('Hide 2 layers', [
      { type: 'setLayerSwitches', layers: [s.A], patch: { visible: false } },
      { type: 'setLayerSwitches', layers: [s.B], patch: { visible: false } },
    ]);
    expect(res.ok).toBe(true);
    expect(historyLabels().at(-1)).toBe('Hide 2 layers');
    expect(defaultSceneGraph.getNode(s.A)!.visible).toBe(false);
    expect(defaultSceneGraph.getNode(s.B)!.visible).toBe(false);
    await h.run({ type: 'undo' });
    expect(defaultSceneGraph.getNode(s.A)!.visible).toBe(true);
    expect(defaultSceneGraph.getNode(s.B)!.visible).toBe(true);
  });

  test('a typed error changes nothing and is toasted (unless quiet)', async () => {
    const doc = h.doc();
    const res = await edit('Set Opacity', { type: 'setProperty', prop: { layer: 'nope', path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.5 } });
    expect(res.ok).toBe(false);
    expect(h.doc()).toBe(doc);
    const notes = useUIStore.getState().notifications;
    expect(notes.at(-1)?.message).toMatch(/^Set Opacity: /);
    const n = notes.length;
    await edit('Quiet', { type: 'setProperty', prop: { layer: 'nope', path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.5 } }, { quiet: true });
    expect(useUIStore.getState().notifications.length).toBe(n);
  });

  test('describeEngineError names the action and the reason', () => {
    expect(describeEngineError('Move', { code: 'locked', message: "layer 'x' is locked" })).toBe("Move: layer 'x' is locked");
    expect(describeEngineError('', { code: 'locked', message: '' })).toBe('is locked');
  });
});

describe('GestureSession', () => {
  test('a drag is ONE entry: first inverse, last value; undo restores the start', async () => {
    const start = opacity(s.A);
    const g = new GestureSession('Set Opacity');
    for (const v of [0.9, 0.7, 0.5, 0.25]) {
      g.send({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: v }, time: 0 });
    }
    await g.end();
    expect(opacity(s.A)).toBeCloseTo(0.25);
    expect(historyLabels().filter((l) => l === 'Set Opacity')).toHaveLength(1);
    await h.run({ type: 'undo' });
    expect(opacity(s.A)).toBeCloseTo(start);
  });

  test('latest wins: while a message is in flight only the newest pending one is sent', async () => {
    const spy = jest.spyOn(h.engine, 'execute');
    const g = new GestureSession('Set Opacity');
    for (let i = 1; i <= 20; i++) {
      g.send({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: i / 20 }, time: 0 });
    }
    await g.end();
    const sets = spy.mock.calls.filter(([c]) => c.type === 'setProperty');
    expect(sets.length).toBeLessThan(20);
    expect(opacity(s.A)).toBeCloseTo(1);
    spy.mockRestore();
  });

  test('cancel (Esc) reverts everything and records nothing', async () => {
    const doc = h.doc();
    const n = historyLabels().length;
    const g = new GestureSession('Set Opacity');
    g.send({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.1 }, time: 0 });
    await engineIdle();
    expect(opacity(s.A)).toBeCloseTo(0.1);
    await g.cancel();
    expect(h.doc()).toBe(doc);
    expect(historyLabels().length).toBe(n);
  });

  test('a leaked open gesture does not block the next drag', async () => {
    await h.engine.beginGesture('leaked');
    const g = new GestureSession('Set Opacity');
    g.send({ type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.4 }, time: 0 });
    await g.end();
    expect(opacity(s.A)).toBeCloseTo(0.4);
    expect(h.engine.isGestureOpen).toBe(false);
  });
});

describe('legacy UI refresh', () => {
  test('a forward edit announces itself: attributed AnimationChanged + a scene revision, no extra history', async () => {
    const seen: Array<string | undefined> = [];
    const sub = getEventBus().on('AnimationChanged', (p) => seen.push(p?.nodeId));
    const rev = useSceneRevision.getState().rev;
    const n = historyLabels().length;
    await edit('Set Opacity', { type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.5 } });
    jest.advanceTimersByTime(2000); // the 700 ms recorder must have nothing to record
    sub.dispose();
    expect(seen).toContain(s.A);
    expect(useSceneRevision.getState().rev).toBeGreaterThan(rev);
    expect(historyLabels().length).toBe(n + 1);
  });

  test('a structural edit bumps the scene (SceneGraphChanged)', async () => {
    let changed = 0;
    const sub = getEventBus().on('SceneGraphChanged', () => { changed += 1; });
    await edit('New Solid', { type: 'createLayer', comp: s.comp, kind: 'solid', init: [] });
    sub.dispose();
    expect(changed).toBeGreaterThan(0);
  });

  test('the refresh traffic is not mistaken for an external edit (no resync)', async () => {
    await edit('Set Opacity', { type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.5 } });
    h.batches.length = 0;
    await edit('Set Opacity', { type: 'setProperty', prop: { layer: s.A, path: 'transform/opacity' }, value: { kind: 'scalar', value: 0.6 } });
    expect(h.batches.flatMap((b) => b.events).some((e) => e.type === 'documentReset')).toBe(false);
  });
});

describe('inspector command builders', () => {
  test('valueCommands: static layers get setProperties; auto-keyframe adds keys', async () => {
    const cmds = valueCommands('opacity', [{ nodeId: s.A, value: 0.5 }, { nodeId: s.B, value: 0.5 }], { seconds: 0 });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.type).toBe('setProperties');
    const keyed = valueCommands('opacity', [{ nodeId: s.A, value: 0.5 }], { seconds: 1, autoKeyframe: true });
    expect(keyed[0]!.type).toBe('addKeyframes');
    await edit('Set Opacity', keyed);
    expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(true);
  });

  test('valueCommands skips layers that do not have the property', () => {
    expect(valueCommands('opacity', [{ nodeId: 'ghost', value: 0.5 }], { seconds: 0 })).toEqual([]);
  });

  test('stopwatch on → keys; diamond toggles a key at the playhead by engine id; stopwatch off', async () => {
    await edit('Animate Opacity', stopwatchCommands([s.A, s.B], 'opacity', 0));
    expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(true);
    expect(defaultAnimation.isAnimated(s.B, 'opacity')).toBe(true);

    const add = await keyframeToggleCommands(engine(), [s.A], 'opacity', 1);
    expect(add[0]!.type).toBe('addKeyframes');
    await edit('Add keyframe', add);
    expect(defaultAnimation.getTrackKeyframes(s.A, 'opacity')!.length).toBe(2);

    const del = await keyframeToggleCommands(engine(), [s.A], 'opacity', 1);
    expect(del[0]!.type).toBe('deleteKeyframes');
    await edit('Remove keyframe', del);
    expect(defaultAnimation.getTrackKeyframes(s.A, 'opacity')!.length).toBe(1);

    await edit('Remove animation', stopwatchCommands([s.A, s.B], 'opacity', 0));
    expect(defaultAnimation.isAnimated(s.A, 'opacity')).toBe(false);
    expect(defaultAnimation.isAnimated(s.B, 'opacity')).toBe(false);
  });
});
