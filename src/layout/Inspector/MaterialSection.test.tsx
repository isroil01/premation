/**
 * MaterialSection — the controls that used to be four levels deep, and the
 * library that used to be in another panel.
 *
 * What is pinned here is REACHABILITY and CONTAINMENT: every material control
 * is on this one surface, the rows the chosen shading model does not read are
 * not shown at all, and saving/applying a material moves Material Options
 * without touching anything else about the layer.
 *
 * The fixture is the app's engine (B3): layers are created and switched to 3D
 * through the engine API, every control's write is an engine command (one
 * undo entry per action) and undo puts the document back exactly.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { values } from '@core/engine/propRefs';
import { readNodeMaterialParams, DEFAULT_MATERIAL_PARAMS } from '@core/scene/material';
import { useMaterialStore } from '@stores/materialStore';
import { useSelectionStore } from '@stores/selectionStore';
import { MaterialSection, hasMaterialSection, materialSphereCss } from './MaterialSection';
import { ThreeDControl } from './ThreeDControl';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };

beforeEach(async () => {
  h = await setupAppEngine();
  useMaterialStore.setState({ materials: [] });
  useSelectionStore.setState({ ids: [], primary: null });
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };

interface LayerOpts {
  /** Extrusion Depth (Geometry Options). */
  extrusionDepth?: number;
  /** A shading model other than Phong. */
  shading?: 'pbr' | 'toon';
}

/** A flat shape layer filled #3355ff, created through the engine. */
async function flatLayer(name: string): Promise<string> {
  let id = '';
  await act(async () => {
    ({ layer: id } = await h.run({
      type: 'createLayer', comp: 'comp_root', kind: 'shape', name,
      init: [{ path: 'layer/fill', value: values.color(0x33 / 255, 0x55 / 255, 1) }],
    }));
  });
  getCommandSystem().getHistory().clear();
  return id;
}

/**
 * A 3D shape layer: the 3D switch on, Accepts Lights off (the layer every
 * material test starts from — a plain 3D layer with no Material Options
 * stored), plus any geometry / shading the test asks for.
 */
async function threeD(name: string, opts: LayerOpts = {}): Promise<string> {
  const layer = await flatLayer(name);
  const cmds: Command[] = [
    { type: 'setLayerSwitches', layers: [layer], patch: { threeD: true } },
    { type: 'setProperty', prop: { layer, path: 'material/acceptsLights' }, value: values.scalar(0) },
  ];
  if (opts.extrusionDepth !== undefined) cmds.push({ type: 'setProperty', prop: { layer, path: 'geometry/extrusionDepth' }, value: values.scalar(opts.extrusionDepth) });
  if (opts.shading !== undefined) cmds.push({ type: 'setProperty', prop: { layer, path: 'material/shading' }, value: values.choice(opts.shading) });
  await act(async () => { await h.batch('fixture', cmds); });
  getCommandSystem().getHistory().clear();
  return layer;
}

const mount = (id: string): ReturnType<typeof render> => render(<MaterialSection nodeId={id} />);

/** ValueField labels its wrapper AND its inner span; the wrapper is the control. */
const field = (name: string): HTMLElement => screen.getByRole('spinbutton', { name });
const noField = (name: string): HTMLElement | null => screen.queryByRole('spinbutton', { name });

