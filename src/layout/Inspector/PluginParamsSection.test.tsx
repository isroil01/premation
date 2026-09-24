/**
 * A plugin's parameters, on a layer the plugin did not create.
 *
 * Three things are worth pinning here, and each of them is a quiet failure
 * rather than a crash:
 *
 *   • The rows have to be the INSPECTOR's rows. A plugin parameter that renders
 *     its own bespoke field looks nearly right and silently loses the
 *     stopwatch, the multi-selection aggregate and the undo behaviour every
 *     other property in the panel has.
 *   • The values have to land on the LAYER, under a key derived from the
 *     plugin, the panel and the parameter — because a track key that collides
 *     with a native one would address the wrong property in a user's document.
 *   • The section has to disappear with the plugin, and the values must NOT.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { getEventBus } from '@core/events/EventBus';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { usePluginStore } from '@stores/pluginStore';
import { parseManifest } from '@core/plugins/manifest';
import { pluginParamComponentType } from '@core/plugins/uiParams';
import { setPluginStatus, resetPluginStatusForTests } from '@core/plugins/uiStatus';
import { INSPECTOR_SECTIONS } from './inspectorSections';
import { InspectorSelectionProvider } from './inspectorSelection';
import { PluginParamsSection, hasPluginParamsSection, pluginParamsTitle } from './PluginParamsSection';

const PLUGIN = 'studio.acme.lab';
const COMPONENT = pluginParamComponentType(PLUGIN, 'lift');

const MANIFEST = {
  id: PLUGIN,
  name: 'Acme Lab',
  version: '1.0.0',
  description: 'Lifts things.',
  apiVersion: 7,
  main: 'main.js',
  contributes: {
    commands: [{ id: 'bake', label: 'Bake' }],
    inspector: [{
      id: 'lift',
      title: '3D Lift',
      // Shapes only, so the "does not apply" case is testable on a text layer.
      appliesTo: ['shape'],
      params: [
        { name: 'amount', type: 'slider', default: 50, min: 0, max: 100, unit: '%', animatable: true },
        { name: 'mode', type: 'enum', default: 'soft', options: [
          { value: 'soft', label: 'Soft Light' },
          { value: 'hard', label: 'Hard Light' },
        ] },
        { name: 'soft', type: 'checkbox', default: false },
        { name: 'centre', type: 'point', default: { x: 0, y: 0 }, animatable: true },
        { name: 'feather', type: 'slider', default: 1, group: 'Edges',
          showIf: { param: 'soft', equals: true } },
        { name: 'state', type: 'status', label: 'State', text: 'Idle' },
      ],
    }],
  },
};

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };
/** A shape layer (the panel applies) and a text layer (`appliesTo: ["shape"]` — it does not), made through the engine. */
let shape1: string;
let text1: string;

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };

function install(enabled = true): void {
  const { manifest, errors } = parseManifest(MANIFEST);
  expect(errors).toEqual([]);
  usePluginStore.getState().put({
    manifest, granted: [], enabled, files: {}, binaries: {}, installedAt: 0, source: 'file',
  } as never);
}

/** The values component the section writes through, or undefined. */
const stored = (id: string): Record<string, unknown> | undefined =>
  defaultSceneGraph.getNode(id)?.components.find((c) => c.type === COMPONENT)?.props as
    Record<string, unknown> | undefined;

const draw = (id: string): void => {
  render(
    <InspectorSelectionProvider nodeIds={[id]}>
      <PluginParamsSection nodeId={id} />
    </InspectorSelectionProvider>,
  );
};

beforeEach(async () => {
  await usePluginStore.getState().hydrate();
  for (const p of [...usePluginStore.getState().plugins]) usePluginStore.getState().remove(p.manifest.id);
  resetPluginStatusForTests();
  h = await setupAppEngine();
  defaultAnimation.setChangeListener((nodeId) => getEventBus().emit('AnimationChanged', { nodeId }));
  ({ layer: shape1 } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'shape', name: shape1, init: [] }));
  ({ layer: text1 } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'text', name: text1, init: [] }));
  getCommandSystem().getHistory().clear();
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

