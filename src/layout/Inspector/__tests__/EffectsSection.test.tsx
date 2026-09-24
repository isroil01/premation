/**
 * The Properties panel's Effects section: the layer's applied stack (Effect
 * Controls' own body) plus a header "+" that adds from the effect catalogue.
 */

import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { EffectsSection, EffectsSectionActions, hasEffectsSection } from '../EffectsSection';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { addEffect, effectDefFor, getNodeEffects } from '@core/effects/effects';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';

const ID = 'effects_section_probe';
const CAMERA = 'effects_section_camera';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function layer(id: string, kind: string): SceneNode {
  return {
    id,
    name: id,
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: kind } }],
  } as unknown as SceneNode;
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

beforeEach(() => {
  defaultSceneGraph.addNode(layer(ID, 'shape'));
});

afterEach(() => {
  cleanup();
  for (const id of [ID, CAMERA]) {
    if (defaultSceneGraph.getNode(id)) defaultSceneGraph.removeNode(id);
  }
});

it('applies to layers with pixels, even before they carry an effect', () => {
  expect(hasEffectsSection(ID)).toBe(true);
  defaultSceneGraph.addNode(layer(CAMERA, 'camera'));
  expect(hasEffectsSection(CAMERA)).toBe(false);
  expect(hasEffectsSection('no_such_node')).toBe(false);
});

it('says so in one line when the layer has no effects', () => {
  render(<EffectsSection nodeId={ID} />);
  expect(screen.getByText('No effects. Use + to add one.')).toBeInTheDocument();
});

it('renders the applied effects', () => {
  addEffect(ID, 'gaussian-blur');
  render(<EffectsSection nodeId={ID} />);

  const label = effectDefFor('gaussian-blur')!.label;
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: `Remove ${label}` })).toBeInTheDocument();
  expect(screen.queryByText('No effects. Use + to add one.')).toBeNull();
});

it('the header "+" opens a searchable add menu that adds to the layer', async () => {
  // The add goes through the engine (addEffect): a real layer in the app's engine.
  const h = await setupAppEngine();
  try {
    const { layer: id } = await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Probe', init: [] });
    render(<EffectsSectionActions nodeId={id} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add effect' }));
    const search = screen.getByRole('searchbox', { name: 'Search effects to add' });
    expect(search).toBeInTheDocument();

    const label = effectDefFor('gaussian-blur')!.label;
    fireEvent.change(search, { target: { value: label.slice(0, 5) } });
    fireEvent.click(screen.getByTitle(`Add ${label}`));

    await waitFor(() => expect(getNodeEffects(id).map((e) => e.type)).toContain('gaussian-blur'));
    // The menu closes once the effect is added.
    expect(screen.queryByRole('searchbox', { name: 'Search effects to add' })).toBeNull();
  } finally {
    await h.dispose();
  }
});
