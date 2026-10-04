/**
 * The inspector's Quality row lives in CompositingSection — the section the
 * Properties panel actually mounts. (An earlier Best/Draft/Wireframe picker was
 * added to a switches component nothing rendered — since deleted; this pins the
 * row where users can reach it.)
 */

import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import type { Command } from '@motion/engine-api';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import { documentMirror } from '@stores/documentMirror';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { CompositingSection } from './CompositingSection';
import { idle } from './__testHelpers__/engineLayers';

let h: Harness;
let ID = '';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

beforeEach(async () => {
  h = await setupAppEngine();
  ID = (await h.run({ type: 'createLayer', comp: 'comp_root', kind: 'solid', name: 'Quality', init: [] } as Command) as { layer: string }).layer;
  await idle();
});

afterEach(async () => {
  cleanup();
  await h.dispose();
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
    expect(documentMirror().layer(ID)?.switches.quality).toBe('wireframe');
    fireEvent.click(screen.getByRole('radio', { name: 'Draft' }));
    await idle();
    expect(documentMirror().layer(ID)?.switches.quality).toBe('draft');
  });
});