describe('the registry entry', () => {
  it('is registered under a stable id, with a selection-wide predicate', () => {
    // `pluginParams` is the key into the user's persisted open/closed choice.
    // Renaming it silently resets that preference for everyone.
    const def = INSPECTOR_SECTIONS.find((s) => s.id === 'pluginParams');
    expect(def).toBeDefined();
    expect(def!.Component).toBe(PluginParamsSection);
    expect(typeof def!.appliesToSelection).toBe('function');
  });

  it('applies only where a plugin actually contributes', () => {
    expect(hasPluginParamsSection(shape1)).toBe(false);
    install();
    expect(hasPluginParamsSection(shape1)).toBe(true);
    // `appliesTo: ["shape"]` — a text layer is not this panel's business.
    expect(hasPluginParamsSection(text1)).toBe(false);

    const def = INSPECTOR_SECTIONS.find((s) => s.id === 'pluginParams')!;
    expect(def.appliesToSelection!([shape1, text1])).toBe(false);
    expect(def.appliesToSelection!([shape1])).toBe(true);
  });

  it('titles itself with the panel when there is exactly one', () => {
    install();
    expect(pluginParamsTitle(shape1)).toBe('3D Lift');
  });
});

describe('rendered from the schema', () => {
  beforeEach(() => install());

  it('names every parameter, and attributes the panel to its plugin', () => {
    draw(shape1);
    expect(screen.getByText('3D Lift')).toBeInTheDocument();
    expect(screen.getByText('Acme Lab')).toBeInTheDocument();
    // `getAllBy`: a `ValueField` labels both its wrapper and its input, so one
    // parameter is legitimately two matches.
    expect(screen.getAllByLabelText('Amount').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Mode')).toBeInTheDocument();
    expect(screen.getByLabelText('Soft')).toBeInTheDocument();
    // The point is ONE row of axis fields, not two rows called "Centre X".
    expect(screen.getAllByLabelText('Centre X').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Centre Y').length).toBeGreaterThan(0);
  });

  it('shows the enum s LABELS, not its stored values', () => {
    draw(shape1);
    expect(screen.getByRole('option', { name: 'Soft Light' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'soft' })).not.toBeInTheDocument();
  });

  it('never shows the track key, which is internal plumbing', () => {
    draw(shape1);
    expect(document.body.textContent).not.toContain('pluginUi.');
  });

  it('writes an enum choice onto the layer under the declared name — one undo entry', async () => {
    draw(shape1);
    const before = h.doc();
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'hard' } });
    await idle();
    expect(stored(shape1)!.mode).toBe('hard');
    // Seeded whole, so a plugin reading back never meets `undefined` for a
    // parameter its own manifest says has a value.
    expect(stored(shape1)!.amount).toBe(50);
    expect(stored(shape1)!['centre.x']).toBe(0);
    settle();
    expect(historyLabels()).toHaveLength(1);
    // Undo takes the seeded group with the choice: the layer is as it was.
    await undo();
    expect(stored(shape1)).toBeUndefined();
    expect(h.doc()).toBe(before);
  });

  it('honours showIf against a sibling that is written after the first render', async () => {
    draw(shape1);
    expect(screen.queryByLabelText('Feather')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Soft'));
    await idle();
    expect(stored(shape1)!.soft).toBe(true);
    expect(screen.getAllByLabelText('Feather').length).toBeGreaterThan(0);
    // Its group heading comes with it.
    expect(screen.getByText('Edges')).toBeInTheDocument();
  });

  it('shows the declared status line until the plugin writes one', () => {
    draw(shape1);
    expect(screen.getByText('Idle')).toBeInTheDocument();
    act(() => { setPluginStatus(PLUGIN, 'lift', 'state', '12 pins placed'); });
    expect(screen.getByText('12 pins placed')).toBeInTheDocument();
  });
});

describe('when the plugin goes away', () => {
  it('takes its section but leaves the values in the document', async () => {
    install();
    draw(shape1);
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'hard' } });
    await idle();
    cleanup();

    usePluginStore.getState().remove(PLUGIN);
    expect(hasPluginParamsSection(shape1)).toBe(false);
    // The values are the USER's, not the plugin's: reinstalling has to find
    // the work where it was left.
    expect(stored(shape1)!.mode).toBe('hard');
  });
});
