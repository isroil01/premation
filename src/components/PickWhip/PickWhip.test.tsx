/**
 * PickWhip — the modifiers it reports on drop.
 *
 * The whip is one of the two parenting gestures, and Alt gives it a different
 * meaning (link WITHOUT compensating the transform — After Effects' "jump"
 * variant). That only works if the modifier survives the trip from the release
 * event to `onPick`, which is a component contract and belongs here rather than
 * in whichever caller happens to use it.
 *
 * Driven with real pointer events because that is the only path the component
 * has; `setPointerCapture` is stubbed the way `PuppetOverlay.test.tsx` does it,
 * since jsdom has no active pointer to capture.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { PickWhip } from './PickWhip';

jest.mock('@core/whip/whipTarget', () => ({
  // The drop target is resolved from the DOM, which jsdom cannot hit-test
  // (every element has a zero rect). The whip's own behaviour is what is under
  // test, so the resolver is stubbed to always find the same layer.
  resolveWhipTargetAt: () => ({ nodeId: 'target-layer' }),
}));

function drag(button: HTMLElement, init: { altKey?: boolean } = {}): void {
  const opts = { clientX: 40, clientY: 40, pointerId: 1, button: 0, ...init };
  act(() => { fireEvent.pointerDown(button, opts); });
  act(() => { fireEvent.pointerMove(button, opts); });
  act(() => { fireEvent.pointerUp(button, { ...opts, buttons: 0 }); });
}

beforeAll(() => {
  jest.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
  jest.spyOn(Element.prototype, 'releasePointerCapture').mockImplementation(() => {});
});

it('reports no modifiers on a plain drop', () => {
  const onPick = jest.fn();
  const { getByLabelText } = render(<PickWhip label="Parent pick-whip" onPick={onPick} />);

  drag(getByLabelText('Parent pick-whip'));

  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0]![0]).toEqual({ nodeId: 'target-layer' });
  expect(onPick.mock.calls[0]![1]).toMatchObject({ altKey: false });
});

it('reports altKey when the whip is released with Alt held', () => {
  const onPick = jest.fn();
  const { getByLabelText } = render(<PickWhip label="Parent pick-whip" onPick={onPick} />);

  drag(getByLabelText('Parent pick-whip'), { altKey: true });

  expect(onPick.mock.calls[0]![1]).toMatchObject({ altKey: true });
});

it('does not fire at all when the drop is refused', () => {
  const onPick = jest.fn();
  const { getByLabelText } = render(
    <PickWhip label="Parent pick-whip" onPick={onPick} accept={() => false} />,
  );

  drag(getByLabelText('Parent pick-whip'), { altKey: true });

  expect(onPick).not.toHaveBeenCalled();
});
