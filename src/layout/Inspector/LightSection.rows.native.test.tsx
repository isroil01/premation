/**
 * Light Options in After Effects' order and grammar (2026-10-08) — and only
 * the rows the C++ engine actually reads for the light's type.
 *
 *   • Falloff / Radius / Falloff Distance belong to Point and Spot: the engine
 *     shades a Parallel light with no distance term and an Ambient one has no
 *     position. Radius is the reach of a falloff curve (and of the legacy
 *     ramp); Falloff Distance is read by Smooth alone.
 *   • Casts Shadows is a ROW whose value reads On / Off — not a twirl header
 *     with a checkbox in it — and its shadow rows follow it.
 *   • Point of Interest is one X / Y / Z row, like Position, with a bordered
 *     "Aim by Angle"; untargeted, Direction with "Add Target".
 *   • Show Glow in Viewer is offered for Point and Spot, under a Viewer twirl;
 *     a new light starts with it off.
 *
 * The fixture is the app's engine (B3): each light is a layer created through
 * the engine API with its starting fields as `init`, and the assertions read
 * the light back through `readNodeLight`, the engine document's reader.
 */

import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import type { PropertyInit } from '@motion/engine-api';
import { LightSection } from './LightSection';
import { useSelectionStore } from '@stores/selectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';
import { clearHistory, setupAppEngine } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { values } from '@core/engine/propRefs';
import { readNodeLight, type LightFalloff, type LightType } from '@core/scene/light';
import { documentMirror } from '@stores/documentMirror';

jest.useFakeTimers();

let h: Harness;
let ID = '';

beforeEach(async () => {
  h = await setupAppEngine();
  // The twirls remember their open state; every case starts from the defaults.
  usePreferenceStore.getState().set('inspectorSections', {});
});
afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };

interface LightInit { lightType?: LightType; falloff?: LightFalloff }

function initOf(props: LightInit): PropertyInit[] {
  const init: PropertyInit[] = [];
  if (props.lightType !== undefined) init.push({ path: 'light/lightType', value: values.choice(props.lightType) });
  if (props.falloff !== undefined) init.push({ path: 'light/falloff', value: values.choice(props.falloff) });
  return init;
}

async function mount(props: LightInit = {}): Promise<void> {
  await act(async () => {
    ({ layer: ID } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'light', name: 'Rows light', init: initOf(props) }));
    await documentMirror().loadTree(ID);
  });
  await clearHistory();
  useSelectionStore.setState({ ids: [ID] } as never);
  render(<LightSection nodeId={ID} />);
}

async function currentLight(): Promise<ReturnType<typeof readNodeLight>> {
  const node = (await docView()).getNode(ID);
  if (!node) throw new Error('light vanished');
  return readNodeLight(node);
}

/** Whether a row with this accessible name is drawn. */
const has = (label: string): boolean => screen.queryAllByLabelText(label).length > 0;

describe('Falloff, Radius and Falloff Distance', () => {
  it.each<LightType>(['parallel', 'ambient'])('are not drawn for a %s light — the engine reads no distance there', async (type) => {
    await mount({ lightType: type, falloff: 'smooth' });
    expect({ type, falloff: has('Falloff'), radius: has('Radius'), distance: has('Falloff Distance') })
      .toEqual({ type, falloff: false, radius: false, distance: false });
  });

  it.each<LightType>(['point', 'spot'])('are drawn for a %s light, each only where its curve reads it', async (type) => {
    await mount({ lightType: type });
    // None: constant intensity — no reach to set (and the glow is off).
    expect({ falloff: has('Falloff'), radius: has('Radius'), distance: has('Falloff Distance') })
      .toEqual({ falloff: true, radius: false, distance: false });

    fireEvent.change(screen.getByLabelText('Falloff'), { target: { value: 'smooth' } });
    await idle();
    expect((await currentLight()).falloff).toBe('smooth');
    expect({ radius: has('Radius'), distance: has('Falloff Distance') }).toEqual({ radius: true, distance: true });

    // Inverse Square Clamped clamps at the radius and ignores the distance.
    fireEvent.change(screen.getByLabelText('Falloff'), { target: { value: 'inverse-square' } });
    await idle();
    expect({ radius: has('Radius'), distance: has('Falloff Distance') }).toEqual({ radius: true, distance: false });
  });

  it('offers After Effects’ falloff names', async () => {
    await mount({ lightType: 'point' });
    const select = screen.getByLabelText('Falloff') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'Smooth', 'Inverse Square Clamped', 'Radius ramp (legacy)']);
  });

  it('is a plain row, not a "Falloff ▸ Falloff" twirl', async () => {
    await mount({ lightType: 'point' });
    expect(screen.queryByRole('button', { name: 'Falloff' })).toBeNull();
  });
});

