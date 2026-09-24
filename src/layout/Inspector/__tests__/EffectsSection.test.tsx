/**
 * The Properties panel's Effects section: the layer's applied stack (Effect
 * Controls' own body) plus a header "+" that adds from the effect catalogue.
 */

import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { EffectsSection, EffectsSectionActions, hasEffectsSection } from '../EffectsSection';
import { addEffect, effectDefFor, getNodeEffects } from '@core/effects/effects';
import { setupAppEngine } from '@core/engine/__testHelpers__/appEngine';

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});

afterEach(() => {
  cleanup();
});

/** A layer of `kind` in the app's engine — the section reads the document mirror (B4), which the engine feeds. */
async function withLayer(kind: 'solid' | 'camera', body: (id: string, h: Awaited<ReturnType<typeof setupAppEngine>>) => Promise<void> | void): Promise<void> {
  const h = await setupAppEngine();
  try {
    const { layer: id } = await h.run({ type: 'createLayer', comp: 'comp_root', kind, name: 'Probe', init: [] });
    await body(id, h);
  } finally {
    await h.dispose();
  }
}

it('applies to layers with pixels, even before they carry an effect', async () => {
  await withLayer('solid', (id) => {
    expect(hasEffectsSection(id)).toBe(true);
    expect(hasEffectsSection('no_such_node')).toBe(false);
  });
  await withLayer('camera', (id) => {
    expect(hasEffectsSection(id)).toBe(false);
  });
});

it('says so in one line when the layer has no effects', async () => {
  await withLayer('solid', (id) => {
    render(<EffectsSection nodeId={id} />);
    expect(screen.getByText('No effects. Use + to add one.')).toBeInTheDocument();
  });
});

it('renders the applied effects', async () => {
  await withLayer('solid', (id) => {
    addEffect(id, 'gaussian-blur');
    render(<EffectsSection nodeId={id} />);

    const label = effectDefFor('gaussian-blur')!.label;
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Remove ${label}` })).toBeInTheDocument();
    expect(screen.queryByText('No effects. Use + to add one.')).toBeNull();
  });
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
