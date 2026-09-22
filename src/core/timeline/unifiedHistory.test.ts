/**
 * One undo history (NATIVE_CORE_PLAN §4 T1).
 *
 * The editor keeps two undo mechanisms that do not know about each other:
 *
 *   • the TIMELINE ENGINE records clip geometry as explicit commands whose
 *     closures hold the live `Layer` object (`Timeline.trimLayer`), and
 *   • the APP auto-captures a debounced (700 ms) scene + animation SNAPSHOT
 *     that carries no clip geometry at all (`historyStore`).
 *
 * Both push onto the same `HistoryService`, so the stack LOOKS unified, but
 * the entries restore different halves of the document and three seams leak:
 *
 *   S1  A scene snapshot restore re-adds every node, and `syncFromScene`
 *       seeds a re-added node a FULL-LENGTH bar with a fresh id — a trim is
 *       lost by undoing an unrelated scene-tree delete.
 *   S2  An engine push emits `UndoStackChanged`; the baseline sync answers by
 *       re-capturing `lastState`, which SWALLOWS a scene edit still inside
 *       its 700 ms debounce — the edit is never undoable.
 *   S3  After a document restore (`runAsOneHistoryEntry`, used by
 *       Pre-compose) every bar is a new `Layer` object, so an older engine
 *       command's undo writes to a detached one — a no-op.
 *
 * Every case runs twice, `unifiedHistory` OFF and ON:
 *
 *   OFF  Today's behaviour. Cases that document a bug are `test.failing`, so
 *        the suite is green AND the evidence is pinned: the day one of them
 *        starts passing, the `failing` wrapper fails and someone has to look.
 *   ON   The T1 contract — the gate. (Default in the app since T1 landed;
 *        OFF stays for one release as the escape hatch.)
 */

import { getTimelineController } from './TimelineController';
import { deleteSelectedLayers } from '@core/scene/sceneInsert';
import { precomposeLayers, type PrecomposeOptions } from '@core/composition/precompose';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getEventBus } from '@core/events/EventBus';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import { setUnifiedHistory } from '@core/config/flags';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { bumpScene } from '@stores/sceneStore';
import { useHistoryStore, performUndo, performRedo, attachHistoryRecording } from '@stores/historyStore';
import { defaultAnimation } from '@motion/animation';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { CommandServices } from '@core/commands/Command';
import type { SceneNode } from '@core/types';

jest.useFakeTimers();

/** The store's `RECORD_DEBOUNCE_MS`, not exported. */
const DEBOUNCE_MS = 700;
/** 10 s comp @ 30 fps. */
const FPS = 30;
const FULL = 300;

const MOVE: PrecomposeOptions = { name: 'Pre-comp 1', mode: 'move', adjustDuration: false, openNew: false };

/* ---------------------------------------------------------------- harness */

function addLayer(id: string, parent: string): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 10, y: 10, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff' } },
    ],
  } as never);
}

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
}

/**
 * A real, observable scene edit through the inspector's write path — the one
 * that emits `NodeUpdated`, which is what `attachHistoryRecording` listens to.
 * (`SceneGraph.setLocalTransform` writes the component and announces nothing,
 * so an edit made that way would never schedule a capture and the case would
 * fail for the wrong reason.)
 */
function moveTo(id: string, x: number): void {
  expect(updateNodeComponentProp(defaultSceneGraph, id, `${id}_t`, 'x', x)).toBe(true);
}

function xOf(id: string): number | undefined {
  const t = defaultSceneGraph.getNode(id)?.components.find((c) => c.type === 'Transform');
  return t?.props.x as number | undefined;
}

/** `[start, end]` of the node's first bar, or null when it has none. */
function barOf(nodeId: string): [number, number] | null {
  const l = getTimelineController().getLayersForNode(nodeId)[0];
  return l ? [l.start, l.end] : null;
}

function labels(): string[] {
  return getCommandSystem().getHistory().getEntries().map((e) => e.label);
}

/** Trim a node's only bar to absolute frames, through the engine (undoable). */
function trimTo(nodeId: string, start: number, end: number): void {
  const c = getTimelineController();
  const id = c.getLayersForNode(nodeId)[0]!.id;
  if (start !== 0) c.trimClipTo(id, 'start', start / FPS);
  if (end !== FULL) c.trimClipTo(id, 'end', end / FPS);
  c.invalidateLayerIndex();
}

