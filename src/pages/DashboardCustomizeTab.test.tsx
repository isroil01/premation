/**
 * Tests for the dedicated Editor Customization surface on the dashboard.
 *
 * Verifies:
 * 1. The page renders all customization sections (Shortcuts, Workspaces, Appearance, Audio, Files).
 * 2. It opens by default on the Shortcuts tab in-page, never in a modal dialog.
 * 3. Section tabs switch correctly and update the view.
 * 4. Deep linking via ?section=... selects the right section on initial load.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardCustomizeTab } from './DashboardCustomizeTab';

function renderCustomizePage(initialUrl = '/dashboard?tab=customize'): HTMLElement {
  const { container } = render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <DashboardCustomizeTab />
    </MemoryRouter>,
  );
  return container;
}

describe('DashboardCustomizeTab', () => {
  it('renders all core customization section tabs', () => {
    renderCustomizePage();

    expect(screen.getByRole('tab', { name: /shortcuts/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /workspaces/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /appearance/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /audio/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /files/i })).toBeInTheDocument();
  });

  it('defaults to Shortcuts tab and renders in page, never in a modal dialog', () => {
    renderCustomizePage();

    const shortcutsTab = screen.getByRole('tab', { name: /shortcuts/i });
    expect(shortcutsTab).toHaveAttribute('aria-selected', 'true');

    // Shortcuts content is directly in the page
    expect(screen.getByRole('searchbox', { name: 'Search shortcuts' })).toBeInTheDocument();

    // No modal dialog scrim or modal container
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('switches to Workspaces tab on click', () => {
    renderCustomizePage();

    const workspacesTab = screen.getByRole('tab', { name: /workspaces/i });
    fireEvent.click(workspacesTab);

    expect(workspacesTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Workspace Layout Presets')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('switches to Appearance tab on click', () => {
    renderCustomizePage();

    const appearanceTab = screen.getByRole('tab', { name: /appearance/i });
    fireEvent.click(appearanceTab);

    expect(appearanceTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Theme & Brand Accent')).toBeInTheDocument();
    expect(screen.getByText('Dock & Panel Alignment')).toBeInTheDocument();
  });

  it('deep-links directly to appearance section when ?section=appearance is provided', () => {
    renderCustomizePage('/dashboard?tab=customize&section=appearance');

    const appearanceTab = screen.getByRole('tab', { name: /appearance/i });
    expect(appearanceTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Theme & Brand Accent')).toBeInTheDocument();
  });

  it('deep-links directly to workspaces section when ?section=workspaces is provided', () => {
    renderCustomizePage('/dashboard?tab=customize&section=workspaces');

    const workspacesTab = screen.getByRole('tab', { name: /workspaces/i });
    expect(workspacesTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Workspace Layout Presets')).toBeInTheDocument();
  });

  it('renders a comprehensive list of editor commands beyond empty fallback', () => {
    renderCustomizePage();

    // Verify there are dozens of commands loaded (not just 2)
    const editOrAddButtons = screen.getAllByRole('button', { name: /(edit|add) shortcut/i });
    expect(editOrAddButtons.length).toBeGreaterThan(10);
  });

  it('provides working Edit/Add and Delete buttons for shortcuts', () => {
    renderCustomizePage();

    // Find an edit button for a command with a shortcut
    const editBtns = screen.getAllByRole('button', { name: /edit shortcut/i });
    expect(editBtns.length).toBeGreaterThan(0);

    // Clicking edit/add button starts recording mode
    fireEvent.click(editBtns[0]!);
    expect(screen.getByText(/press keys now/i)).toBeInTheDocument();

    // Escape cancels recording
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText(/press keys now/i)).not.toBeInTheDocument();

    // Delete button removes the shortcut
    const deleteBtns = screen.getAllByRole('button', { name: /delete shortcut/i });
    expect(deleteBtns.length).toBeGreaterThan(0);
    const initialDeleteCount = deleteBtns.length;

    fireEvent.click(deleteBtns[0]!);
    // The deleted shortcut now shows "Assign shortcut" and has an Add shortcut button instead
    const updatedDeleteBtns = screen.queryAllByRole('button', { name: /delete shortcut/i });
    expect(updatedDeleteBtns.length).toBe(initialDeleteCount - 1);
  });
});
