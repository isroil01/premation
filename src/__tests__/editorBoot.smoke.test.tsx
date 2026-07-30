/**
 * SMOKE: the editor actually boots, and booting it logs nothing unexpected.
 *
 * Two defects in two consecutive changes passed the full unit suite AND
 * `tsc --noEmit`, and were caught only by loading the app by hand:
 *
 *  - A helper used by the `tracks` memo was declared as a component-scope
 *    `const` AFTER it. Temporal dead zone, so the first render threw
 *    "Cannot access 'isLayerAudioMuted' before initialization" and the user got
 *    the error boundary instead of an editor. 4,600 unit tests stayed green.
 *  - An inspector section rendered rows that were never reached, because the
 *    component returned early above them.
 *
 * Neither is expressible as a unit test of a pure function, because neither is
 * about a pure function. This mounts the real shell inside the real provider
 * tree and fails on any error surfacing through React or the console.
 *
 * ## The trap this test fell into first, documented so it isn't re-dug
 *
 * `Providers` shows a loading screen while it boots the Application core. A
 * synchronous `render()` therefore only ever sees "Loading editor…" — seven DOM
 * nodes, none of them the editor. The first draft asserted against exactly that
 * and passed happily with the TDZ bug deliberately reintroduced. **Waiting for
 * the loading screen to clear is what gives this test teeth**, and the
 * node-count assertion below is what stops it going hollow again.
 */

import { render, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { EditorShell } from '../App';
import { Providers } from '@providers/Providers';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertPrimitive } from '@core/scene/sceneInsert';

// Browser capability jsdom lacks. Environment shims, NOT behaviour stubs —
// nothing here changes what the app does, it only lets it reach first paint.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
  });
  if (!('ResizeObserver' in window)) {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

/**
 * Boot with LAYERS in the document.
 *
 * An empty comp is not a smoke test. The `tracks` memo traverses the layer
 * tree, so with nothing in the scene most of the per-layer render path — the
 * exact path the TDZ bug lived on — never executes, and the test passes with
 * the bug reintroduced. Verified: with an empty document it did.
 */
function seedScene(): void {
  seedDefaultScene();
  insertPrimitive('shape', 'Smoke Shape');
  insertPrimitive('text', 'Smoke Text');
}

/** The wrappers the real app always supplies: router, tooltips, app core. */
function boot(): HTMLElement {
  const { container } = render(
    <MemoryRouter>
      <TooltipProvider>
        <Providers>
          <EditorShell />
        </Providers>
      </TooltipProvider>
    </MemoryRouter>,
  );
  return container;
}

async function bootAndSettle(): Promise<HTMLElement> {
  seedScene();
  const container = boot();
  await waitFor(
    () => {
      if ((container.textContent ?? '').includes('Loading editor')) throw new Error('still booting');
    },
    { timeout: 20000 },
  );
  return container;
}

/**
 * console.error lines that are jsdom GAPS rather than app defects.
 * Deliberately specific and deliberately short: anything not matched here
 * fails the test. Widening this to silence a real message defeats the point.
 */
const ENV_NOISE = [
  /indexedDB is not defined/i,            // no IndexedDB in jsdom; AssetStore logs and degrades
  /React Router Future Flag Warning/i,
  /v7_startTransition|v7_relativeSplatPath/i,
  /Not implemented: HTMLCanvasElement/i,  // no 2D/GL context in jsdom
  /WebGL|WebGPU|getContext/i,
];

describe('editor boot', () => {
  let errors: unknown[][] = [];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    errors = [];
    spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    spy.mockRestore();
    cleanup();
  });

  it('gets past the loading screen and renders real chrome', async () => {
    const container = await bootAndSettle();
    // If this ever reads single digits again, the test has gone hollow.
    expect(container.querySelectorAll('*').length).toBeGreaterThan(100);
  }, 30000);

  it('does not render its error boundary', async () => {
    const container = await bootAndSettle();
    expect(container.textContent ?? '').not.toMatch(/EDITOR ERROR|Something went wrong/i);
  }, 30000);

  it('logs no unexpected console.error while booting', async () => {
    await bootAndSettle();
    // React reports render-phase throws through console.error even when an
    // error boundary swallows them, so this catches failures the DOM
    // assertions above cannot see.
    const unexpected = errors
      .map((a) => a.map(String).join(' '))
      .filter((m) => !ENV_NOISE.some((re) => re.test(m)));
    expect(unexpected).toEqual([]);
  }, 30000);
});