function selectAndDelete(...ids: string[]): void {
  useSelectionStore.getState().set(ids);
  deleteSelectedLayers();
}

let subscriptions: Array<{ dispose(): void }> = [];

function setUp(flagOn: boolean): void {
  setUnifiedHistory(flagOn);
  setCommandSystem(new CommandSystem({ services: {} as CommandServices, getState: () => ({}) }));
  getTimelineController().reset();
  resetScene();
  defaultAnimation.clear?.();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
  const proj = useProjectStore.getState();
  proj.actions.resetTabs();
  proj.actions.replaceComps({
    comp_root: {
      id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: FPS,
      durationSeconds: 10, background: '#101014', transparent: false, startFrame: 0,
    },
  });
  const tabId = proj.actions.openTab('comp_root', ['comp_root'], 'Main');
  proj.actions.setActiveTab(tabId);
  useSelectionStore.getState().clear();

  // What the booted app wires (`Application.boot` + `App.tsx`): the debounced
  // recorder with its baseline sync, and the structural mirror that reconciles
  // the engine's clips against the scene after every graph change. Without
  // the mirror a snapshot restore leaves stale bars in place and S1 would
  // pass for the wrong reason.
  subscriptions = [
    getEventBus().on('SceneGraphChanged', () => getTimelineController().syncFromScene()),
    attachHistoryRecording(),
  ];
  useHistoryStore.getState().reset();
  useHistoryStore.getState().record('Open', true);
}

function tearDown(): void {
  for (const s of subscriptions) s.dispose();
  subscriptions = [];
  jest.clearAllTimers();
  setUnifiedHistory(false);
}

/* ------------------------------------------------------------------ cases */

/** Flag-ON variants are the T1 gate. (They were `T1_STRICT`-gated while the
 *  implementation was in flight; the flag is default-on now.) */
const itOn = test;

type Case = (name: string, fn: () => void | Promise<void>) => void;
/** Jest's callback type refuses `void | Promise<void>`; normalise to a promise. */
const run = (fn: () => void | Promise<void>) => async () => { await fn(); };

