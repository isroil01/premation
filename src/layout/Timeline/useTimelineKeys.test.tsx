import { render } from '@testing-library/react';
import { useTimelineKeys } from './useTimelineKeys';
import { performRedo, performUndo } from '@stores/historyStore';

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
