/**
 * Smart Animate end to end, against real compositions and the real animation
 * engine.
 *
 * The matcher and the planner are unit-tested next door. What can only be
 * caught here is the wiring: keyframes landing on the DUPLICATE rather than on
 * the board the user is still editing, arrivals actually existing in the
 * result, and neither original composition being touched.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { createComposition } from '@core/composition/compositionOps';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { describeComposition, smartAnimateBetween } from './smartAnimateApply';

function bootCommandSystem(): void {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) as never }));
}

let seq = 0;
/** A layer inside `compId`, at a given position. */
function addLayer(
  compId: string,
  name: string,
  props: Record<string, unknown>,
  kind = 'shape',
): string {
  seq += 1;
  const id = `sa_${seq}`;
  defaultSceneGraph.addChild(compId, {
    id,
    name,
    parent: compId,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, opacity: 100, ...props } },
    ],
  } as never);
  return id;
}

const OPTS = { startTime: 0, durationSec: 1 };

/** Comp A: Title at x=0, Leaves. Comp B: Title at x=500, Arrives. */
function boards(): { a: string; b: string } {
  const a = createComposition({ name: 'Board A' });
  addLayer(a, 'Title', { x: 0, y: 100 }, 'text');
  addLayer(a, 'Leaves', { x: 10, y: 10 });

  const b = createComposition({ name: 'Board B' });
  addLayer(b, 'Title', { x: 500, y: 100 }, 'text');
  addLayer(b, 'Arrives', { x: 20, y: 20 });
  return { a, b };
}

beforeEach(() => {
  bootCommandSystem();
});

describe('describeComposition', () => {
  it('lists the layers but not the composition root', () => {
    const a = createComposition({ name: 'Solo' });
    addLayer(a, 'Only', { x: 1 });
    const described = describeComposition(a);
    expect(described.map((d) => d.name)).toEqual(['Only']);
    expect(described.every((d) => d.id !== a)).toBe(true);
  });

  it('records the path down from the composition root', () => {
    const a = createComposition({ name: 'Nested' });
    const group = addLayer(a, 'Card', {}, 'group');
    seq += 1;
    const childId = `sa_${seq}`;
    defaultSceneGraph.addChild(group, {
      id: childId, name: 'Label', parent: group, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${childId}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'text' } }],
    } as never);

    const label = describeComposition(a).find((d) => d.name === 'Label')!;
    expect(label.path).toEqual(['Card']);
  });
});

describe('smartAnimateBetween', () => {
  it('builds a third composition and leaves both boards alone', () => {
    const { a, b } = boards();
    const before = describeComposition(a).map((d) => d.id);

    const out = smartAnimateBetween(a, b, OPTS)!;
    expect(out).not.toBeNull();
    expect(out.compId).not.toBe(a);
    expect(out.compId).not.toBe(b);

    // The source board's layers are untouched — same ids, no new tracks.
    expect(describeComposition(a).map((d) => d.id)).toEqual(before);
    for (const id of before) expect(defaultAnimation.tracksFor(id)).toHaveLength(0);
    expect(describeComposition(b).every((d) => defaultAnimation.tracksFor(d.id).length === 0)).toBe(true);
  });

  it('moves the matched layer from where it was to where it ends up', () => {
    const { a, b } = boards();
    const out = smartAnimateBetween(a, b, OPTS)!;

    const title = describeComposition(out.compId).find((d) => d.name === 'Title')!;
    const track = defaultAnimation.tracksFor(title.id).find((t) => t.prop === 'x')!;
    expect(track).toBeDefined();
    const keys = [...track.keyframes].sort((p, q) => p.t - q.t);
    expect(keys[0]!.value).toBeCloseTo(0, 3);
    expect(keys[keys.length - 1]!.value).toBeCloseTo(500, 3);
  });

  it('fades out what only the first board had', () => {
    const { a, b } = boards();
    const out = smartAnimateBetween(a, b, OPTS)!;
    expect(out.departing).toBe(1);

    const leaving = describeComposition(out.compId).find((d) => d.name === 'Leaves')!;
    const opacity = defaultAnimation.tracksFor(leaving.id).find((t) => t.prop === 'opacity')!;
    const keys = [...opacity.keyframes].sort((p, q) => p.t - q.t);
    expect(keys[keys.length - 1]!.value).toBe(0);
  });

  it('brings in what only the second board had, and fades it up', () => {
    const { a, b } = boards();
    const out = smartAnimateBetween(a, b, OPTS)!;
    expect(out.arriving).toBe(1);

    // It has to physically exist in the transition, not be referenced.
    const arrived = describeComposition(out.compId).find((d) => d.name === 'Arrives');
    expect(arrived).toBeDefined();
    const opacity = defaultAnimation.tracksFor(arrived!.id).find((t) => t.prop === 'opacity')!;
    const keys = [...opacity.keyframes].sort((p, q) => p.t - q.t);
    expect(keys[0]!.value).toBe(0);
    expect(keys[keys.length - 1]!.value).toBeGreaterThan(0);
  });

  it('reports how each pairing was decided', () => {
    const { a, b } = boards();
    const out = smartAnimateBetween(a, b, OPTS)!;
    expect(out.matched).toBe(1);
    expect(out.reasons['name-and-place']).toBe(1);
  });

  it('writes nothing for a layer that did not move', () => {
    // The restraint that keeps the graph editor readable.
    const a = createComposition({ name: 'Still A' });
    addLayer(a, 'Fixed', { x: 100, y: 100 });
    const b = createComposition({ name: 'Still B' });
    addLayer(b, 'Fixed', { x: 100, y: 100 });

    const out = smartAnimateBetween(a, b, OPTS)!;
    const fixed = describeComposition(out.compId).find((d) => d.name === 'Fixed')!;
    expect(defaultAnimation.tracksFor(fixed.id)).toHaveLength(0);
    expect(out.matched).toBe(1);
    expect(out.keyframes).toBe(0);
  });

  it('refuses a composition that does not exist', () => {
    const { a } = boards();
    expect(smartAnimateBetween(a, 'no_such_comp', OPTS)).toBeNull();
    expect(smartAnimateBetween('no_such_comp', a, OPTS)).toBeNull();
  });

  it('treats two boards with nothing in common as a full swap', () => {
    const a = createComposition({ name: 'Alpha' });
    addLayer(a, 'OnlyA', { x: 0 });
    const b = createComposition({ name: 'Beta' });
    addLayer(b, 'OnlyB', { x: 0 });

    const out = smartAnimateBetween(a, b, OPTS)!;
    expect(out.matched).toBe(0);
    expect(out.departing).toBe(1);
    expect(out.arriving).toBe(1);
  });

  it('names the transition when asked', () => {
    const { a, b } = boards();
    const out = smartAnimateBetween(a, b, { ...OPTS, name: 'A → B' })!;
    expect(useProjectStore.getState().comps[out.compId]?.name).toBe('A → B');
  });
});

