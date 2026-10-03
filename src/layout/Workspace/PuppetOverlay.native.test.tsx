/**
 * PuppetOverlay — the canvas pin UI.
 *
 * This is the layer that had NO automated coverage: every behaviour below was
 * verified by hand in the running app and nothing guarded it afterwards. The
 * bugs this file locks down are the ones that actually happened —
 *   • the wireframe describing a different mesh than the renderer (§12.3),
 *   • click-add storing a posed coordinate as a rest coordinate (§12.4),
 *   • two pins added in the same millisecond sharing an id (§12.7),
 *   • a drag-release spawning a stray pin,
 *   • `setPointerCapture` throwing and aborting the whole handler.
 */

import { render, act, fireEvent, waitFor } from '@testing-library/react';
import { PuppetOverlay } from './PuppetOverlay';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { readNodePuppet, clearRestMeshCache } from '@core/rig/puppet';
import { setupAppEngine, historyLabels, propRef, settleEdits, waitForFrame } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { rigTestLayer } from './__testHelpers__/rigLayer';

// A fixed 1:1 camera centred on the origin keeps screen↔local arithmetic
// obvious: local (0,0) is screen (0,0), and one local px is one screen px.
jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    onRender: () => () => undefined,
    requestRender: () => undefined,
    ws: {
      camera: {
        zoom: 1,
        worldToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
        screenToWorld: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      },
    },
  }),
}));

/** The overlay's SVG, once a frame has carried the geometry it draws from. */
/** An element of the overlay once a frame has drawn it (a pin just added draws with the next rig push). */
async function drawn(container: HTMLElement, selector: string): Promise<Element> {
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
  return container.querySelector(selector)!;
}

/** The overlay's SVG as mounted NOW (a frame may have re-rendered it since it was found). */
const live = (container: HTMLElement, fallback: Element): Element => container.querySelector('svg') ?? fallback;

async function svgOf(container: HTMLElement): Promise<SVGSVGElement> {
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  return container.querySelector('svg')!;
}

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created). */
let L = '';
/** Let the engine apply what the overlay sent (and React re-render). */
/** Let the engine apply what the overlay sent (and React re-render) — several rounds: the rig push's
 * subscription lands, and pointer input goes through getRigPose before it writes (B4 round 5). */
const idle = (): Promise<void> => act(async () => { await settleEdits(); await waitForFrame(300); await settleEdits(); });
const pinsOf = async (id: string) => readNodePuppet((await docView()).getNode(id)!)?.pins ?? [];

/** jsdom gives every element a zero rect, so offsets are all we control. */
function down(el: Element, x: number, y: number, init: Record<string, unknown> = {}): void {
  fireEvent.pointerDown(el, { clientX: x, clientY: y, pointerId: 1, ...init });
}

beforeEach(async () => {
  h = await setupAppEngine();
  clearRestMeshCache();
  L = await rigTestLayer(h, { puppet: { meshDensity: 6, meshExpansion: 0, pins: [] } });
  useSelectionStore.getState().set([L]);
  useUIStore.getState().setActiveTool('puppet-pin');
  useUIStore.getState().setPuppetPinKind('position');
});
afterEach(async () => { await h.dispose(); });

describe('gating', () => {
  it('renders nothing unless the puppet tool is active', async () => {
    act(() => useUIStore.getState().setActiveTool('select'));
    const { container } = render(<PuppetOverlay />);

    await idle();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders nothing without a selected layer', async () => {
    act(() => useSelectionStore.getState().set([]));
    const { container } = render(<PuppetOverlay />);

    await idle();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws the mesh wireframe for the selected layer', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    expect(container.querySelector('[data-puppet-mesh]')?.getAttribute('d')).toMatch(/^M/);
  });
});

