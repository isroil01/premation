/**
 * A dropdown opened from inside a modal dialog must be usable.
 *
 * It was not. A modal Radix dialog sets `pointer-events: none` on <body> and
 * dismisses on any pointerdown outside its content; popovers portalled to
 * <body> were outside on both counts, so every click on a menu item fell
 * through to whatever lay underneath — found in Settings ▸ Appearance, where
 * choosing a language instead changed the accent colour of the swatch below.
 * Layers now mount inside the dialog (`utils/floatingLayerContainer`).
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { TooltipProvider } from '@components/Tooltip/Tooltip';
import { Modal } from '@components/Modal';
import { Dropdown } from '@components/Dropdown';
import { Popover } from './Popover';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }
});

/** Radix arms its outside-pointer listener on a timeout after mount. */
async function settle(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

it('mounts a dropdown inside the dialog it was opened from, and picking an item keeps the dialog open', async () => {
  const onClose = jest.fn();
  const onPick = jest.fn();
  render(
    <TooltipProvider>
      <Modal open onClose={onClose} title="Settings">
        <Dropdown
          trigger={<button type="button">Language</button>}
          items={[{ type: 'item', id: 'zh', label: '简体中文', onSelect: onPick }]}
        />
      </Modal>
    </TooltipProvider>,
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Language' }));
  await settle();

  const item = screen.getByRole('menuitem', { name: '简体中文' });
  expect(screen.getByRole('dialog').contains(item)).toBe(true);

  fireEvent.pointerDown(item);
  fireEvent.click(item);
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();
});

it('still portals to <body> when not inside a dialog', () => {
  render(
    <div data-testid="host">
      <Popover trigger={<button type="button">Open</button>}>
        <span>content</span>
      </Popover>
    </div>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  const content = screen.getByText('content');
  expect(screen.getByTestId('host').contains(content)).toBe(false);
  expect(content.closest('[role="dialog"]')).toBeNull();
});
