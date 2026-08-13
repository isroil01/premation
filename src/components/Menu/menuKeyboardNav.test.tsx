/**
 * Arrow keys must be able to reach every enabled item in a menu.
 *
 * WHY THIS EXISTS. The roving-focus query filtered on `aria-disabled="true"` —
 * and nothing in Menu.tsx ever set aria-disabled. `MenuItem` renders the NATIVE
 * `disabled` attribute, so disabled entries stayed in the focus list, and
 * `.focus()` on a natively disabled button is a silent no-op. Arrow-key
 * navigation therefore stopped dead on the first greyed-out entry, and
 * everything below it was unreachable by keyboard.
 *
 * That is not hypothetical for the menu this was found in: File ▸ Sync
 * Project… is disabled whenever no bundle project is open, which is the state
 * the local edition boots into — so Export… and Close Project sat below a wall.
 *
 * The same query also omitted `menuitemcheckbox` entirely, so every toggle in
 * the View menu (Show Grid, Snap to Grid, Toggle Rulers…) was skipped too.
 */

import { render, screen } from '@testing-library/react';
import { Menu, MenuItem } from './Menu';

function press(key: string): void {
  const menu = screen.getByRole('menu');
  // The handler lives on the menu root and reads document.activeElement.
  menu.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function focusedLabel(): string {
  return (document.activeElement as HTMLElement | null)?.textContent?.trim() ?? '(none)';
}

describe('menu keyboard navigation', () => {
  it('steps PAST a disabled item to the enabled one below it', () => {
    render(
      <Menu ariaLabel="File">
        <MenuItem id="a" label="Save" />
        <MenuItem id="b" label="Sync Project…" disabled />
        <MenuItem id="c" label="Export…" />
      </Menu>,
    );

    screen.getByText('Save').closest('button')!.focus();
    expect(focusedLabel()).toBe('Save');

    press('ArrowDown');

    // Used to stay on "Save" forever: the disabled button was next in the list
    // and could not take focus.
    expect(focusedLabel()).toBe('Export…');
  });

  it('End reaches the last item even when a disabled one precedes it', () => {
    render(
      <Menu ariaLabel="File">
        <MenuItem id="a" label="Save" />
        <MenuItem id="b" label="Sync Project…" disabled />
        <MenuItem id="c" label="Close Project" />
      </Menu>,
    );

    screen.getByText('Save').closest('button')!.focus();
    press('End');

    expect(focusedLabel()).toBe('Close Project');
  });

  it('includes toggles, which the query used to skip entirely', () => {
    // `checked` makes MenuItem render role="menuitemcheckbox" — a role the
    // roving-focus selector did not ask for, so the whole View menu's toggles
    // were invisible to the arrow keys.
    render(
      <Menu ariaLabel="View">
        <MenuItem id="a" label="Toggle Rulers" />
        <MenuItem id="b" label="Show Grid" checked={false} />
      </Menu>,
    );

    screen.getByText('Toggle Rulers').closest('button')!.focus();
    press('ArrowDown');

    expect(focusedLabel()).toBe('Show Grid');
  });
});