describe('where the section appears', () => {
  it('is present for a 3D layer and absent for a flat one', async () => {
    const box = await threeD('box');
    const flat = await flatLayer('flat');
    expect(hasMaterialSection(box)).toBe(true);
    expect(hasMaterialSection(flat)).toBe(false);
    expect(render(<MaterialSection nodeId={flat} />).container).toBeEmptyDOMElement();
  });

  /** The move: ThreeDControl keeps the switch and the geometry, and nothing else. */
  it('ThreeDControl no longer carries any material control', async () => {
    const box = await threeD('box', { extrusionDepth: 40 });
    render(<ThreeDControl nodeId={box} />);
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

  it('carries the per-face overrides once the layer is extruded', async () => {
    const box = await threeD('box');
    mount(box);
    expect(screen.queryByText('Face Materials')).toBeNull();
    cleanup();
    await act(async () => {
      await h.run({ type: 'setProperty', prop: { layer: box, path: 'geometry/extrusionDepth' }, value: values.scalar(40) });
    });
    mount(box);
    expect(screen.getByText('Face Materials')).toBeInTheDocument();
  });
});

describe('rows follow the shading model', () => {
  const shadeTo = async (model: string): Promise<void> => {
    fireEvent.change(screen.getByLabelText('Shading model'), { target: { value: model } });
    await idle();
  };

  it('Phong shows Shininess and Metal (Phong tints its highlight by metal) and hides Roughness', async () => {
    mount(await threeD('box'));
    expect(field('Shininess')).toBeInTheDocument();
    expect(noField('Roughness')).toBeNull();
    expect(field('Metal')).toBeInTheDocument();
    expect(noField('Bands')).toBeNull();
  });

  it('Physical swaps Shininess for Roughness and brings Metal back — one undo entry', async () => {
    const box = await threeD('box');
    mount(box);
    const before = h.doc();
    await shadeTo('pbr');
    expect(noField('Shininess')).toBeNull();
    expect(field('Roughness')).toBeInTheDocument();
    expect(field('Metal')).toBeInTheDocument();
    expect(readNodeMaterialParams(box)!.shading).toBe('pbr');
    settle();
    expect(historyLabels()).toEqual(['Set Shading']);
    await undo();
    expect(readNodeMaterialParams(box)!.shading).toBe('phong');
    expect(h.doc()).toBe(before);
  });

  it('Toon adds Bands', async () => {
    const box = await threeD('box');
    mount(box);
    await shadeTo('toon');
    const bands = screen.getByLabelText('Bands slider') as HTMLInputElement;
    expect(bands.value).toBe('3');
    fireEvent.change(bands, { target: { value: '5' } });
    await idle();
    expect(readNodeMaterialParams(box)!.toonBands).toBe(5);
  });
});

describe('the controls that moved keep writing what they wrote', () => {
  it('shadow tri-states and transmission', async () => {
    const box = await threeD('box');
    mount(box);
    fireEvent.change(screen.getByLabelText('Casts shadows'), { target: { value: 'only' } });
    fireEvent.change(screen.getByLabelText('Accepts shadows'), { target: { value: 'off' } });
    fireEvent.change(screen.getByLabelText('Light Transmission slider'), { target: { value: '60' } });
    await idle();
    const m = readNodeMaterialParams(box)!;
    expect(m.castsShadows).toBe('only');
    expect(m.acceptsShadows).toBe('off');
    expect(m.lightTransmission).toBe(60);
  });

  it('the slider and the number field are one control', async () => {
    const box = await threeD('box');
    mount(box);
    fireEvent.change(screen.getByLabelText('Diffuse slider'), { target: { value: '75' } });
    await idle();
    expect(readNodeMaterialParams(box)!.diffuse).toBe(75);
    expect(screen.getByRole('spinbutton', { name: 'Diffuse' })).toHaveAttribute('aria-valuenow', '75');
  });
});

describe('the library', () => {
  it('ships the built-ins and offers no way to delete one', async () => {
    mount(await threeD('box'));
    expect(screen.getByLabelText('Apply material Gold')).toBeInTheDocument();
    expect(screen.queryByLabelText('Delete material Gold')).toBeNull();
  });

  it('applying one writes the material and leaves the fill alone — one undo entry', async () => {
    const box = await threeD('box');
    mount(box);
    const before = h.doc();
    fireEvent.click(screen.getByLabelText('Apply material Steel'));
    await idle();
    const m = readNodeMaterialParams(box)!;
    expect(m.acceptsLights).toBe(true);
    expect(m.shading).toBe('pbr');
    expect(m.specular).toBe(85);
    const style = defaultSceneGraph.getNode(box)!.components.find((c) => c.type === 'Style')!;
    expect(style.props.fill).toBe('#3355ff');
    settle();
    expect(historyLabels()).toEqual(['Apply material Steel']);
    await undo();
    expect(readNodeMaterialParams(box)).toEqual(DEFAULT_MATERIAL_PARAMS);
    expect(h.doc()).toBe(before);
  });

  it('applies to every selected layer, not just the inspected one — as one entry', async () => {
    const box = await threeD('box');
    const other = await threeD('other');
    useSelectionStore.setState({ ids: [box, other], primary: box });
    mount(box);
    fireEvent.click(screen.getByLabelText('Apply material Gold'));
    await idle();
    expect(readNodeMaterialParams(other)!.metal).toBe(100);
    expect(readNodeMaterialParams(box)!.metal).toBe(100);
    settle();
    expect(historyLabels()).toEqual(['Apply material Gold']);
  });

  it('leaves layers outside the selection alone', async () => {
    const box = await threeD('box');
    const other = await threeD('other');
    useSelectionStore.setState({ ids: [box], primary: box });
    mount(box);
    fireEvent.click(screen.getByLabelText('Apply material Gold'));
    await idle();
    expect(readNodeMaterialParams(box)!.metal).toBe(100);
    expect(readNodeMaterialParams(other)).toEqual(DEFAULT_MATERIAL_PARAMS);
  });

  it('saves the layer’s current surface as a named material, then applies it back', async () => {
    const box = await threeD('box');
    const view = mount(box);
    fireEvent.change(screen.getByLabelText('Specular slider'), { target: { value: '70' } });
    await idle();

    fireEvent.click(screen.getByText('Save as material…'));
    fireEvent.change(screen.getByLabelText('New material name'), { target: { value: 'Hero' } });
    fireEvent.click(screen.getByText('Save'));
    view.rerender(<MaterialSection nodeId={box} />);

    const saved = useMaterialStore.getState().materials;
    expect(saved.map((m) => m.name)).toEqual(['Hero']);
    expect(saved[0]!.params.specular).toBe(70);
    // The thumbnail remembers the colour it was saved from without applying it.
    expect(saved[0]!.swatch).toBe('#3355ff');

    fireEvent.change(screen.getByLabelText('Specular slider'), { target: { value: '0' } });
    await idle();
    expect(readNodeMaterialParams(box)!.specular).toBe(0);
    fireEvent.click(screen.getByLabelText('Apply material Hero'));
    await idle();
    expect(readNodeMaterialParams(box)!.specular).toBe(70);
  });

  it('renames and deletes a saved material', async () => {
    const box = await threeD('box');
    const added = useMaterialStore.getState().addMaterial('Draft', DEFAULT_MATERIAL_PARAMS);
    const view = mount(box);

    fireEvent.click(screen.getByLabelText('Rename material Draft'));
    view.rerender(<MaterialSection nodeId={box} />);
    const input = screen.getByLabelText('Rename material Draft');
    fireEvent.change(input, { target: { value: 'Final' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    view.rerender(<MaterialSection nodeId={box} />);
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

  it('answers the Advanced-3D axes too', () => {
    const base = materialSphereCss(DEFAULT_MATERIAL_PARAMS, '#808080');
    expect(materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, reflectionIntensity: 0 }, '#808080')).not.toBe(base);
    expect(materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, reflectionSharpness: 100 }, '#808080')).not.toBe(base);
    expect(materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, transparency: 80 }, '#808080')).not.toBe(base);
    // Toon never reflects, so its preview carries no sheen streak either.
    const toon = materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, shading: 'toon' }, '#808080');
    expect(toon).toBe(materialSphereCss({ ...DEFAULT_MATERIAL_PARAMS, shading: 'toon', reflectionIntensity: 20 }, '#808080'));
  });
});

