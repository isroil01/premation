/**
 * The glyph a layer draws, wherever it is drawn.
 *
 * Two reports, one table:
 *   • the same kind drew two different marks in two panels — a group was a
 *     `folder` on its timeline track and a `layers` stack on its Layers row,
 *     because each panel kept its own copy of the map and they had drifted;
 *   • a shape's SUBTYPE came from its NAME: `fx.solid === true ||
 *     node.name.toLowerCase().includes('solid')`, so a shape called "Solid
 *     Ground" drew the solid mark and a solid renamed "Backdrop" stopped
 *     drawing it. A layer's kind is not a function of what it is called.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { KIND_ICON, KIND_LABEL, KIND_GLYPH_COLOR, isSolidNode, nodeIconName, readShapeType } from './sceneDerive';
import { SCENE_KIND_PROP, type SceneKind } from './seedDefaultScene';
import { ICON_NAMES } from '@components/Icon/iconNames';
import type { SceneNode } from '@core/types';

function shape(id: string, props: Record<string, unknown> = {}, extraComponents: SceneNode['components'] = []): SceneNode {
  return {
    id,
    name: id,
    parent: 'root',
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, ...props } },
      ...extraComponents,
    ],
  } as unknown as SceneNode;
}

beforeEach(() => {
  for (const r of [...defaultSceneGraph.getRoots()]) defaultSceneGraph.removeNode(r.id);
});

const live = (n: SceneNode): SceneNode => {
  defaultSceneGraph.addNode(n);
  return defaultSceneGraph.getNode(n.id)!;
};

describe('the tables are complete and real', () => {
  const kinds = Object.keys(KIND_LABEL) as SceneKind[];

  it('names a glyph, a label and a colour for every kind', () => {
    for (const k of kinds) {
      expect(KIND_ICON[k]).toBeTruthy();
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_GLYPH_COLOR[k]).toMatch(/^var\(--color-kind-/);
    }
  });

  it('names glyphs that the icon set actually has', () => {
    // A missing glyph renders as nothing, which reads as "this row has no
    // kind" rather than as a bug in a table.
    for (const k of kinds) {
      expect(ICON_NAMES).toContain(KIND_ICON[k]);
    }
  });
});

describe('shape subtypes', () => {
  it('draws the primitive, not eleven identical shape marks', () => {
    expect(nodeIconName(live(shape('r', { shapeType: 'rect' })))).toBe('square');
    expect(nodeIconName(live(shape('e', { shapeType: 'ellipse' })))).toBe('circle');
    expect(nodeIconName(live(shape('s', { shapeType: 'star' })))).toBe('star');
    expect(nodeIconName(live(shape('h', { shapeType: 'heart' })))).toBe('heart');
  });

  it('falls back to the generic shape mark for a drawn path', () => {
    // A pen-drawn or imported outline has no primitive glyph, and inventing
    // one would claim a shape it is not.
    expect(nodeIconName(live(shape('p', { shapeType: 'path' })))).toBe(KIND_ICON.shape);
    expect(nodeIconName(live(shape('none')))).toBe(KIND_ICON.shape);
  });

  it('names a glyph the icon set has for every subtype it maps', () => {
    for (const t of ['rect', 'ellipse', 'line', 'star', 'polygon', 'triangle', 'arrow', 'heart', 'cross', 'diamond', 'crescent']) {
      expect(ICON_NAMES).toContain(nodeIconName(live(shape(`t_${t}`, { shapeType: t }))));
    }
  });

  it('reads the subtype off the node', () => {
    expect(readShapeType(live(shape('q', { shapeType: 'star' })))).toBe('star');
    expect(readShapeType(live(shape('q2')))).toBeUndefined();
  });
});

describe('solids', () => {
  it('reads the fx flag, not the layer\'s name', () => {
    const named = live(shape('nm', {}));
    named.name = 'Solid Ground';
    expect(isSolidNode(named)).toBe(false);
    expect(nodeIconName(named)).toBe(KIND_ICON.shape);

    const real = live(shape('sd', {}, [{ id: 'sd_fx', type: 'fx', props: { solid: true } }]));
    expect(isSolidNode(real)).toBe(true);
    expect(nodeIconName(real)).toBe('solid');
  });

  it('keeps the solid mark on a solid the user renamed', () => {
    const real = live(shape('sd2', {}, [{ id: 'sd2_fx', type: 'fx', props: { solid: true } }]));
    real.name = 'Backdrop';
    expect(nodeIconName(real)).toBe('solid');
  });
});

describe('plugin layer kinds', () => {
  it('lets a registered kind override the glyph entirely', () => {
    const n = live(shape('pl', { shapeType: 'rect' }));
    expect(nodeIconName(n, () => 'plugin')).toBe('plugin');
    // An absent override falls through to the kind's own mark rather than
    // rendering nothing.
    expect(nodeIconName(n, () => undefined)).toBe('square');
  });
});
