/**
 * Expression control KINDS (#26) — slider, angle, point, colour, checkbox,
 * dropdown, layer.
 *
 * The design constraint: every kind must still resolve through `ctrl(name)` as
 * a NUMBER, because that is what the expression language returns and what the
 * keyframe engine animates. The kind decides presentation, not representation —
 * a colour is three numeric controls, exactly how colours are keyframed
 * everywhere else, rather than a second colour model.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
  addControl,
  removeControl,
  controlKind,
  listControls,
  nextControlName,
  controlValue,
  CONTROL_COMPONENTS,
  type ControlKind,
} from './expressionControls';
import type { SceneNode } from '@core/types';

function node(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0 } }],
  };
}

const KINDS: ControlKind[] = ['slider', 'angle', 'point', 'color', 'checkbox', 'dropdown', 'layer'];

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultSceneGraph.addNode(node('a'));
});

describe('every kind can be created and removed', () => {
  it.each(KINDS)('%s', (kind) => {
    const name = addControl('a', kind);
    expect(name).toBeTruthy();
    expect(controlKind('a', name!)).toBe(kind);
    // Every component it owns resolves as a number through ctrl.
    for (const suffix of CONTROL_COMPONENTS[kind]) {
      expect(typeof controlValue(name! + suffix, 0)).toBe('number');
    }
    removeControl('a', name!);
    expect(listControls().some((c) => c.name.startsWith(name!))).toBe(false);
  });
});

describe('multi-component kinds', () => {
  it('a point control owns .x and .y', () => {
    const name = addControl('a', 'point')!;
    const names = listControls().map((c) => c.name);
    expect(names).toContain(`${name}.x`);
    expect(names).toContain(`${name}.y`);
  });

  it('a colour control owns .r, .g and .b — the same decomposition used everywhere else', () => {
    const name = addControl('a', 'color')!;
    const names = listControls().map((c) => c.name);
    for (const ch of ['.r', '.g', '.b']) expect(names).toContain(`${name}${ch}`);
    expect(controlValue(`${name}.r`, 0)).toBe(255);
  });

  it('removing a multi-component control removes ALL of its components', () => {
    const name = addControl('a', 'point')!;
    removeControl('a', name);
    expect(listControls().map((c) => c.name).filter((n) => n.startsWith(name))).toEqual([]);
  });
});

describe('naming', () => {
  it('names by kind and never collides', () => {
    const a = addControl('a', 'slider')!;
    const b = addControl('a', 'slider')!;
    expect(a).not.toBe(b);
    expect(addControl('a', 'angle')).toMatch(/^Angle/);
  });

  it('a point control reserves its BASE name, not just its components', () => {
    // Nothing is stored at the base name, so a naive "is it taken" check would
    // hand the same base to a second point control and they would overwrite.
    const first = addControl('a', 'point')!;
    expect(nextControlName('point')).not.toBe(first);
  });
});

describe('back-compatibility', () => {
  it('a control with no recorded kind reads as a slider', () => {
    // Projects predating kinds stored only `ctrl_<name>`.
    const t = defaultSceneGraph.getNode('a')!.components[0]!;
    defaultSceneGraph.writeProp('a', t.id, 'ctrl_Legacy', 42);
    expect(controlKind('a', 'Legacy')).toBe('slider');
    expect(controlValue('Legacy', 0)).toBe(42);
  });
});
