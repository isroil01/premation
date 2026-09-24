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
 *
 * The fixture is the app's engine (B3): the light is a layer created through
 * the engine API with its starting fields as `init`, every control's write is
 * an engine command (one undo entry per pick) and the section reads the
 * document mirror.
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import type { PropertyInit } from '@motion/engine-api';
import { LightSection } from './LightSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { values } from '@core/engine/propRefs';
import { readNodeLight, type LightType } from '@core/scene/light';
import { ENVIRONMENT_PRESETS } from '@core/scene/environmentLight';
import { useAssetStore } from '@stores/assetStore';
import { kelvinToHex, nearestKelvin } from '@core/scene/colorTemperature';

jest.useFakeTimers();

const ALL_TYPES: LightType[] = ['point', 'ambient', 'spot', 'parallel', 'environment'];

let h: Harness & { engine: LocalEngine };
/** The light the current test mounted. */
let ID = '';

beforeEach(async () => {
  h = await setupAppEngine();
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };

/** The light's starting fields, as the engine's layer fields (§15.9). */
interface LightInit { lightType?: LightType; envPreset?: string; envRotation?: number }

function initOf(props: LightInit): PropertyInit[] {
  const init: PropertyInit[] = [];
  if (props.lightType !== undefined) init.push({ path: 'light/lightType', value: values.choice(props.lightType) });
  if (props.envPreset !== undefined) init.push({ path: 'light/environment', value: values.string(props.envPreset) });
  if (props.envRotation !== undefined) init.push({ path: 'light/envRotation', value: values.scalar(props.envRotation) });
  return init;
}

/** Create a light layer through the engine, select it and mount its section on an empty history. */
async function mount(props: LightInit = {}): Promise<void> {
  await act(async () => {
    ({ layer: ID } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'light', name: 'Probe light', init: initOf(props) }));
  });
  getCommandSystem().getHistory().clear();
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

describe('the light Type menu', () => {
  it('offers every type the engine understands, and each round-trips', async () => {
    for (const want of ALL_TYPES) {
      await mount();
      const select = screen.getByLabelText('Light type') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toContain(want);
      fireEvent.change(select, { target: { value: want } });
      await idle();
      // The engine's own reader, not the DOM: this is the coercion that used to
      // silently turn 'environment' into 'point'.
      expect(currentLight().type).toBe(want);
      // ...and the section must display back what it just wrote.
      expect((screen.getByLabelText('Light type') as HTMLSelectElement).value).toBe(want);
      cleanup();
    }
  });

  it('lands on a real sky when switching TO environment — one undo entry', async () => {
    await mount();
    const before = h.doc();
    fireEvent.change(screen.getByLabelText('Light type'), { target: { value: 'environment' } });
    await idle();
    const preset = currentLight().envPreset;
    expect(ENVIRONMENT_PRESETS.map((p) => p.id)).toContain(preset);
    // Written, not merely defaulted by the reader — the menu has to be able to
    // show which sky is in force.
    const node = defaultSceneGraph.getNode(ID);
    const t = node?.components.find((c) => c.type === 'Transform');
    expect(t?.props.envPreset).toBe(preset);
    // Type + sky + rotation are one menu pick: one entry, undone whole.
    settle();
    expect(historyLabels()).toEqual(['Set Light Type']);
    await undo();
    expect(currentLight().type).toBe('point');
    expect(h.doc()).toBe(before);
  });
});

describe('an environment light', () => {
  it('exposes exactly the props buildSnapshot reads: sky, rotation, intensity', async () => {
    await mount({ lightType: 'environment', envPreset: 'sky', envRotation: 30 });

    const sky = screen.getByLabelText('Environment preset') as HTMLSelectElement;
    expect(sky.value).toBe('sky');
    // The ids come from the canonical preset table, not from a copy — followed
    // by the one non-preset entry, which opens the image picker.
    expect([...sky.options].map((o) => o.value)).toEqual([...ENVIRONMENT_PRESETS.map((p) => p.id), 'image']);
    // A preset sky shows no picker: the row exists only for an image sky.
    expect(screen.queryAllByLabelText('Environment image')).toHaveLength(0);

    expect(numRow('Sky rotation')).toBeTruthy();
    expect(numRow('Intensity')).toBeTruthy();
  });

  it('hides the rows the environment path never reads', async () => {
    await mount({ lightType: 'environment' });
    for (const gone of ['Radius', 'Falloff', 'Cone angle', 'Direction', 'Target X', 'Light color', 'Color temperature']) {
      expect({ row: gone, found: screen.queryAllByLabelText(gone).length }).toEqual({ row: gone, found: 0 });
    }
  });

  it('writes envRotation, which is what the renderer samples per frame', async () => {
    await mount({ lightType: 'environment', envRotation: 30 });
    expect(currentLight().envRotation).toBe(30);
    fireEvent.keyDown(numRow('Sky rotation'), { key: 'ArrowUp' });
    await idle();
    expect(currentLight().envRotation).not.toBe(30);
  });

  it('changes the sky through the menu', async () => {
    await mount({ lightType: 'environment', envPreset: 'studio' });
    fireEvent.change(screen.getByLabelText('Environment preset'), { target: { value: 'sunset' } });
    await idle();
    expect(currentLight().envPreset).toBe('sunset');
  });
});

