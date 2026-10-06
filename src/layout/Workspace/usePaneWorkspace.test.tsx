/**
 * A 2- / 4-up pane's drag is ONE viewport gesture, and a pane never hands the
 * engine a camera it has not framed.
 *
 * Regressions (2026-10-06, "moving objects in the extra views is broken"):
 *  • the panes never opened the viewport gesture the main viewport opens, so
 *    every pointer move was a one-shot edit from the layer's last MIRRORED
 *    position: each move the engine had not echoed yet was lost (the layer fell
 *    ~half behind the cursor), each move was its own undo step, and the drag
 *    flag that keeps cached frames off screen never went up;
 *  • the pane's first framing was missed (the fit ran before the camera-change
 *    subscription), so the engine drew the pane through the unfitted camera —
 *    zoom 1 about the pane's centre, a giant crop of the comp — until something
 *    else re-sent the viewport.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { usePaneWorkspace, type PaneWorkspaceApi } from './usePaneWorkspace';
import { paneViewTransform } from './useSceneRefGeometry';

const gesture = { begins: 0, ends: 0 };
jest.mock('@core/workspace/viewportGesture', () => {
  const actual = jest.requireActual('@core/workspace/viewportGesture');
  return {
    ...actual,
    beginViewportGesture: () => { gesture.begins += 1; },
    endViewportGesture: () => { gesture.ends += 1; },
  };
});

let api: PaneWorkspaceApi | null = null;

function Pane({ width, height }: { width: number; height: number }): JSX.Element {
  api = usePaneWorkspace({ mode: 'front', width, height, compWidth: 1920, compHeight: 1080 });
  return <svg data-testid="pane" width={width} height={height} {...api.handlers} />;
}

beforeEach(() => {
  gesture.begins = 0;
  gesture.ends = 0;
  api = null;
});

it('a left-button drag opens one gesture and closes it on release (as the main viewport does)', () => {
  const { getByTestId } = render(<Pane width={400} height={300} />);
  const pane = getByTestId('pane');
  // A stale gesture is ended first, then this press's is opened.
  fireEvent.pointerDown(pane, { clientX: 200, clientY: 150, button: 0, buttons: 1, pointerId: 3 });
  expect(gesture.begins).toBe(1);
  for (let i = 1; i <= 10; i++) fireEvent.pointerMove(pane, { clientX: 200 + i * 4, clientY: 150 + i * 2, buttons: 1, pointerId: 3 });
  expect(gesture.begins).toBe(1);
  const endsBeforeUp = gesture.ends;
  fireEvent.pointerUp(pane, { clientX: 240, clientY: 170, button: 0, buttons: 0, pointerId: 3 });
  expect(gesture.ends).toBe(endsBeforeUp + 1);
  // A hover afterwards opens nothing.
  fireEvent.pointerMove(pane, { clientX: 100, clientY: 100, buttons: 0, pointerId: 3 });
  expect(gesture.begins).toBe(1);
});

it('a cancelled drag closes its gesture too; a middle-button pan opens none', () => {
  const { getByTestId } = render(<Pane width={400} height={300} />);
  const pane = getByTestId('pane');
  fireEvent.pointerDown(pane, { clientX: 50, clientY: 50, button: 0, buttons: 1, pointerId: 4 });
  const endsBefore = gesture.ends;
  fireEvent.pointerCancel(pane, { clientX: 60, clientY: 50, pointerId: 4 });
  expect(gesture.ends).toBe(endsBefore + 1);

  const begins = gesture.begins;
  fireEvent.pointerDown(pane, { clientX: 50, clientY: 50, button: 1, buttons: 4, pointerId: 5 });
  fireEvent.pointerMove(pane, { clientX: 80, clientY: 60, buttons: 4, pointerId: 5 });
  fireEvent.pointerUp(pane, { clientX: 80, clientY: 60, button: 1, buttons: 0, pointerId: 5 });
  expect(gesture.begins).toBe(begins);
});

it('the camera is not the pane view until it is framed, and then it is the contain fit', () => {
  const { rerender } = render(<Pane width={0} height={0} />);
  // Unmeasured: no view of its own — the caller's contain fit is used, never zoom 1.
  expect(api!.getRenderView()).toBeUndefined();
  act(() => {
    rerender(<Pane width={400} height={300} />);
  });
  const v = api!.getRenderView();
  const fit = paneViewTransform(400, 300, 1920, 1080);
  expect(v?.scale).toBeCloseTo(fit.scale, 9);
  expect(v?.offsetX).toBeCloseTo(fit.offsetX, 6);
  expect(v?.offsetY).toBeCloseTo(fit.offsetY, 6);
});
