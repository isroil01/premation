import { render } from '@testing-library/react';
import { useTimelineKeys } from './useTimelineKeys';
import { performRedo, performUndo } from '@stores/historyStore';
import { useKeyframeSelectionStore } from '@stores/keyframeSelectionStore';

const mockDirectUndo = jest.fn();
const mockDirectRedo = jest.fn();

jest.mock('@core/commands/CommandSystem', () => ({
  getCommandSystem: () => ({
    getHistory: () => ({
      canUndo: () => true,
      canRedo: () => true,
      undo: mockDirectUndo,
      redo: mockDirectRedo,
    }),
  }),
}));
jest.mock('@stores/historyStore', () => ({
  performUndo: jest.fn(),
  performRedo: jest.fn(),
}));

function Host(): null {
  useTimelineKeys();
  return null;
}

it('uses the canonical history entry points for undo and redo', () => {
  render(<Host />);

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
  }));

  expect(performUndo).toHaveBeenCalledTimes(1);
  expect(performRedo).toHaveBeenCalledTimes(1);
  expect(mockDirectUndo).not.toHaveBeenCalled();
  expect(mockDirectRedo).not.toHaveBeenCalled();
});

/**
 * The arrow keys.
 *
 * `keyframeNudge.ts` is pure and fully unit-tested, and every one of those
 * tests passed while nothing in the app ever called it. What matters here is
 * only that the hook ASKS: that a selection makes the arrows a nudge, and that
 * an empty selection leaves them to the viewport, which owns them otherwise.
 */
const mockPush = jest.fn();
const mockFlush = jest.fn();
jest.mock('./keyframeNudge', () => ({
  ...jest.requireActual('./keyframeNudge'),
  createSelectionNudger: () => ({
    push: (...args: unknown[]) => mockPush(...args),
    flush: () => mockFlush(),
    isOpen: () => false,
  }),
}));
// No composition open: the nudge's frame step falls back to 30 fps (the mirror is not booted here).
jest.mock('@hooks/useMirrorFrame', () => ({
  activeCompSettingsNow: () => undefined,
}));

describe('arrow-key keyframe nudge', () => {
  beforeEach(() => {
    mockPush.mockClear();
    useKeyframeSelectionStore.getState().set(new Set());
  });

  it('nudges the selected keyframes one frame per press', () => {
    useKeyframeSelectionStore.getState().set(new Set(['kf']));
    render(<Host />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush.mock.calls[0]![0]).toMatchObject({ dv: 0 });
    expect((mockPush.mock.calls[0]![0] as { dt: number }).dt).toBeGreaterThan(0);
  });

  it('Shift makes it ten frames', () => {
    useKeyframeSelectionStore.getState().set(new Set(['kf']));
    render(<Host />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const one = (mockPush.mock.calls[0]![0] as { dt: number }).dt;
    mockPush.mockClear();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    expect((mockPush.mock.calls[0]![0] as { dt: number }).dt).toBeCloseTo(one * 10, 6);
  });

  it('Alt + up/down is a VALUE nudge, not a time one', () => {
    useKeyframeSelectionStore.getState().set(new Set(['kf']));
    render(<Host />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    expect(mockPush.mock.calls[0]![0]).toEqual({ dt: 0, dv: 1 });
  });

  it('leaves the arrows alone with nothing selected — they are the viewport’s', () => {
    render(<Host />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(mockPush).not.toHaveBeenCalled();
  });
});
