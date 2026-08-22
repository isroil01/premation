/**
 * The cascade (time offset) and push effectors.
 *
 * The cascade is the first effector that reaches beyond geometry into TIME, so
 * the renderer half is where the risk is: the offset must ride on the comp
 * clock (outside clip maps and precomp remaps), and a cloned GROUP's children
 * must delay together with their root, or a cascade on a group tears it apart
 * frame by frame. Push is geometry, but its failure is directional — a sign
 * error attracts where it should repel, which reads as intended behaviour.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { SCENE_KIND_PROP } from './seedDefaultScene';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { defaultAnimation } from '@motion/animation';
import { useProjectStore } from '@stores/projectStore';
import { CLONER_PROP } from './clonerExpand';
import { clonerPlan, DEFAULT_CLONER, type ClonerConfig, type ClonerFalloff } from './cloner';
import type { SceneNode } from '@core/types';

const COMP = {
  width: 1920, height: 1080, fps: 30, durationSeconds: 10,
  background: '#000', transparent: false, startFrame: 0,
};

const cfg = (patch: Partial<ClonerConfig> = {}): ClonerConfig => ({
  ...DEFAULT_CLONER, enabled: true, ...patch,
});
const fo = (p: Partial<ClonerFalloff>): ClonerFalloff => ({ ...DEFAULT_CLONER.falloff, ...p });

function resetScene(): void {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
}

function addComp(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode);
}

function addShape(id: string, parent: string, cloner?: Partial<ClonerConfig>): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 20, height: 20 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#f00' } },
      {
        id: `${id}_fx`, type: 'fx',
        props: cloner ? { [CLONER_PROP]: { ...DEFAULT_CLONER, enabled: true, ...cloner } } : {},
      },
    ],
  } as never);
}

const at = (t: number): ReturnType<typeof buildSnapshot> =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, {
    width: 1920, height: 1080, background: '#000', transparent: false, rootId: 'comp_root',
  });

const clonesAt = (t: number) => at(t).layers.filter((l) => l.id.includes('~c'));

beforeEach(() => {
  resetScene();
  addComp('comp_root');
  useProjectStore.getState().actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', ...COMP },
  });
  const proj = useProjectStore.getState();
  proj.actions.setActiveTab(proj.actions.openTab('comp_root', ['comp_root'], 'Main'));
});

afterEach(resetScene);

describe('the cascade in the plan', () => {
  it('ramps from zero on the first clone to step.time on the last', () => {
    const plan = clonerPlan(cfg({ count: 3, step: { ...DEFAULT_CLONER.step, time: 1 } }));
    expect(plan.map((c) => Math.round(c.timeOffset * 100) / 100).sort((a, b) => a - b))
      .toEqual([0, 0.5, 1]);
  });

  it('is zero everywhere by default, so existing configs are untouched', () => {
    const plan = clonerPlan(cfg({ count: 3 }));
    expect(plan.every((c) => c.timeOffset === 0)).toBe(true);
  });

  it('is masked by the falloff like every other effector', () => {
    const plan = clonerPlan(cfg({
      count: 3,
      step: { ...DEFAULT_CLONER.step, time: 1 },
      falloff: fo({ shape: 'linear', source: 'order', position: 0, width: 0.4 }),
    }));
    // The last clone (t=1) is outside the falloff → no delay despite the ramp.
    const byIndex = [...plan].sort((a, b) => a.index - b.index);
    expect(byIndex[2]!.timeOffset).toBe(0);
  });
});

describe('the cascade through the renderer', () => {
  it('each clone plays the SAME animation, later', () => {
    // x animates 0 → 300 over 1s. At t=1s: clone 0 (no delay) has arrived at
    // 300; clone 1 (0.5s behind) is where the source was at 0.5s — 150.
    addShape('a', 'comp_root', {
      mode: 'linear', count: 2, offsetX: 0, offsetY: 0,
      step: { ...DEFAULT_CLONER.step, time: 0.5 },
    });
    defaultAnimation.setKeyframe('a', 'x', 0, 0, 'linear');
    defaultAnimation.setKeyframe('a', 'x', 1, 300, 'linear');
    const xs = clonesAt(1).map((l) => Math.round(l.x)).sort((p, q) => p - q);
    expect(xs).toEqual([150, 300]);
  });

  it('a cloned GROUP delays its children with it', () => {
    // The child is keyframed, the cloner sits on the parent group. If the
    // cascade only reached the root, each copy of the child would play at full
    // speed inside a delayed shell and the group would tear apart.
    addShape('g', 'comp_root', {
      mode: 'linear', count: 2, offsetX: 0, offsetY: 0,
      step: { ...DEFAULT_CLONER.step, time: 0.5 },
    });
    addShape('child', 'g');
    defaultAnimation.setKeyframe('child', 'y', 0, 0, 'linear');
    defaultAnimation.setKeyframe('child', 'y', 1, 100, 'linear');
    const children = at(1).layers.filter((l) => l.id.includes('child'));
    const ys = children.map((l) => Math.round(l.y)).sort((p, q) => p - q);
    expect(ys).toEqual([50, 100]);
  });

  it('a zero cascade leaves every clone in lockstep', () => {
    addShape('a', 'comp_root', { mode: 'linear', count: 2, offsetX: 0, offsetY: 0 });
    defaultAnimation.setKeyframe('a', 'x', 0, 0, 'linear');
    defaultAnimation.setKeyframe('a', 'x', 1, 300, 'linear');
    const xs = clonesAt(0.5).map((l) => Math.round(l.x));
    expect(xs).toEqual([150, 150]);
  });
});

describe('the push field', () => {
  const base = () => cfg({
    mode: 'linear', count: 3, offsetX: 100, offsetY: 0,
    falloff: fo({ shape: 'linear', source: 'layer', radius: 80, push: 50 }),
  });

  it('pushes a clone in range AWAY from the driver', () => {
    // Driver at -120, clone at -100: "away" is the direction from driver to
    // clone, i.e. +x. A sign error here ATTRACTS instead, which looks like a
    // deliberate magnet effect rather than a bug — hence the exact value too:
    // 20px from the driver in an 80px linear field → weight 1 - 20/80.
    const plan = clonerPlan(base(), { x: -120, y: 0 });
    const hit = plan.find((c) => c.index === 0)!; // base x = -100
    expect(hit.x).toBeGreaterThan(-100);
    expect(hit.x).toBeCloseTo(-100 + 50 * (1 - 20 / 80), 0);
  });

  it('a negative push ATTRACTS', () => {
    const attract = base();
    attract.falloff = fo({ ...attract.falloff, push: -50 });
    const plan = clonerPlan(attract, { x: -120, y: 0 });
    expect(plan.find((c) => c.index === 0)!.x).toBeLessThan(-100);
  });

  it('leaves clones outside the radius alone', () => {
    const plan = clonerPlan(base(), { x: -120, y: 0 });
    expect(plan.find((c) => c.index === 2)!.x).toBe(100);
  });

  it('does nothing without a field centre', () => {
    const plan = clonerPlan(base(), null);
    expect(plan.map((c) => c.x)).toEqual([-100, 0, 100]);
  });

  it('a clone exactly ON the driver stays put rather than jumping arbitrarily', () => {
    const plan = clonerPlan(base(), { x: 0, y: 0 });
    expect(plan.find((c) => c.index === 1)!.x).toBe(0);
  });
});
