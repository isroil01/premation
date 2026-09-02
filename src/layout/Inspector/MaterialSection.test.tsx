/**
 * MaterialSection — the controls that used to be four levels deep, and the
 * library that used to be in another panel.
 *
 * What is pinned here is REACHABILITY and CONTAINMENT: every material control
 * is on this one surface, the rows the chosen shading model does not read are
 * not shown at all, and saving/applying a material moves Material Options
 * without touching anything else about the layer.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeMaterialParams, DEFAULT_MATERIAL_PARAMS } from '@core/scene/material';
import { useMaterialStore } from '@stores/materialStore';
import { useSelectionStore } from '@stores/selectionStore';
import { MaterialSection, hasMaterialSection, materialSphereCss } from './MaterialSection';
import { ThreeDControl } from './ThreeDControl';
import type { SceneNode } from '@core/types';

const layer = (id: string, props: Record<string, unknown> = {}): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    {
      id: `${id}_t`, type: 'Transform',
      props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 100, height: 100, ...props },
    },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#3355ff' } },
  ],
} as unknown as SceneNode);

/** A 3D layer — `z` / `rotationX` / `rotationY` are what `is3DEnabled` reads. */
const threeD = (id: string, props: Record<string, unknown> = {}): SceneNode =>
  layer(id, { z: 0, rotationX: 0, rotationY: 0, ...props });

const mount = (id = 'box'): ReturnType<typeof render> => render(<MaterialSection nodeId={id} />);

/** ValueField labels its wrapper AND its inner span; the wrapper is the control. */
const field = (name: string): HTMLElement => screen.getByRole('spinbutton', { name });
const noField = (name: string): HTMLElement | null => screen.queryByRole('spinbutton', { name });

beforeEach(() => {
  useMaterialStore.setState({ materials: [] });
  useSelectionStore.setState({ ids: [], primary: null });
});

afterEach(() => {
  cleanup();
  defaultSceneGraph.clear();
});

describe('where the section appears', () => {
  it('is present for a 3D layer and absent for a flat one', () => {
    defaultSceneGraph.addNode(threeD('box'));
    defaultSceneGraph.addNode(layer('flat'));
    expect(hasMaterialSection('box')).toBe(true);
    expect(hasMaterialSection('flat')).toBe(false);
    expect(render(<MaterialSection nodeId="flat" />).container).toBeEmptyDOMElement();
  });

  /** The move: ThreeDControl keeps the switch and the geometry, and nothing else. */
  it('ThreeDControl no longer carries any material control', () => {
    defaultSceneGraph.addNode(threeD('box', { extrusionDepth: 40 }));
    render(<ThreeDControl nodeId="box" />);
    expect(screen.getByLabelText('3D layer')).toBeInTheDocument();
    expect(field('Extrusion depth')).toBeInTheDocument();
    for (const label of ['Shading model', 'Casts shadows', 'Accepts shadows', 'Accepts lights']) {
      expect(screen.queryByLabelText(label)).toBeNull();
    }
    for (const row of ['Ambient', 'Diffuse', 'Specular', 'Light Transmission']) {
      expect(noField(row)).toBeNull();
    }
    expect(screen.queryByText('Face Materials')).toBeNull();
  });

  it('carries the per-face overrides once the layer is extruded', () => {
    defaultSceneGraph.addNode(threeD('box'));
    expect(screen.queryByText('Face Materials')).toBeNull();
    cleanup();
    defaultSceneGraph.clear();
    defaultSceneGraph.addNode(threeD('box', { extrusionDepth: 40 }));
    mount();
    expect(screen.getByText('Face Materials')).toBeInTheDocument();
  });
});

describe('rows follow the shading model', () => {
  const shadeTo = (model: string): void => {
    fireEvent.change(screen.getByLabelText('Shading model'), { target: { value: model } });
  };

  it('Phong shows Shininess and Metal (Phong tints its highlight by metal) and hides Roughness', () => {
    defaultSceneGraph.addNode(threeD('box'));
    mount();
    expect(field('Shininess')).toBeInTheDocument();
    expect(noField('Roughness')).toBeNull();
    expect(field('Metal')).toBeInTheDocument();
    expect(noField('Bands')).toBeNull();
  });

  it('Physical swaps Shininess for Roughness and brings Metal back', () => {
    defaultSceneGraph.addNode(threeD('box'));
    const view = mount();
    shadeTo('pbr');
    view.rerender(<MaterialSection nodeId="box" />);
    expect(noField('Shininess')).toBeNull();
    expect(field('Roughness')).toBeInTheDocument();
    expect(field('Metal')).toBeInTheDocument();
    expect(readNodeMaterialParams('box')!.shading).toBe('pbr');
  });

  it('Toon adds Bands', () => {
    defaultSceneGraph.addNode(threeD('box'));
    const view = mount();
    shadeTo('toon');
    view.rerender(<MaterialSection nodeId="box" />);
    const bands = screen.getByLabelText('Bands slider') as HTMLInputElement;
    expect(bands.value).toBe('3');
    fireEvent.change(bands, { target: { value: '5' } });
    expect(readNodeMaterialParams('box')!.toonBands).toBe(5);
  });
});

