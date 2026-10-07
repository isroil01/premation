/**
 * The two transition drag payloads the timeline accepts from the Library: a
 * cut transition (dropped on a cut) and a layer transition (dropped on a bar's
 * start or end). Each is recognisable during `dragover` from the TYPE list
 * alone, and neither is mistaken for the other.
 */

import {
  isLayerTransitionDrag,
  isTransitionDrag,
  markLayerTransitionDrag,
  readLayerTransitionDrag,
  readTransitionDrag,
  startCutTransitionDrag,
} from './transitionDrag';

function fakeTransfer(): DataTransfer {
  const data = new Map<string, string>();
  return {
    setData: (type: string, value: string) => { data.set(type, value); },
    getData: (type: string) => data.get(type) ?? '',
    get types() { return [...data.keys()]; },
    effectAllowed: 'none',
  } as unknown as DataTransfer;
}

it('a cut transition is recognised as one, with its kind', () => {
  const dt = fakeTransfer();
  startCutTransitionDrag(dt, 'dipToBlack');
  expect(isTransitionDrag(dt)).toBe(true);
  expect(isLayerTransitionDrag(dt)).toBe(false);
  expect(readTransitionDrag(dt)).toBe('dipToBlack');
});

it('a Library layer transition is recognised as one, with its item id', () => {
  const dt = fakeTransfer();
  markLayerTransitionDrag(dt, 'whip-pan');
  expect(isLayerTransitionDrag(dt)).toBe(true);
  expect(isTransitionDrag(dt)).toBe(false);
  expect(readLayerTransitionDrag(dt)).toBe('whip-pan');
});

it('an unknown kind is not read as a cut transition', () => {
  const dt = fakeTransfer();
  dt.setData('application/x-premation-transition', 'nonsense');
  expect(readTransitionDrag(dt)).toBeNull();
});
