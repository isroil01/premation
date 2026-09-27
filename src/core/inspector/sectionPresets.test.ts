/**
 * What a section preset actually captures, and where it lands.
 *
 * The store holds flat `{key: value}` bags and knows nothing about what a key
 * means; THIS module is the schema, so it is the only place a mistake shows
 * up as "the preset saved the wrong thing" rather than as a type error. The
 * load-bearing property tested here: capture reads the PRIMARY layer and apply
 * writes EVERY selected layer, which is what makes "make these three match
 * the house style" one pick.
 *
 * Round-tripping (capture on A, apply to B, capture on B, expect the same
 * bag) is the strongest available check that the two halves agree about key
 * names, so most of these are round-trips.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { readPropertyValue } from './multiSelection';
import {
  TEXT_PRESET_PROPS,
  TRANSFORM_PRESET_PROPS,
  applyComponentPropsPreset,
  applyTextPreset,
  applyTransformPreset,
  captureTextPreset,
  captureTransformPreset,
} from './sectionPresets';

const SHAPES = ['sp_a', 'sp_b'];
const TEXTS = ['sp_t1', 'sp_t2'];

function addShape(id: string, x: number, opacity: number): void {
  defaultSceneGraph.addNode({
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity },
      },
    ],
  } as unknown as SceneNode);
}

function addText(id: string, fontSize: number, family: string): void {
  defaultSceneGraph.addNode({
    id,
    name: id,
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'text', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 100 },
      },
      {
        id: `${id}_x`,
        type: 'Text',
        props: {
          text: 'hello',
          fontFamily: family,
          fontSize,
          fontWeight: '400',
          fontStyle: 'normal',
          letterSpacing: 0,
          lineHeight: 1.2,
        },
      },
    ],
  } as unknown as SceneNode);
}

beforeEach(() => {
  for (const id of [...SHAPES, ...TEXTS]) defaultSceneGraph.removeNode?.(id);
  addShape('sp_a', 100, 100);
  addShape('sp_b', 500, 40);
  addText('sp_t1', 72, 'Inter');
  addText('sp_t2', 24, 'Georgia');
});

afterAll(() => {
  for (const id of [...SHAPES, ...TEXTS]) defaultSceneGraph.removeNode?.(id);
});

describe('the schemas name real properties', () => {
  it('has no duplicate keys', () => {
    expect(new Set(TRANSFORM_PRESET_PROPS).size).toBe(TRANSFORM_PRESET_PROPS.length);
    expect(new Set(TEXT_PRESET_PROPS).size).toBe(TEXT_PRESET_PROPS.length);
  });

  it('covers the transform properties the section actually draws', () => {
    for (const p of ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity']) {
      expect(TRANSFORM_PRESET_PROPS).toContain(p);
    }
  });

  it('covers the type properties the character panel actually draws', () => {
    for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight']) {
      expect(TEXT_PRESET_PROPS).toContain(p);
    }
  });
});

describe('transform presets', () => {
  it('captures only the properties the layer HAS', () => {
    const bag = captureTransformPreset('sp_a', 0);
    expect(bag.x).toBe(100);
    expect(bag.opacity).toBe(100);
    // A flat shape has no Z, and a preset must not invent one.
    expect(Object.keys(bag).every((k) => TRANSFORM_PRESET_PROPS.includes(k))).toBe(true);
  });

  it('round-trips: capture A, apply to B, and B reads back as A did', () => {
    const bag = captureTransformPreset('sp_a', 0);
    applyTransformPreset(['sp_b'], bag, { compTime: 0 });
    expect(readPropertyValue('sp_b', 'x', 0)).toBe(100);
    expect(readPropertyValue('sp_b', 'opacity', 0)).toBe(100);
  });

  it('applies to EVERY selected layer', () => {
    applyTransformPreset(SHAPES, { x: 7, opacity: 55 }, { compTime: 0 });
    for (const id of SHAPES) {
      expect(readPropertyValue(id, 'x', 0)).toBe(7);
      expect(readPropertyValue(id, 'opacity', 0)).toBe(55);
    }
  });

  it('captures nothing from a layer that is not there', () => {
    expect(captureTransformPreset('ghost', 0)).toEqual({});
  });
});

describe('text presets', () => {
  it('captures the Text component`s style props', () => {
    expect(captureTextPreset('sp_t1')).toMatchObject({ fontFamily: 'Inter', fontSize: 72 });
  });

  it('is empty for a layer with no Text component', () => {
    expect(captureTextPreset('sp_a')).toEqual({});
  });

  it('round-trips a house style onto another text layer', () => {
    const bag = captureTextPreset('sp_t1');
    applyTextPreset(['sp_t2'], bag);
    expect(captureTextPreset('sp_t2')).toMatchObject({ fontFamily: 'Inter', fontSize: 72 });
  });

  it('applies to every selected text layer', () => {
    applyTextPreset(TEXTS, { fontSize: 33 });
    expect(captureTextPreset('sp_t1').fontSize).toBe(33);
    expect(captureTextPreset('sp_t2').fontSize).toBe(33);
  });

  it('skips layers that cannot take the component, without failing the rest', () => {
    const written = applyTextPreset(['sp_a', 'sp_t1'], { fontSize: 12 });
    expect(written).toBeGreaterThan(0);
    expect(captureTextPreset('sp_t1').fontSize).toBe(12);
  });

  it('reports nothing written when no layer has the component', () => {
    expect(applyComponentPropsPreset(SHAPES, 'Text', { fontSize: 12 })).toBe(0);
  });
});