describe('the controls that moved keep writing what they wrote', () => {
  it('shadow tri-states and transmission', () => {
    defaultSceneGraph.addNode(threeD('box'));
    mount();
    fireEvent.change(screen.getByLabelText('Casts shadows'), { target: { value: 'only' } });
    fireEvent.change(screen.getByLabelText('Accepts shadows'), { target: { value: 'off' } });
    fireEvent.change(screen.getByLabelText('Light Transmission slider'), { target: { value: '60' } });
    const m = readNodeMaterialParams('box')!;
    expect(m.castsShadows).toBe('only');
    expect(m.acceptsShadows).toBe('off');
    expect(m.lightTransmission).toBe(60);
  });

  it('the slider and the number field are one control', () => {
    defaultSceneGraph.addNode(threeD('box'));
    mount();
    fireEvent.change(screen.getByLabelText('Diffuse slider'), { target: { value: '75' } });
    expect(readNodeMaterialParams('box')!.diffuse).toBe(75);
    expect(screen.getByRole('spinbutton', { name: 'Diffuse' })).toHaveAttribute('aria-valuenow', '75');
  });
});

describe('the library', () => {
  it('ships the built-ins and offers no way to delete one', () => {
    defaultSceneGraph.addNode(threeD('box'));
    mount();
    expect(screen.getByLabelText('Apply material Gold')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete material Gold')).toBeNull();
  });

  it('applying one writes the material and leaves the fill alone', () => {
    defaultSceneGraph.addNode(threeD('box'));
    mount();
    fireEvent.click(screen.getByLabelText('Apply material Steel'));
    const m = readNodeMaterialParams('box')!;
    expect(m.acceptsLights).toBe(true);
    expect(m.shading).toBe('pbr');
    expect(m.specular).toBe(85);
    const style = defaultSceneGraph.getNode('box')!.components.find((c) => c.type === 'Style')!;
    expect(style.props.fill).toBe('#3355ff');
  });

  it('applies to every selected layer, not just the inspected one', () => {
    defaultSceneGraph.addNode(threeD('box'));
    defaultSceneGraph.addNode(threeD('other'));
    useSelectionStore.setState({ ids: ['box', 'other'], primary: 'box' });
    mount();
    fireEvent.click(screen.getByLabelText('Apply material Gold'));
    expect(readNodeMaterialParams('other')!.metal).toBe(100);
  });

  it('leaves layers outside the selection alone', () => {
    defaultSceneGraph.addNode(threeD('box'));
    defaultSceneGraph.addNode(threeD('other'));
    useSelectionStore.setState({ ids: ['box'], primary: 'box' });
    mount();
    fireEvent.click(screen.getByLabelText('Apply material Gold'));
    expect(readNodeMaterialParams('other')).toEqual(DEFAULT_MATERIAL_PARAMS);
  });

  it('saves the layer’s current surface as a named material, then applies it back', () => {
    defaultSceneGraph.addNode(threeD('box'));
    const view = mount();
    fireEvent.change(screen.getByLabelText('Specular slider'), { target: { value: '70' } });
    view.rerender(<MaterialSection nodeId="box" />);

    fireEvent.click(screen.getByText('Save as material…'));
    fireEvent.change(screen.getByLabelText('New material name'), { target: { value: 'Hero' } });
    fireEvent.click(screen.getByText('Save'));
    view.rerender(<MaterialSection nodeId="box" />);

    const saved = useMaterialStore.getState().materials;
    expect(saved.map((m) => m.name)).toEqual(['Hero']);
    expect(saved[0]!.params.specular).toBe(70);
    // The thumbnail remembers the colour it was saved from without applying it.
    expect(saved[0]!.swatch).toBe('#3355ff');

    fireEvent.change(screen.getByLabelText('Specular slider'), { target: { value: '0' } });
    view.rerender(<MaterialSection nodeId="box" />);
    fireEvent.click(screen.getByLabelText('Apply material Hero'));
    expect(readNodeMaterialParams('box')!.specular).toBe(70);
  });

  it('renames and deletes a saved material', () => {
    defaultSceneGraph.addNode(threeD('box'));
    const added = useMaterialStore.getState().addMaterial('Draft', DEFAULT_MATERIAL_PARAMS);
    const view = mount();

    fireEvent.click(screen.getByLabelText('Rename material Draft'));
    view.rerender(<MaterialSection nodeId="box" />);
    const input = screen.getByLabelText('Rename material Draft');
    fireEvent.change(input, { target: { value: 'Final' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    view.rerender(<MaterialSection nodeId="box" />);
    expect(useMaterialStore.getState().find(added.id)?.name).toBe('Final');

    fireEvent.click(screen.getByLabelText('Delete material Final'));
    expect(useMaterialStore.getState().materials).toEqual([]);
  });
});

describe('the preview swatch', () => {
  /** It is an approximation, so what is asserted is that it MOVES with the
   *  material — a preview that ignored roughness would be decoration. */
  it('answers roughness, specular and the toon band count', () => {
    const smooth = materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, shading: 'pbr', roughness: 0, specular: 100 }, '#808080');
    const rough = materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, shading: 'pbr', roughness: 100, specular: 100 }, '#808080');
    expect(smooth).not.toBe(rough);

    const dull = materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, specular: 0 }, '#808080');
    expect(dull).toContain('0.00');

    // Cel shading is hard steps: one colour stop per band, each with two
    // positions, which is what makes the edge hard rather than a ramp.
    const toon = materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, shading: 'toon', toonBands: 4 }, '#808080');
    expect(toon.match(/rgb\(\d+, \d+, \d+\) [\d.]+% [\d.]+%/g)).toHaveLength(4);
  });

  it('falls back to a neutral grey for an unparseable colour', () => {
    expect(() => materialSphereCss(DEFAULT_MATERIAL_PARAMS, 'not-a-colour')).not.toThrow();
  });
});
