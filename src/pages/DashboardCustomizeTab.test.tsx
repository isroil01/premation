/**
 * The dashboard's Preferences pages.
 *
 * Verifies:
 * 1. Every subject has its own page, and `?section=` addresses map onto them
 *    (including the old `tabs` id for Workspaces, and General for anything unknown).
 * 2. Each page renders its own settings in the page — never in a modal dialog,
 *    and never another page's settings.
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPreferencePage, normalizePreferencePage, preferencePages, type PreferencePage } from './DashboardCustomizeTab';

function renderPage(page: PreferencePage): void {
  render(
    <MemoryRouter initialEntries={[`/dashboard?tab=customize&section=${page}`]}>
      <DashboardPreferencePage page={page} />
    </MemoryRouter>,
  );
}

describe('Preferences pages', () => {
  it('lists the core pages', () => {
    const ids = preferencePages().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['general', 'appearance', 'workspaces', 'shortcuts', 'cache', 'export', 'audio', 'files', 'models']));
  });

  it('maps section addresses onto pages', () => {
    expect(normalizePreferencePage(null)).toBe('general');
    expect(normalizePreferencePage('shortcuts')).toBe('shortcuts');
    expect(normalizePreferencePage('Workspaces')).toBe('workspaces');
    expect(normalizePreferencePage('tabs')).toBe('workspaces');
    expect(normalizePreferencePage('nonsense')).toBe('general');
  });

  it('renders Shortcuts in the page, not in a dialog', () => {
    renderPage('shortcuts');
    expect(screen.getByRole('searchbox', { name: 'Search shortcuts' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders Workspaces on its own page', () => {
    renderPage('workspaces');
    expect(screen.getByText('Layouts')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Search shortcuts' })).not.toBeInTheDocument();
  });

  it('keeps Appearance to theme, size and panel positions', () => {
    renderPage('appearance');
    expect(screen.getByRole('heading', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Size and density' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Panel positions' })).toBeInTheDocument();
    // Editing behaviour lives on General now, not under Appearance.
    expect(screen.queryByRole('heading', { name: 'Editing' })).not.toBeInTheDocument();
  });

  it('puts editing behaviour on General', () => {
    renderPage('general');
    expect(screen.getByRole('heading', { name: 'Editing' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Double-clicking a layer' })).toBeInTheDocument();
  });
});
