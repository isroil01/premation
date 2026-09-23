/**
 * The inspector's Quality row lives in CompositingSection — the section the
 * Properties panel actually mounts. (An earlier Best/Draft/Wireframe picker was
 * added to a switches component nothing rendered — since deleted; this pins the
 * row where users can reach it.)
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { getNodeQuality } from '@core/effects/layerQuality';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';
import { CompositingSection } from './CompositingSection';
import { addLayer, idle } from './__testHelpers__/engineLayers';

const ID = 'quality_row_probe';

function solidNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, width: 100, height: 100, opacity: 100 } },
      { id: `${id}_fx`, type: 'fx', props: { solid: true } },
    ],
  } as unknown as SceneNode;
}

beforeAll(() => {
  // The row writes through the engine API (one undo step on the command system's history).
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

beforeEach(() => {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
  addLayer(solidNode(ID));
});

afterEach(() => {
  if (defaultSceneGraph.getNode(ID)) defaultSceneGraph.removeNode(ID);
});

describe('CompositingSection Quality row', () => {
  it('offers Best / Draft / Wireframe and starts on Best', () => {
    render(<TooltipProvider><CompositingSection nodeId={ID} /></TooltipProvider>);
    const group = screen.getByRole('radiogroup', { name: 'Layer quality' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Best' })).toHaveAttribute('aria-checked', 'true');
  });

  it('writes the picked quality to the layer', async () => {
    render(<TooltipProvider><CompositingSection nodeId={ID} /></TooltipProvider>);
    fireEvent.click(screen.getByRole('radio', { name: 'Wireframe' }));
    await idle();
    expect(getNodeQuality(ID)).toBe('wireframe');
    fireEvent.click(screen.getByRole('radio', { name: 'Draft' }));
    await idle();
    expect(getNodeQuality(ID)).toBe('draft');
  });
});