describe('the commands track the compositions that exist', () => {
  /**
   * A command per target is only usable if the set stays current. Boards get
   * created and renamed while the app runs, and `buildStaticCommands` runs once
   * at boot — so a snapshot would mean a board made after startup had no
   * command to animate to it.
   */
  it('offers a command for every other composition, and none for the active one', () => {
    const { buildSmartAnimateCommands, transitionTargets } =
      require('./smartAnimateCommands') as typeof import('./smartAnimateCommands');
    const { a, b } = boards();
    const project = useProjectStore.getState();
    const tabId = project.activeTabId;
    if (tabId) {
      useProjectStore.setState({
        tabs: { ...project.tabs, [tabId]: { ...project.tabs[tabId]!, compositionId: a } },
      } as never);
    }

    const targets = transitionTargets().map((t) => t.id);
    expect(targets).toContain(b);
    expect(targets).not.toContain(a);
    expect(buildSmartAnimateCommands().map((c) => String(c.id))).toContain(`comp.smartAnimate.${b}`);
  });

  it('offers a pristine composition that has been drawn into', () => {
    // The default comp keeps `pristine: true` forever — nothing clears it when
    // layers are added — so filtering on that flag alone hid the composition
    // most people put their first board in. The rule the codebase already
    // states (see `pristineCompToAdopt`) is pristine AND LAYERLESS.
    const { transitionTargets } = require('./smartAnimateCommands') as typeof import('./smartAnimateCommands');
    const { useProjectStore: store } = require('@stores/projectStore') as typeof import('@stores/projectStore');

    const drawnInto = createComposition({ name: 'Drawn Into' });
    store.setState((s) => { const c = s.comps[drawnInto]; if (c) c.pristine = true; });
    addLayer(drawnInto, 'Something', { x: 0 });

    const empty = createComposition({ name: 'Never Touched' });
    store.setState((s) => { const c = s.comps[empty]; if (c) c.pristine = true; });

    // Point the tab elsewhere so neither is excluded for being active.
    const other = createComposition({ name: 'Elsewhere' });
    const tabId = store.getState().activeTabId;
    if (tabId) {
      store.setState({
        tabs: { ...store.getState().tabs, [tabId]: { ...store.getState().tabs[tabId]!, compositionId: other } },
      } as never);
    }

    const ids = transitionTargets().map((t) => t.id);
    expect(ids).toContain(drawnInto);
    expect(ids).not.toContain(empty);
  });

  it('drops the command for a composition that has gone', () => {
    const { syncSmartAnimateCommands } = require('./smartAnimateCommands') as typeof import('./smartAnimateCommands');
    const { getCommandRegistry } = require('@core/commands/Command') as typeof import('@core/commands/Command');
    const { deleteComposition } = require('@core/composition/compositionOps') as typeof import('@core/composition/compositionOps');

    const { a, b } = boards();
    // `createComposition` activates what it creates, and the active board is
    // excluded from its own target list — so point the tab at A first.
    const project = useProjectStore.getState();
    const tabId = project.activeTabId;
    if (tabId) {
      useProjectStore.setState({
        tabs: { ...project.tabs, [tabId]: { ...project.tabs[tabId]!, compositionId: a } },
      } as never);
    }
    syncSmartAnimateCommands();
    const registry = getCommandRegistry();
    expect(registry.get(`comp.smartAnimate.${b}` as never)).toBeDefined();

    deleteComposition(b);
    syncSmartAnimateCommands();
    expect(registry.get(`comp.smartAnimate.${b}` as never)).toBeUndefined();
  });
});