describe.each([false, true])('unified history (flag %s)', (flagOn) => {
  /**
   * `pinned` — the behaviour the flag is meant to fix. OFF: the case must
   * FAIL today (`test.failing`), which is the evidence for the T1 seam. ON:
   * the case must pass once the implementation lands.
   * `holds` — coherence that already holds today and must keep holding.
   */
  const pinned: Case = flagOn
    ? (name, fn) => itOn(name, run(fn))
    : (name, fn) => test.failing(`${name} — documents today's incoherence`, run(fn));
  const holds: Case = flagOn ? (name, fn) => itOn(name, run(fn)) : (name, fn) => test(name, run(fn));

  beforeEach(() => setUp(flagOn));
  afterEach(tearDown);

  describe('S1 — a scene-tree delete does not forget a trim', () => {
    pinned('undoing the delete puts the TRIMMED bar back, not a full-length one', () => {
      addLayer('rect', 'comp_root');
      getTimelineController().syncFromScene('comp_root');
      trimTo('rect', 30, 200);
      expect(barOf('rect')).toEqual([30, 200]);

      selectAndDelete('rect');
      expect(defaultSceneGraph.getNode('rect')).toBeUndefined();
      expect(barOf('rect')).toBeNull();
      expect(labels()).toContain('Delete layer');

      performUndo();

      expect(defaultSceneGraph.getNode('rect')).toBeTruthy();
      // Today: `syncFromScene` re-seeds the restored node `[0, FULL]`.
      expect(barOf('rect')).toEqual([30, 200]);
    });

    pinned('a trimmed neighbour keeps its geometry across the delete and its undo', () => {
      addLayer('first', 'comp_root');
      addLayer('second', 'comp_root');
      getTimelineController().syncFromScene('comp_root');
      trimTo('first', 0, 60);
      trimTo('second', 60, 120);

      selectAndDelete('first');
      expect(barOf('second')).toEqual([60, 120]);

      performUndo();

      expect(barOf('second')).toEqual([60, 120]);
      expect(barOf('first')).toEqual([0, 60]);
    });
  });

  describe('S2 — an engine push does not swallow a pending scene edit', () => {
    // `holds` in BOTH modes since T1 step 2: the engine's `onBeforeRun` hook
    // flushes the pending capture BEFORE the command mutates (TimelineController
    // `historyOptions`), and that is not flag-gated — see
    // unifiedHistoryBars.test.ts A. The add is announced the way the app
    // announces it (`SceneGraphChanged` → sync + schedule) and allowed to land
    // as its own entry, so the move entry's "before" holds the node at x=10;
    // the raw `addChild` above announces nothing, and with the add unrecorded
    // the last assertion was unreachable in either mode (undoing the move
    // entry restored the "Open" baseline, which has no `rect` at all).
    holds('a move followed by a trim inside the debounce window is TWO entries, both undoable', () => {
      addLayer('rect', 'comp_root');
      bumpScene();
      jest.advanceTimersByTime(DEBOUNCE_MS);
      const before = labels().length;

      moveTo('rect', 50);                       // schedules the 700 ms capture
      trimTo('rect', 0, 200);                   // engine push → UndoStackChanged
      jest.advanceTimersByTime(DEBOUNCE_MS);

      // Today: the baseline sync re-captured `lastState` WITH x=50 before the
      // debounce fired, so the fired capture sees "no change" and records
      // nothing. One entry (the trim); the move is gone from history.
      expect(labels().length).toBe(before + 2);

      performUndo();
      expect(barOf('rect')).toEqual([0, FULL]);
      expect(xOf('rect')).toBe(50);

      performUndo();
      expect(xOf('rect')).toBe(10);
    });
  });

  describe('S3 — an engine command survives a document restore', () => {
    // `holds` in BOTH modes since T1 step 2: engine commands resolve their
    // layer by id at do/undo time (packages/timeline Timeline.ts), so a
    // restore that rebuilt every Layer object no longer detaches them.
    holds('undo past a Pre-compose still undoes the trim before it', async () => {
      addLayer('rect', 'comp_root');
      getTimelineController().syncFromScene('comp_root');
      trimTo('rect', 0, 200);

      const result = await precomposeLayers(['rect'], MOVE);
      expect(result).not.toBeNull();
      expect(labels()).toContain('Pre-compose');

      performUndo();                            // Pre-compose: document restore
      expect(defaultSceneGraph.getNode('rect')?.parent).toBe('comp_root');
      expect(barOf('rect')).toEqual([0, 200]);

      performUndo();                            // Trim Layer
      // Today: the trim's undo closure holds the pre-restore `Layer`, which
      // `restoreDocument` replaced. The live bar never moves.
      expect(barOf('rect')).toEqual([0, FULL]);
    });
  });

  describe('undo across Pre-compose is coherent in BOTH timelines', () => {
    holds('host and precomp geometry are right after undo and after redo', async () => {
      addLayer('other', 'comp_root');
      addLayer('rect', 'comp_root');
      getTimelineController().syncFromScene('comp_root');
      trimTo('other', 10, 100);
      trimTo('rect', 30, 200);

      const result = (await precomposeLayers(['rect'], MOVE))!;
      const { compId, instanceId } = result;
      expect(defaultSceneGraph.getNode('rect')?.parent).toBe(compId);
      // The bar followed its node into the precomp with its trim intact…
      expect(barOf('rect')).toEqual([30, 200]);
      // …the host kept the untouched neighbour and got an instance bar.
      expect(barOf('other')).toEqual([10, 100]);
      expect(barOf(instanceId)).not.toBeNull();

      performUndo();
      expect(defaultSceneGraph.getNode('rect')?.parent).toBe('comp_root');
      expect(defaultSceneGraph.getNode(instanceId)).toBeUndefined();
      expect(barOf('rect')).toEqual([30, 200]);
      expect(barOf('other')).toEqual([10, 100]);
      // (The precomp's own timeline registry outlives the undo by design —
      // `TimelineController.restore` merges, it does not prune — and no panel
      // can show a comp that no longer exists, so it is not asserted here.)

      performRedo();
      expect(defaultSceneGraph.getNode('rect')?.parent).toBe(compId);
      expect(barOf('rect')).toEqual([30, 200]);
      expect(barOf('other')).toEqual([10, 100]);
      expect(barOf(instanceId)).not.toBeNull();
    });
  });

  describe('engine entries and scene entries interleave', () => {
    holds('split, then a scene edit, then undo ×2 rejoins the bar', () => {
      const c = getTimelineController();
      addLayer('rect', 'comp_root');
      c.syncFromScene('comp_root');

      const rightId = c.splitClip(c.getLayersForNode('rect')[0]!.id, 2)!;   // frame 60
      const rightNode = c.timeline.getLayer(rightId)!.sourceId!;
      expect(barOf('rect')).toEqual([0, 60]);
      expect(barOf(rightNode)).toEqual([60, FULL]);

      moveTo('rect', 77);
      jest.advanceTimersByTime(DEBOUNCE_MS);
      expect(xOf('rect')).toBe(77);

      performUndo();
      expect(xOf('rect')).toBe(10);
      expect(barOf('rect')).toEqual([0, 60]);

      performUndo();
      expect(defaultSceneGraph.getNode(rightNode)).toBeUndefined();
      expect(c.getLayersForNode('rect')).toHaveLength(1);
      expect(barOf('rect')).toEqual([0, FULL]);
    });

    holds('ripple delete, then a scene edit, then undo ×2 restores the neighbour and the gap', () => {
      const c = getTimelineController();
      addLayer('first', 'comp_root');
      addLayer('second', 'comp_root');
      c.syncFromScene('comp_root');
      trimTo('first', 0, 60);
      trimTo('second', 60, 120);

      c.deleteLayerForClip(c.getLayersForNode('first')[0]!.id, { ripple: true });
      expect(defaultSceneGraph.getNode('first')).toBeUndefined();
      expect(barOf('second')).toEqual([0, 60]);

      moveTo('second', 99);
      jest.advanceTimersByTime(DEBOUNCE_MS);

      performUndo();
      expect(xOf('second')).toBe(10);
      expect(barOf('second')).toEqual([0, 60]);

      performUndo();
      expect(defaultSceneGraph.getNode('first')).toBeTruthy();
      expect(barOf('first')).toEqual([0, 60]);
      expect(barOf('second')).toEqual([60, 120]);
    });

    holds('a 3-bar drag transaction, then a scene edit, then undo ×2 puts every bar back', () => {
      const c = getTimelineController();
      for (const id of ['a', 'b', 'c']) addLayer(id, 'comp_root');
      c.syncFromScene('comp_root');
      const before = labels().length;

      c.setClipStarts([
        { layerId: c.getLayersForNode('a')[0]!.id, startSeconds: 1 },
        { layerId: c.getLayersForNode('b')[0]!.id, startSeconds: 2 },
        { layerId: c.getLayersForNode('c')[0]!.id, startSeconds: 3 },
      ]);
      c.invalidateLayerIndex();
      expect(labels().length).toBe(before + 1);             // one transaction
      expect(barOf('a')![0]).toBe(30);
      expect(barOf('b')![0]).toBe(60);
      expect(barOf('c')![0]).toBe(90);

      moveTo('b', 123);
      jest.advanceTimersByTime(DEBOUNCE_MS);
      expect(labels().length).toBe(before + 2);

      performUndo();
      expect(xOf('b')).toBe(10);
      expect(barOf('b')![0]).toBe(60);

      performUndo();
      expect(barOf('a')![0]).toBe(0);
      expect(barOf('b')![0]).toBe(0);
      expect(barOf('c')![0]).toBe(0);
    });
  });
});

describe('unified history (flag ON only)', () => {
  beforeEach(() => setUp(true));
  afterEach(tearDown);

  itOn('a bar keeps its id across a snapshot undo (bars address scene nodes)', () => {
    addLayer('rect', 'comp_root');
    getTimelineController().syncFromScene('comp_root');
    const idBefore = getTimelineController().getLayersForNode('rect')[0]!.id;

    selectAndDelete('rect');
    performUndo();

    expect(getTimelineController().getLayersForNode('rect')[0]!.id).toBe(idBefore);
  });
});
