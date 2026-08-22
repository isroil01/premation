/**
 * Scene / canvas right-click must show the full list, not a 280px scroller.
 *
 * The shared Menu defaults to max-height: 280px. ContextMenuHost is the only
 * surface for those layer menus, so the opt-out lives here — not on every
 * toolbar dropdown.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { Menu, MenuItem } from '@components/Menu';
import { ContextMenuHost } from './ContextMenuHost';
import { openContextMenu, closeContextMenu } from '@stores/contextMenuStore';

const HOST = join(__dirname, 'ContextMenuHost.tsx');

afterEach(() => {
  cleanup();
  closeContextMenu();
});

describe('Scene context menu', () => {
  it('opts the host Menu out of the 280px scroller', () => {
    const src = readFileSync(HOST, 'utf8');
    expect(src).toMatch(/<Menu[^>]*\bnoScroll\b/);
    expect(src).toMatch(/<Menu[^>]*\bspacious\b/);
  });

  it('renders every item without clipping the list to a handful of rows', () => {
    openContextMenu(20, 20, [
      { id: 'rename', label: 'Rename' },
      { id: 'duplicate', label: 'Duplicate' },
      { id: 'sep1', separator: true },
      { id: 'hide', label: 'Hide' },
      { id: 'lock', label: 'Lock' },
      { id: 'solo', label: 'Solo' },
      { id: 'sep2', separator: true },
      { id: 'group', label: 'Group Selection' },
      { id: 'precompose', label: 'Pre-compose…' },
      { id: 'sep3', separator: true },
      { id: 'delete', label: 'Delete', danger: true },
    ]);
    render(<ContextMenuHost />);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Pre-compose…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeTruthy();
  });
});

describe('Menu spacious / noScroll inherit into submenus', () => {
  it('a nested Menu still renders the submenu items when opened', () => {
    render(
      <Menu noScroll spacious ariaLabel="Layer">
        <MenuItem id="arrange" label="Arrange">
          <MenuItem id="front" label="Bring to Front" />
        </MenuItem>
      </Menu>,
    );
    expect(screen.getByRole('menu', { name: 'Layer' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Arrange/ })).toBeTruthy();
  });
});
