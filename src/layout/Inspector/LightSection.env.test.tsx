/**
 * The light inspector has to be able to express every LightType the ENGINE has,
 * and only the rows that type actually uses.
 *
 * The failure this pins: `LightType` gained 'environment' (buildSnapshot
 * expands it into a whole SH-probe rig), the New Light dialog could create one
 * — and this section folded it back to 'point'. So an environment light was
 * displayed and edited as a point light, `envPreset` / `envRotation` had no
 * controls at all, and the rows it DID show (radius, falloff, cone, shadows,
 * point of interest) were controls the environment path never reads.
 *
 * The round trip is asserted through `readNodeLight` rather than against the
 * option strings, so a dropdown that offers a value the engine does not
 * understand — or a coercion that quietly rewrites one — fails here.
 */

import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import { LightSection } from './LightSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { readNodeLight, type LightType } from '@core/scene/light';
import { ENVIRONMENT_PRESETS } from '@core/scene/environmentLight';
import { kelvinToHex, nearestKelvin } from '@core/scene/colorTemperature';
import type { SceneNode } from '@core/types';

const ID = 'light_probe';

const ALL_TYPES: LightType[] = ['point', 'ambient', 'spot', 'parallel', 'environment'];

function lightNode(id: string, props: Record<string, unknown> = {}): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'light', x: 100, y: 100, intensity: 100, radius: 500, ...props },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#fff3c0' } },
    ],
  } as unknown as SceneNode;
}

function mount(props: Record<string, unknown> = {}): void {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  defaultSceneGraph.addNode(lightNode(ID, props));
  useSelectionStore.setState({ ids: [ID] } as never);
  render(<LightSection nodeId={ID} />);
}

/**
 * A labelled numeric row's INPUT. `ValueField` labels both its wrapper and the
 * spinbutton inside it, so a plain `getByLabelText` finds two elements.
 */
function numRow(label: string): HTMLElement {
  const all = screen.getAllByLabelText(label);
  const spin = all.find((el) => el.getAttribute('role') === 'spinbutton');
  const first = all[0];
  if (!spin && !first) throw new Error(`no row labelled ${label}`);
  return (spin ?? first) as HTMLElement;
}

function currentLight(): ReturnType<typeof readNodeLight> {
  const node = defaultSceneGraph.getNode(ID);
  if (!node) throw new Error('probe light vanished');
  return readNodeLight(node);
}

afterEach(() => {
  cleanup();
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe('the light Type menu', () => {
  it('offers every type the engine understands, and each round-trips', () => {
    for (const want of ALL_TYPES) {
      mount();
      const select = screen.getByLabelText('Light type') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toContain(want);
      fireEvent.change(select, { target: { value: want } });
      // The engine's own reader, not the DOM: this is the coercion that used to
      // silently turn 'environment' into 'point'.
      expect(currentLight().type).toBe(want);
      // ...and the section must display back what it just wrote.
      expect((screen.getByLabelText('Light type') as HTMLSelectElement).value).toBe(want);
      cleanup();
    }
  });

  it('lands on a real sky when switching TO environment', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Light type'), { target: { value: 'environment' } });
    const preset = currentLight().envPreset;
    expect(ENVIRONMENT_PRESETS.map((p) => p.id)).toContain(preset);
    // Written, not merely defaulted by the reader — the menu has to be able to
    // show which sky is in force.
    const node = defaultSceneGraph.getNode(ID);
    const t = node?.components.find((c) => c.type === 'Transform');
    expect(t?.props.envPreset).toBe(preset);
  });
});

describe('an environment light', () => {
  it('exposes exactly the props buildSnapshot reads: sky, rotation, intensity', () => {
    mount({ lightType: 'environment', envPreset: 'sky', envRotation: 30 });

    const sky = screen.getByLabelText('Environment preset') as HTMLSelectElement;
    expect(sky.value).toBe('sky');
    // The ids come from the canonical preset table, not from a copy.
    expect([...sky.options].map((o) => o.value)).toEqual(ENVIRONMENT_PRESETS.map((p) => p.id));

    expect(numRow('Sky rotation')).toBeTruthy();
    expect(numRow('Intensity')).toBeTruthy();
  });

  it('hides the rows the environment path never reads', () => {
    mount({ lightType: 'environment' });
    for (const gone of ['Radius', 'Falloff', 'Cone angle', 'Direction', 'Target X', 'Light color', 'Color temperature']) {
      expect({ row: gone, found: screen.queryAllByLabelText(gone).length }).toEqual({ row: gone, found: 0 });
    }
  });

  it('writes envRotation, which is what the renderer samples per frame', () => {
    mount({ lightType: 'environment', envRotation: 30 });
    fireEvent.keyDown(numRow('Sky rotation'), { key: 'ArrowUp' });
    expect(currentLight().envRotation).not.toBe(30);
  });

  it('changes the sky through the menu', () => {
    mount({ lightType: 'environment', envPreset: 'studio' });
    fireEvent.change(screen.getByLabelText('Environment preset'), { target: { value: 'sunset' } });
    expect(currentLight().envPreset).toBe('sunset');
  });
});

describe('colour temperature', () => {
  it('writes the light colour through the blackbody fit', () => {
    mount({ lightType: 'point' });
    const field = numRow('Color temperature');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    const after = currentLight().color;
    expect(after).not.toBe('#fff3c0');
    // The written colour sits ON the blackbody locus — it came from the Kelvin
    // fit, not from some hand-rolled tint of the previous hex.
    expect(kelvinToHex(nearestKelvin(after))).toBe(after);
  });
});

describe('light presets', () => {
  it('apply type, energy, colour and shaping in one pick', () => {
    mount({ lightType: 'point' });
    const presets = screen.getByLabelText('Light preset') as HTMLSelectElement;
    const key = [...presets.options].find((o) => o.value === 'Key');
    expect(key).toBeTruthy();
    fireEvent.change(presets, { target: { value: 'Key' } });
    const lit = currentLight();
    expect(lit.type).toBe('spot');
    expect(lit.intensity).toBe(100);
    expect(lit.falloff).toBe('smooth');
    expect(lit.color).toBe(kelvinToHex(5600));
    // ...and the menu now reports the preset it just applied, rather than
    // falling back to Custom.
    expect((screen.getByLabelText('Light preset') as HTMLSelectElement).value).toBe('Key');
  });
});
