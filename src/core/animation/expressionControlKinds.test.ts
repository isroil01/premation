/**
 * Expression control KINDS (#26) — slider, angle, point, colour, checkbox,
 * dropdown, layer.
 *
 * The design constraint: every kind must still resolve through `ctrl(name)` as
 * a NUMBER, because that is what the expression language returns and what the
 * keyframe engine animates. The kind decides presentation, not representation —
 * a colour is three numeric controls, exactly how colours are keyframed
 * everywhere else, rather than a second colour model.
 *
 * Adding / removing / renaming controls is the engine's addPropertyGroup /
 * removePropertyGroups / renamePropertyGroup on `effects/ctrl_<name>`
 * (src/core/engine/__tests__/expressionControls.test.ts). What stays here is
 * the storage contract every kind keeps and the ctrl() resolution.
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import {
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

/** What `addPropertyGroup` stores for a control (controlProps.ts planControlAdd). */
function store(kind: ControlKind, name: string, values: number[]): void {
  const t = defaultSceneGraph.getNode('a')!.components[0]!;
  CONTROL_COMPONENTS[kind].forEach((sfx, i) => defaultSceneGraph.writeProp('a', t.id, `ctrl_${name}${sfx}`, values[i] ?? 0));
  defaultSceneGraph.writeProp('a', t.id, `ctrlkind_${name}`, kind);
}

beforeEach(() => {
  (defaultSceneGraph as unknown as SceneGraph).clear();
  defaultSceneGraph.addNode(node('a'));
});

describe('every kind resolves through ctrl() as numbers', () => {
  it.each(KINDS)('%s', (kind) => {
    const name = nextControlName(kind);
    store(kind, name, [7, 8, 9]);
    CONTROL_COMPONENTS[kind].forEach((suffix, i) => {
      expect(controlValue(name + suffix, 0)).toBe([7, 8, 9][i]);
    });
  });
});

describe('multi-component kinds', () => {
  it('a point control owns .x and .y; a colour control .r, .g and .b', () => {
    expect(CONTROL_COMPONENTS.point).toEqual(['.x', '.y']);
    expect(CONTROL_COMPONENTS.color).toEqual(['.r', '.g', '.b']);
    store('point', 'P', [1, 2]);
    const names = listControls().map((c) => c.name);
    expect(names).toContain('P.x');
    expect(names).toContain('P.y');
  });
});

describe('naming', () => {
  it('names by kind and never collides', () => {
    const a = nextControlName('slider');
    store('slider', a, [50]);
    expect(nextControlName('slider')).not.toBe(a);
    expect(nextControlName('angle')).toMatch(/^Angle/);
  });

  it('a point control reserves its BASE name, not just its components', () => {
    // Nothing is stored at the base name, so a naive "is it taken" check would
    // hand the same base to a second point control and they would overwrite.
    const first = nextControlName('point');
    store('point', first, [0, 0]);
    expect(nextControlName('point')).not.toBe(first);
  });
});

describe('back-compatibility', () => {
  it('a control with no recorded kind still resolves', () => {
    // Projects predating kinds stored only `ctrl_<name>`.
    const t = defaultSceneGraph.getNode('a')!.components[0]!;
    defaultSceneGraph.writeProp('a', t.id, 'ctrl_Legacy', 42);
    expect(controlValue('Legacy', 0)).toBe(42);
  });
});
