import {
  readNodeMaterial,
  getNodeCastsShadows,
  setNodeCastsShadows,
  applyMaterialParams,
  readNodeMaterialParams,
  normalizeMaterialParams,
  DEFAULT_MATERIAL_PARAMS,
  type MaterialParams,
} from './material';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import type { SceneNode } from '@core/types';

function addNode(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true, locked: false,
    components: [{ id: `${id}_t`, type: 'Transform', props: {} }],
  } as unknown as SceneNode);
}

describe('material options — casts shadows', () => {
  beforeEach(() => {
    const ids: string[] = [];
    defaultSceneGraph.traverse((n) => ids.push(n.id));
    for (const id of ids) defaultSceneGraph.removeNode(id);
  });

  it('defaults to casting shadows', () => {
    addNode('a');
    expect(readNodeMaterial(defaultSceneGraph.getNode('a')!).castsShadows).toBe(true);
    expect(getNodeCastsShadows('a')).toBe(true);
  });

  it('round-trips off and back on', () => {
    addNode('a');
    setNodeCastsShadows('a', false);
    expect(getNodeCastsShadows('a')).toBe(false);
    setNodeCastsShadows('a', true);
    expect(getNodeCastsShadows('a')).toBe(true);
  });
});

describe('material params — the reusable half', () => {
  beforeEach(() => {
    const ids: string[] = [];
    defaultSceneGraph.traverse((n) => ids.push(n.id));
    for (const id of ids) defaultSceneGraph.removeNode(id);
  });

  it('round-trips a whole material through a layer', () => {
    addNode('a');
    const wanted: MaterialParams = {
      ...DEFAULT_MATERIAL_PARAMS,
      shading: 'pbr',
      acceptsLights: true,
      metal: 90,
      roughness: 25,
      specular: 80,
      diffuse: 40,
      castsShadows: 'only',
      acceptsShadows: 'off',
      lightTransmission: 60,
    };
    applyMaterialParams('a', wanted);
    expect(readNodeMaterialParams('a')).toEqual(wanted);
  });

  /**
   * The point of the whole section: a material is Material Options, and only
   * Material Options. The grid this library replaces wrote the layer's FILL,
   * which is how picking "Gold" silently threw away the colour you had chosen.
   */
  it('leaves everything that is not a material option alone', () => {
    addNode('a');
    const t = defaultSceneGraph.getNode('a')!.components.find((c) => c.type === 'Transform')!;
    defaultSceneGraph.writeProp('a', t.id, 'x', 120);
    defaultSceneGraph.writeProp('a', t.id, 'extrusionDepth', 40);
    defaultSceneGraph.writeProp('a', t.id, 'fill', '#ff0000');

    applyMaterialParams('a', { ...DEFAULT_MATERIAL_PARAMS, metal: 100, shading: 'pbr' });

    const props = defaultSceneGraph.getNode('a')!.components.find((c) => c.type === 'Transform')!.props;
    expect(props.x).toBe(120);
    expect(props.extrusionDepth).toBe(40);
    expect(props.fill).toBe('#ff0000');
  });

  /** A material states a COMPLETE surface, so the previous one cannot bleed. */
  it('applying a second material clears the first one’s axes', () => {
    addNode('a');
    applyMaterialParams('a', { ...DEFAULT_MATERIAL_PARAMS, shading: 'pbr', roughness: 5, metal: 100 });
    applyMaterialParams('a', DEFAULT_MATERIAL_PARAMS);
    const m = readNodeMaterialParams('a')!;
    expect(m.shading).toBe('phong');
    expect(m.roughness).toBe(DEFAULT_MATERIAL_PARAMS.roughness);
    expect(m.metal).toBe(0);
    // Defaults are stored as ABSENT props, so the file does not grow either.
    const props = defaultSceneGraph.getNode('a')!.components.find((c) => c.type === 'Transform')!.props;
    expect(props.roughness).toBeUndefined();
    expect(props.shadingModel).toBeUndefined();
  });

  it('normalizes junk to the default surface rather than to zero', () => {
    const m = normalizeMaterialParams({ diffuse: 'lots', shading: 'wireframe', toonBands: 99, metal: 40 });
    expect(m.diffuse).toBe(DEFAULT_MATERIAL_PARAMS.diffuse);
    expect(m.shading).toBe('phong');
    expect(m.toonBands).toBe(8);
    expect(m.metal).toBe(40);
    expect(normalizeMaterialParams(null)).toEqual(DEFAULT_MATERIAL_PARAMS);
  });

  it('is a no-op for a node that does not exist', () => {
    expect(() => applyMaterialParams('ghost', DEFAULT_MATERIAL_PARAMS)).not.toThrow();
    expect(readNodeMaterialParams('ghost')).toBeNull();
  });
});