describe('Casts Shadows', () => {
  it('is a row whose value reads On / Off, and its shadow rows follow it', async () => {
    // A new light casts shadows (the engine's createLayer default).
    await mount({ lightType: 'point' });
    const toggle = screen.getByRole('button', { name: 'Casts Shadows' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.textContent).toBe('On');
    expect(has('Shadow Darkness')).toBe(true);
    expect(has('Shadow Diffusion')).toBe(true);
    // No checkbox anywhere — a header never holds one, and the value IS the toggle.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    fireEvent.click(toggle);
    await idle();
    expect((await currentLight()).shadows).toBe(false);
    const off = screen.getByRole('button', { name: 'Casts Shadows' });
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(off.textContent).toBe('Off');
    expect(has('Shadow Darkness')).toBe(false);
  });

  it('keeps the shadow map under a Shadow Map twirl, with AE’s resolutions', async () => {
    await mount({ lightType: 'spot' });
    expect(has('Shadow Map Resolution')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Shadow Map' }));
    const res = screen.getByLabelText('Shadow Map Resolution') as HTMLSelectElement;
    expect([...res.options].map((o) => o.textContent)).toEqual(['512', '1024', '2048']);
    expect(has('Shadow Bias')).toBe(true);
    expect(has('Map Softness')).toBe(true);
  });

  it('is not offered on an ambient light', async () => {
    await mount({ lightType: 'ambient' });
    expect(screen.queryByRole('button', { name: 'Casts Shadows' })).toBeNull();
  });
});

describe('Point of Interest', () => {
  it('untargeted: Direction and a bordered Add Target; targeted: one X / Y / Z row and Aim by Angle', async () => {
    await mount({ lightType: 'spot' });
    expect(has('Direction')).toBe(true);
    expect(has('Point of Interest X')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add Target' }));
    await idle();
    expect((await currentLight()).poi).not.toBeNull();
    // One row, three fields — the Position row's component, so each axis
    // keyframes on its own track.
    for (const axis of ['X', 'Y', 'Z']) {
      expect({ axis, field: screen.getAllByRole('spinbutton', { name: `Point of Interest ${axis}` }).length > 0 })
        .toEqual({ axis, field: true });
    }
    expect(has('Direction')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Aim by Angle' }));
    await idle();
    expect((await currentLight()).poi).toBeNull();
    expect(has('Direction')).toBe(true);
  });

  it('writes an axis through its own track', async () => {
    await mount({ lightType: 'parallel' });
    fireEvent.click(screen.getByRole('button', { name: 'Add Target' }));
    await idle();
    const before = (await currentLight()).poi!;
    const x = screen.getAllByRole('spinbutton', { name: 'Point of Interest X' })[0]!;
    fireEvent.keyDown(x, { key: 'ArrowUp' });
    await idle();
    const after = (await currentLight()).poi!;
    expect(after.x).not.toBe(before.x);
    expect([after.y, after.z]).toEqual([before.y, before.z]);
  });

  it('is not offered on a point light', async () => {
    await mount({ lightType: 'point' });
    expect(screen.queryByRole('button', { name: 'Add Target' })).toBeNull();
    expect(has('Direction')).toBe(false);
  });
});

describe('Show Glow in Viewer', () => {
  it('a new light starts with its glow off', async () => {
    await mount({ lightType: 'point' });
    expect((await currentLight()).glow).toBe(false);
  });

  it.each<LightType>(['point', 'spot'])('is a %s light’s Viewer row, an On / Off value', async (type) => {
    await mount({ lightType: type });
    fireEvent.click(screen.getByRole('button', { name: 'Viewer' }));
    const glow = screen.getByRole('button', { name: 'Show Glow in Viewer' });
    expect(glow.textContent).toBe('Off');
    fireEvent.click(glow);
    await idle();
    expect((await currentLight()).glow).toBe(true);
    expect(screen.getByRole('button', { name: 'Show Glow in Viewer' }).getAttribute('aria-pressed')).toBe('true');
  });

  it.each<LightType>(['parallel', 'ambient'])('is not offered for a %s light (a meaningless blob there)', async (type) => {
    await mount({ lightType: type });
    expect(screen.queryByRole('button', { name: 'Viewer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show Glow in Viewer' })).toBeNull();
  });
});

describe('the section reads as a property list', () => {
  it.each<LightType>(['parallel', 'spot', 'point', 'ambient'])('a %s light carries no paragraph of help — only the rows', async (type) => {
    await mount({ lightType: type });
    // The rows' column: the Light Type row's parent.
    const rows = screen.getByLabelText('Light Type').closest('div')!.parentElement!;
    expect(rows.querySelectorAll('p')).toHaveLength(0);
    expect(screen.queryByText(/directional wash/i)).toBeNull();
    expect(screen.queryByText(/keyframeable/i)).toBeNull();
  });
});
