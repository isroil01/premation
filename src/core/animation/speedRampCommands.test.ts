/**
 * The command layer's decisions, against the real animation engine.
 *
 * `speedRamp.test.ts` proves the curve is the correct integral. What is tested
 * here is what the command does with it: that ramps COMPOSE (a second ramp
 * starts from the speed the first one left behind, rather than snapping back
 * to 100%), that the footage continues from the frame on screen instead of
 * jumping to the head of the source, and that it refuses layers where a
 * time-remap track would be silently inert.
 */

import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { buildSpeedRampCommands, rampTargets } from './speedRampCommands';

/** `runAnimEdit` records an undo entry, so the command system has to exist. */
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

const PRECOMP = 'pre_1';
const SOLID = 'solid_1';

/**
 * A layer, optionally flagged as a precomp.
 *
 * The flag lives on an `fx` component as `precomp: true` — a `__kind` of
 * 'group' is NOT enough, which is what `isPrecomp` actually reads and what a
 * first version of this fixture got wrong.
 */
function addNode(id: string, kind: string, precomp = false): void {
  defaultSceneGraph.addChild('comp_root', {
    id,
    name: id,
    parent: 'comp_root',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { __kind: kind } },
      ...(precomp ? [{ id: `${id}_fx`, type: 'fx', props: { precomp: true } }] : []),
    ],
  } as never);
}

const command = (suffix: string) =>
  buildSpeedRampCommands().find((c) => String(c.id) === `time.speedRamp.${suffix}`)!;

/** Speed the remap curve is running at, as its slope. */
function speedAt(t: number): number {
  const dt = 1 / 240;
  const a = defaultAnimation.sample(PRECOMP, 'timeRemap', t) ?? 0;
  const b = defaultAnimation.sample(PRECOMP, 'timeRemap', t + dt) ?? 0;
  return (b - a) / dt;
}

function setPlayhead(t: number): void {
  const project = useProjectStore.getState();
  const tabId = project.activeTabId;
  if (tabId) useProjectStore.setState({ tabs: { ...project.tabs, [tabId]: { ...project.tabs[tabId]!, time: t } } });
}

beforeEach(() => {
  bootCommandSystem();
  for (const id of [PRECOMP, SOLID]) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode?.(id);
  }
  addNode(PRECOMP, 'group', true);
  addNode(SOLID, 'solid');
  defaultAnimation.setKeyframes(PRECOMP, 'timeRemap', []);
  useCompositionStore.setState({ durationSeconds: 10 } as never);
  useSelectionStore.setState({ ids: [PRECOMP] });
  setPlayhead(0);
});

describe('rampTargets', () => {
  it('accepts a pre-composed layer', () => {
    expect(rampTargets()).toEqual([PRECOMP]);
  });

  it('refuses a plain layer, where a remap track would be inert', () => {
    // `buildSnapshot` samples `timeRemap` for precomp containers only. Writing
    // it onto a solid would store keyframes, draw them in the graph editor,
    // and change nothing on screen.
    useSelectionStore.setState({ ids: [SOLID] });
    expect(rampTargets()).toEqual([]);
    expect(command('quarter').enabled!()).toBe(false);
  });

  it('ignores ids whose node has gone', () => {
    useSelectionStore.setState({ ids: [PRECOMP, 'deleted_layer'] });
    expect(rampTargets()).toEqual([PRECOMP]);
  });
});

describe('speed ramp commands', () => {
  it('eases from full speed to a quarter and holds it', () => {
    command('quarter').execute({} as never);

    expect(speedAt(0)).toBeCloseTo(1, 1);
    // Past the transition it must be AT the target, not still on its way.
    expect(speedAt(1.5)).toBeCloseTo(0.25, 2);
    expect(speedAt(5)).toBeCloseTo(0.25, 2);
  });

  it('composes: a second ramp starts from the speed the first left', () => {
    // The property that makes ramps usable in sequence. Reading the speed from
    // the curve's slope rather than assuming 100% is what buys it — otherwise
    // ramping back up would start with a jump from 25% to 100%.
    command('quarter').execute({} as never);
    setPlayhead(4);
    command('normal').execute({} as never);

    expect(speedAt(4)).toBeCloseTo(0.25, 2);
    expect(speedAt(6)).toBeCloseTo(1, 1);
  });

  it('continues from the frame on screen rather than the head of the source', () => {
    setPlayhead(3);
    command('half').execute({} as never);
    // Identity before any ramp: source 3s is showing at comp 3s.
    expect(defaultAnimation.sample(PRECOMP, 'timeRemap', 3)).toBeCloseTo(3, 5);
  });

  it('never runs the footage backwards through a deceleration', () => {
    command('quarter').execute({} as never);
    let prev = -Infinity;
    for (let t = 0; t <= 6; t += 0.02) {
      const v = defaultAnimation.sample(PRECOMP, 'timeRemap', t) ?? 0;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = v;
    }
  });

  it('holds the frame when ramped to a freeze', () => {
    command('freeze').execute({} as never);
    const held = defaultAnimation.sample(PRECOMP, 'timeRemap', 2) ?? 0;
    expect(defaultAnimation.sample(PRECOMP, 'timeRemap', 8)).toBeCloseTo(held, 4);
  });

  it('speeds up as well as down', () => {
    command('double').execute({} as never);
    expect(speedAt(2)).toBeCloseTo(2, 1);
  });

  it('leaves keyframes before the playhead alone', () => {
    command('quarter').execute({} as never);
    const early = defaultAnimation.sample(PRECOMP, 'timeRemap', 0.25) ?? 0;
    setPlayhead(5);
    command('normal').execute({} as never);
    expect(defaultAnimation.sample(PRECOMP, 'timeRemap', 0.25)).toBeCloseTo(early, 5);
  });

  it('does nothing when there is no room left for a ramp', () => {
    setPlayhead(9.9);
    command('quarter').execute({} as never);
    expect(defaultAnimation.isAnimated(PRECOMP, 'timeRemap')).toBe(false);
  });
});