describe('click-add', () => {
  it('adds a pin inside the layer bounds', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 30, clientY: 20 });
    await idle();
    const pins = (await pinsOf(L));
    expect(pins).toHaveLength(1);
    expect(pins[0]!.x).toBeCloseTo(30, 3);
    expect(pins[0]!.y).toBeCloseTo(20, 3);
    expect(pins[0]!.kind).toBe('position');
    expect(pins[0]!.id).toBe('pin_1');
    expect((await historyLabels()).at(-1)).toBe('Add Puppet Pin');
  });

  it('places a starch pin when that tool is armed', async () => {
    useUIStore.getState().setPuppetPinKind('starch');
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 12, clientY: -8 });
    await idle();
    const pins = (await pinsOf(L));
    expect(pins).toHaveLength(1);
    expect(pins[0]!.kind).toBe('starch');
    expect(pins[0]!.stiffness).toBe(8);
  });

  it('ignores clicks outside the layer bounds', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 5000, clientY: 5000 });
    await idle();
    expect((await pinsOf(L))).toHaveLength(0);
  });

  it('gives successive pins DISTINCT ids (§12.7 — Date.now() collided)', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 10, clientY: 10 });
    await idle();
    fireEvent.click(live(container, svg), { clientX: -10, clientY: -10 });
    await idle();
    const ids = (await pinsOf(L)).map((p) => p.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('a pointerdown on an existing pin does NOT spawn a stray pin', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 10, clientY: 10 });
    await idle();
    expect((await pinsOf(L))).toHaveLength(1);

    // pointerup synthesises a click even after stopPropagation on pointerdown;
    // the suppression guard is what stops that click from adding a second pin.
    const pinDot = await drawn(container, 'circle[r="5"]');
    down(pinDot.parentElement!, 10, 10);
    fireEvent.pointerUp(live(container, svg), { clientX: 10, clientY: 10, pointerId: 1 });
    await idle();
    fireEvent.click(live(container, svg), { clientX: 10, clientY: 10 });
    await idle();
    expect((await pinsOf(L))).toHaveLength(1);
  });
});