describe('Advanced-3D axes (Reflections / Transparency)', () => {
  it('the rows write the material (through the engine API)', async () => {
    const box = await threeD('box');
    mount(box);
    fireEvent.change(screen.getByLabelText('Reflection Intensity slider'), { target: { value: '40' } });
    fireEvent.change(screen.getByLabelText('Reflection Rolloff slider'), { target: { value: '25' } });
    fireEvent.change(screen.getByLabelText('Transparency slider'), { target: { value: '60' } });
    fireEvent.change(screen.getByLabelText('Transparency Rolloff slider'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Index of Refraction slider'), { target: { value: '1.33' } });
    await idle();
    const m = readNodeMaterialParams(box)!;
    expect(m.reflectionIntensity).toBe(40);
    expect(m.reflectionRolloff).toBe(25);
    expect(m.transparency).toBe(60);
    expect(m.transparencyRolloff).toBe(50);
    expect(m.ior).toBeCloseTo(1.33, 10);
    // Writing the default back reads as the default. (The pre-API setter also
    // dropped the stored prop — "unstored default"; the engine's static write
    // stores it explicitly: an engine gap listed in the B3 report, pixels equal.)
    fireEvent.change(screen.getByLabelText('Reflection Intensity slider'), { target: { value: '100' } });
    await idle();
    expect(readNodeMaterialParams(box)!.reflectionIntensity).toBe(100);
  });

  it('Toon replaces the reflection rows with an explanation', async () => {
    mount(await threeD('box', { shading: 'toon' }));
    expect(noField('Reflection Intensity')).toBeNull();
    expect(screen.getByText(/Toon shading never reflects/)).toBeInTheDocument();
    // Transparency is model-independent and stays.
    expect(field('Transparency')).toBeInTheDocument();
  });
});