/**
 * An IMAGE sky. The engine reads one prop, `envPreset`, whose `asset:<id>` form
 * means "project this equirect" — so the assertions go through `readNodeLight`
 * again rather than against the option strings, and a menu that writes a shape
 * the engine cannot parse fails here.
 */
describe('an environment light lit by an image', () => {
  const IMG = { id: 'img_hdri', name: 'sunflowers_2k.exr', type: 'image' as const, src: 'blob:hdri', size: 1 };

  beforeEach(() => {
    useAssetStore.setState({ assets: [IMG] } as never);
  });
  afterEach(() => {
    cleanup(); // unmount before the library changes under the section
    useAssetStore.setState({ assets: [] } as never);
  });

  it('picking "Image…" points the sky at a library image', async () => {
    await mount({ lightType: 'environment', envPreset: 'studio' });
    fireEvent.change(screen.getByLabelText('Environment preset'), { target: { value: 'image' } });
    await idle();
    expect(currentLight().envPreset).toBe(`asset:${IMG.id}`);
  });

  it('shows the picker, on the chosen asset, by NAME', async () => {
    await mount({ lightType: 'environment', envPreset: `asset:${IMG.id}` });
    // The Sky menu reports "image" rather than falling back to a preset…
    expect((screen.getByLabelText('Environment preset') as HTMLSelectElement).value).toBe('image');
    // …and the picker names the file, not the opaque id.
    const picker = screen.getByLabelText('Environment image') as HTMLSelectElement;
    expect(picker.value).toBe(IMG.id);
    expect([...picker.options].find((o) => o.value === IMG.id)?.textContent).toBe(IMG.name);
  });

  it('an asset that is no longer in the library says so instead of vanishing', async () => {
    await mount({ lightType: 'environment', envPreset: 'asset:img_gone' });
    const picker = screen.getByLabelText('Environment image') as HTMLSelectElement;
    expect(picker.value).toBe('img_gone');
    expect([...picker.options].some((o) => o.textContent?.includes('missing'))).toBe(true);
    // The prop is left alone — a missing sky is repairable, a silently reset
    // one is not.
    await idle();
    expect(currentLight().envPreset).toBe('asset:img_gone');
  });

  it('switching back to a preset drops the image reference entirely', async () => {
    await mount({ lightType: 'environment', envPreset: `asset:${IMG.id}` });
    fireEvent.change(screen.getByLabelText('Environment preset'), { target: { value: 'sunset' } });
    await idle();
    expect(currentLight().envPreset).toBe('sunset');
    expect(screen.queryAllByLabelText('Environment image')).toHaveLength(0);
  });
});

describe('colour temperature', () => {
  it('writes the light colour through the blackbody fit', async () => {
    await mount({ lightType: 'point' });
    expect(currentLight().color).toBe('#fff3c0');
    const field = numRow('Color temperature');
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await idle();
    const after = currentLight().color;
    expect(after).not.toBe('#fff3c0');
    // The written colour sits ON the blackbody locus — it came from the Kelvin
    // fit, not from some hand-rolled tint of the previous hex.
    expect(kelvinToHex(nearestKelvin(after))).toBe(after);
  });
});

describe('light presets', () => {
  it('apply type, energy, colour and shaping in one pick — one undo entry', async () => {
    await mount({ lightType: 'point' });
    const before = h.doc();
    const presets = screen.getByLabelText('Light preset') as HTMLSelectElement;
    const key = [...presets.options].find((o) => o.value === 'Key');
    expect(key).toBeTruthy();
    fireEvent.change(presets, { target: { value: 'Key' } });
    await idle();
    const lit = currentLight();
    expect(lit.type).toBe('spot');
    expect(lit.intensity).toBe(100);
    expect(lit.falloff).toBe('smooth');
    expect(lit.color).toBe(kelvinToHex(5600));
    // ...and the menu now reports the preset it just applied, rather than
    // falling back to Custom.
    expect((screen.getByLabelText('Light preset') as HTMLSelectElement).value).toBe('Key');
    settle();
    expect(historyLabels()).toEqual(['Light Preset: Key']);
    await undo();
    expect(currentLight().type).toBe('point');
    expect(h.doc()).toBe(before);
  });
});