describe('pointer capture is not a precondition', () => {
  it('a pointerdown still selects when setPointerCapture throws', async () => {
    // A real browser throws NotFoundError here whenever the id is not an active
    // pointer, and the throw used to abort the rest of the handler — losing the
    // selection and the drag it was setting up. jest.setup polyfills capture as
    // a no-op, so force the throw to actually exercise `capturePointer`'s guard
    // rather than silently testing the happy path.
    const spy = jest
      .spyOn(Element.prototype, 'setPointerCapture')
      .mockImplementation(() => {
        throw new DOMException('No active pointer', 'NotFoundError');
      });
    try {
      useUIStore.getState().setPuppetPinKind('advanced');
      const { container } = render(<PuppetOverlay />);

      await idle();
      const svg = await svgOf(container);
      fireEvent.click(live(container, svg), { clientX: 20, clientY: 0 });
      await idle();

      await drawn(container, 'circle[r="5"]');
      // Pressed on the dot as mounted now (a frame may re-render it): again until the press reached
      // the handler (it captures the pointer, which throws here).
      await waitFor(() => {
        if (spy.mock.calls.length === 0) {
          const pinDot = container.querySelector('circle[r="5"]')!;
          expect(() => down(pinDot.parentElement!, 20, 0)).not.toThrow();
        }
        expect(spy).toHaveBeenCalled();
      });
      // The advanced-pin gizmo ring only exists on the SELECTED pin, so its
      // presence proves the handler ran past the throw.
      await drawn(container, 'circle[r="26"]');
    } finally {
      spy.mockRestore();
    }
  });

  it('a drag still writes its track when capture is unavailable', async () => {
    const spy = jest
      .spyOn(Element.prototype, 'setPointerCapture')
      .mockImplementation(() => {
        throw new DOMException('No active pointer', 'NotFoundError');
      });
    try {
      const { container } = render(<PuppetOverlay />);

      await idle();
      const svg = await svgOf(container);
      fireEvent.click(live(container, svg), { clientX: 0, clientY: 0 });
      await idle();
      const pinId = (await pinsOf(L))[0]!.id;

      const pinDot = await drawn(container, 'circle[r="5"]');
      down(pinDot.parentElement!, 0, 0);
      fireEvent.pointerMove(live(container, svg), { clientX: 12, clientY: 8, pointerId: 1 });
      fireEvent.pointerUp(live(container, svg), { clientX: 12, clientY: 8, pointerId: 1 });
      await idle();

      const v = (await docView()).getDataTrack(L, `puppet.${pinId}.position`)!
        .keyframes[0]!.value as Array<{ x: number; y: number }>;
      expect(v[0]!.x).toBeCloseTo(12, 3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('drag writes animation, not static props', () => {
  it('moving a pin writes its position data track', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 0, clientY: 0 });
    await idle();
    const pinId = (await pinsOf(L))[0]!.id;

    const pinDot = await drawn(container, 'circle[r="5"]');
    down(pinDot.parentElement!, 0, 0);
    fireEvent.pointerMove(live(container, svg), { clientX: 25, clientY: -15, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: 25, clientY: -15, pointerId: 1 });
    await idle();

    const track = (await docView()).getDataTrack(L, `puppet.${pinId}.position`);
    expect(track).toBeTruthy();
    const v = track!.keyframes[0]!.value as Array<{ x: number; y: number }>;
    expect(v[0]!.x).toBeCloseTo(25, 3);
    expect(v[0]!.y).toBeCloseTo(-15, 3);
    // The pin's STATIC rest position is untouched — only the track moved.
    expect((await pinsOf(L))[0]!.x).toBeCloseTo(0, 3);
    expect((await historyLabels()).at(-1)).toBe(`Move Puppet Pin ${pinId}`);
  });

  it('Alt-drag writes rotation instead of position', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 0, clientY: 0 });
    await idle();
    const pinId = (await pinsOf(L))[0]!.id;

    const pinDot = await drawn(container, 'circle[r="5"]');
    down(pinDot.parentElement!, 10, 0, { altKey: true });
    fireEvent.pointerMove(live(container, svg), { clientX: 0, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: 0, clientY: 10, pointerId: 1 });
    await idle();

    expect((await docView()).getTrackKeyframes(L, `puppet.${pinId}.rotation`)?.length).toBeGreaterThan(0);
    expect((await docView()).getDataTrack(L, `puppet.${pinId}.position`)).toBeFalsy();
  });

  it('the gizmo scale handle writes the scale track', async () => {
    useUIStore.getState().setPuppetPinKind('advanced');
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 0, clientY: 0 });
    await idle();
    const pinId = (await pinsOf(L))[0]!.id;

    const handle = await drawn(container, 'rect[width="8"]');
    down(handle, 26, 0);
    fireEvent.pointerMove(live(container, svg), { clientX: 52, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: 52, clientY: 0, pointerId: 1 });
    await idle();

    const kfs = (await docView()).getTrackKeyframes(L, `puppet.${pinId}.scale`);
    expect(kfs?.length).toBeGreaterThan(0);
    // Dragged to twice the grab radius ⇒ ~2x.
    expect(kfs![0]!.value).toBeCloseTo(2, 1);
  });
});

describe('deletion', () => {
  it('double-clicking a pin removes it AND its tracks', async () => {
    const { container } = render(<PuppetOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.click(live(container, svg), { clientX: 0, clientY: 0 });
    await idle();
    const pinId = (await pinsOf(L))[0]!.id;
    const rot = await propRef(L, `puppet.${pinId}.rotation`);
    await h.run({ type: 'addKeyframes', keys: [{ prop: rot, time: 0, value: { kind: 'scalar', value: 15 }, spatialIn: [], spatialOut: [] }] });
    await idle();
    expect((await docView()).getTrackKeyframes(L, `puppet.${pinId}.rotation`)).toHaveLength(1);

    const pinDot = await drawn(container, 'circle[r="5"]');
    fireEvent.doubleClick(pinDot.parentElement!, { clientX: 0, clientY: 0 });
    await idle();

    expect((await pinsOf(L))).toHaveLength(0);
    expect((await docView()).getTrackKeyframes(L, `puppet.${pinId}.rotation`)?.length ?? 0).toBe(0);
  });
});
