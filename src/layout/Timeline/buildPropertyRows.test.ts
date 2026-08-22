/**
 * The join between the property tree and the engine's keyframes.
 *
 * What is being pinned here is the SPLIT: a group row stands in for its members
 * while none of them is keyed, and gives way to their real per-property rows the
 * moment one is — except Position, which stays one row because a position
 * keyframe is one keyframe holding two numbers.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, POSITION_PSEUDO_PROP } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { addEffect, getNodeEffects, effectPropPath, effectDefFor } from '@core/effects/effects';
import type { SceneNode } from '@core/types';
import { buildPropertyRows } from './buildPropertyRows';

function node(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } },
      { id: `${id}_s`, type: 'Style', props: { fill: '#fff', opacity: 100 } },
    ],
  };
}

const byLabel = (nodeId: string) => new Map(buildPropertyRows(nodeId).map((r) => [r.label, r]));

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultAnimation.clear();
  defaultSceneGraph.addNode(node('a'));
});

describe('placeholder rows', () => {
  it('stand in for their members, unlit, with a stopwatch that keys all of them', () => {
    const scale = byLabel('a').get('Scale')!;
    expect(scale.animated).toBe(false);
    expect(scale.keyframes).toHaveLength(0);
    expect(scale.stopwatchProps).toEqual(['scaleX', 'scaleY']);
  });

  it('give way to the real per-property rows once one member is keyed', () => {
    defaultAnimation.setKeyframe('a', 'scaleX', 0, 1);
    const rows = byLabel('a');
    expect(rows.has('Scale')).toBe(false);
    expect(rows.get('Scale X')!.keyframes).toHaveLength(1);
    // The un-keyed sibling is NOT invented as a row — AE does not show it
    // either, and a row with no track is not a property you can navigate.
    expect(rows.has('Scale Y')).toBe(false);
  });
});

describe('Position stays one row', () => {
  it('merges X and Y keyframes at the same time into a single diamond', () => {
    defaultAnimation.setKeyframe('a', 'x', 0, 0);
    defaultAnimation.setKeyframe('a', 'y', 0, 0);
    defaultAnimation.setKeyframe('a', 'x', 1, 100);
    const rows = byLabel('a');
    const position = rows.get('Position')!;
    expect(position.prop).toBe(POSITION_PSEUDO_PROP);
    expect(position.keyframes).toHaveLength(2); // t=0 (both axes) and t=1
    expect(rows.has('Position X')).toBe(false);
  });
});

describe('effect parameters', () => {
  it('appear as rows before they are keyed, under the Effects group', () => {
    addEffect('a', 'glow');
    const fx = getNodeEffects('a')[0]!;
    const key = effectDefFor(fx.type)!.params.find((p) => p.type === 'number')!.key;
    const row = buildPropertyRows('a').find((r) => r.stopwatchProps?.[0] === effectPropPath(fx.id, key));
    expect(row).toBeDefined();
    expect(row!.animated).toBe(false);
    expect(row!.group).toBe('effects');
  });

  it('carry their keyframes once keyed', () => {
    addEffect('a', 'glow');
    const fx = getNodeEffects('a')[0]!;
    const key = effectDefFor(fx.type)!.params.find((p) => p.type === 'number')!.key;
    const path = effectPropPath(fx.id, key);
    defaultAnimation.setKeyframe('a', path, 0, 10);
    defaultAnimation.setKeyframe('a', path, 1, 40);
    const row = buildPropertyRows('a').find((r) => r.prop === path)!;
    expect(row.animated).not.toBe(false);
    expect(row.keyframes).toHaveLength(2);
    expect(row.group).toBe('effects');
  });
});

describe('tracks the tree does not describe', () => {
  it('are appended rather than dropped, and still get a heading', () => {
    // A pre-multi-param project keyframed the effect's primary scalar with no
    // param key at all. The tree has no row for that spelling; the keyframes
    // are real, so hiding them would hide real work.
    defaultAnimation.setKeyframe('a', 'effect.fx_legacy', 0, 5);
    const row = buildPropertyRows('a').find((r) => r.prop === 'effect.fx_legacy');
    expect(row).toBeDefined();
    expect(row!.group).toBe('effects');
    expect(row!.keyframes).toHaveLength(1);
  });
});
