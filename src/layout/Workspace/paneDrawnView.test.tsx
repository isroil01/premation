/**
 * A 2-up / 4-up pane's chrome is drawn with the view of the pane's frame ON
 * SCREEN, not with the pane's live camera.
 *
 * The pane's camera moves the moment a wheel or a middle-drag moves it; its
 * pixels (EnginePaneSurface, the pane's own engine viewport) follow once the
 * engine has drawn the new framing. The gizmo, the wireframes and the selection
 * outline used to follow the live camera and run ahead of the pixels. The
 * surface now reports the view each frame was drawn with (`onDrawnView`, once
 * per applied viewport) and the pane draws its chrome through it — while the
 * engine is still asked for the LIVE camera.
 *
 * The real SecondaryViewPane; the engine surface is stubbed to capture its
 * props (no GPU in jsdom).
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { PaneDrawnView, PaneView } from '@components/EngineSurface/EnginePaneSurface';
import { SecondaryViewPane } from './SecondaryViewPane';

const mockSurface: { onDrawnView?: (v: PaneDrawnView) => void; getView?: () => PaneView } = {};
jest.mock('@components/EngineSurface/EnginePaneSurface', () => ({
  EnginePaneSurface: (props: { onDrawnView?: (v: unknown) => void; getView?: () => unknown }) => {
    mockSurface.onDrawnView = props.onDrawnView as typeof mockSurface.onDrawnView;
    mockSurface.getView = props.getView as typeof mockSurface.getView;
    return null;
  },
}));

const BOX = { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, width: 400, height: 300, toJSON: () => ({}) } as DOMRect;
const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;

beforeAll(() => {
  jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(BOX);
  jest.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue(BOX);
  // jsdom has no ResizeObserver; the pane measures itself once on mount anyway.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

afterAll(() => {
  jest.restoreAllMocks();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
});

afterEach(cleanup);

/** The transform the pane's 3D chrome (gizmo group) is placed with. */
function chromeTransform(container: HTMLElement): string {
  return container.querySelector('g.gizmo-3d')?.getAttribute('transform') ?? '';
}
const asTransform = (v: { scale: number; offsetX: number; offsetY: number }): string =>
  `translate(${v.offsetX}, ${v.offsetY}) scale(${v.scale})`;

async function mount(): Promise<ReturnType<typeof render>> {
  const r = render(<SecondaryViewPane mode="top" />);
  await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  return r;
}

it('draws its chrome with the view its frame on screen was drawn with — and only moves when a new frame lands', async () => {
  const { container } = await mount();
  expect(mockSurface.onDrawnView).toBeDefined();
  // No frame yet: the live camera (the contain fit).
  const live0 = mockSurface.getView!();
  expect(chromeTransform(container)).toBe(asTransform(live0));

  // A frame drawn with that framing lands.
  act(() => mockSurface.onDrawnView!({ render: live0, view: 'top', customView: null }));
  expect(chromeTransform(container)).toBe(asTransform(live0));

  // The pane zooms (wheel): the engine is asked for the NEW camera at once…
  const pane = container.querySelector('svg[data-pane-interaction]')!;
  act(() => { fireEvent.wheel(pane, { deltaY: -400, clientX: 200, clientY: 150 }); });
  const live1 = mockSurface.getView!();
  expect(live1.scale).toBeGreaterThan(live0.scale);
  // …but the chrome stays on the picture still on screen.
  expect(chromeTransform(container)).toBe(asTransform(live0));

  // The frame drawn with the new camera lands: the chrome moves with it.
  act(() => mockSurface.onDrawnView!({ render: live1, view: 'top', customView: null }));
  expect(chromeTransform(container)).toBe(asTransform(live1));
});
