/**
 * StartScreen — the local edition's project browser.
 *
 * The behaviours worth pinning are the ones that make it a browser rather than
 * a decoration: a recent actually OPENS through the shared path, a recent that
 * no longer exists says so on its own row instead of failing silently, and the
 * New/Open buttons run the real commands rather than a second implementation of
 * them.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StartScreen } from './StartScreen';
import type { RecentProjectEntry } from '@core/project/RecentProjects';

const recents: RecentProjectEntry[] = [
  { id: 'a', name: 'Titles', path: '/work/Titles.motion', openedAt: 2 },
  { id: 'b', name: 'Logo Sting', path: '/work/Logo.motion', openedAt: 1 },
  // No path — a cloud/unsaved ref. Nothing to open, so it must not be offered.
  { id: 'c', name: 'Untitled', path: null, openedAt: 3 },
];

let list = [...recents];
const removed: string[] = [];
let current: unknown = null;

jest.mock('@core/services/coreServices', () => ({
  getRecentProjects: () => ({
    list: () => list,
    remove: (id: string) => { removed.push(id); list = list.filter((e) => e.id !== id); },
    subscribe: () => () => {},
  }),
  getProjectManager: () => ({ getState: () => ({ current }) }),
}));

const openProjectPath = jest.fn<Promise<unknown>, [string]>();
jest.mock('@core/project/openProjectPath', () => ({
  openProjectPath: (p: string) => openProjectPath(p),
}));

const execute = jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined);
jest.mock('@core/commands/CommandSystem', () => ({
  getCommandSystem: () => ({ execute: (id: string) => execute(id) }),
}));

beforeEach(() => {
  list = [...recents];
  removed.length = 0;
  current = null;
  openProjectPath.mockReset();
  execute.mockClear();
});

describe('StartScreen', () => {
  it('lists recents that have a path, and only those', () => {
    render(<StartScreen onDismiss={() => {}} />);
    expect(screen.getByText('Titles')).toBeInTheDocument();
    expect(screen.getByText('Logo Sting')).toBeInTheDocument();
    // A ref with no path cannot be opened from disk; offering it would be a
    // row that can only ever fail.
    expect(screen.queryByText('Untitled')).not.toBeInTheDocument();
  });

  it('opens a recent through the shared path and dismisses', async () => {
    openProjectPath.mockResolvedValue({ id: 'a', name: 'Titles' });
    const onDismiss = jest.fn();
    render(<StartScreen onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('Titles'));

    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
    expect(openProjectPath).toHaveBeenCalledWith('/work/Titles.motion');
  });

  it('marks a row missing when the bundle no longer opens, and stays up', async () => {
    // The whole point of the row-level failure: the user's next move is to
    // remove it or pick another, and a dismissed screen offers neither.
    openProjectPath.mockResolvedValue(null);
    const onDismiss = jest.fn();
    render(<StartScreen onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('Titles'));

    await waitFor(() => expect(screen.getByText(/Missing/)).toBeInTheDocument());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('a throw is reported on the row too, not just swallowed', async () => {
    openProjectPath.mockRejectedValue(new Error('EACCES'));
    render(<StartScreen onDismiss={() => {}} />);

    fireEvent.click(screen.getByText('Logo Sting'));

    await waitFor(() => expect(screen.getByText(/Missing/)).toBeInTheDocument());
  });

  it('removes an entry from the MRU', () => {
    render(<StartScreen onDismiss={() => {}} />);
    fireEvent.click(screen.getByLabelText('Remove Titles from recent projects'));
    expect(removed).toEqual(['a']);
    expect(screen.queryByText('Titles')).not.toBeInTheDocument();
  });

  it('New and Open run the real commands rather than reimplementing them', async () => {
    render(<StartScreen onDismiss={() => {}} />);

    fireEvent.click(screen.getByText('New Project'));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('project.new'));

    fireEvent.click(screen.getByText('Open…'));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('project.open'));
  });

  it('stays up when a command leaves no project open (a cancelled picker)', async () => {
    const onDismiss = jest.fn();
    render(<StartScreen onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('Open…'));

    await waitFor(() => expect(execute).toHaveBeenCalled());
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses once a command DID open something', async () => {
    const onDismiss = jest.fn();
    execute.mockImplementation(async () => { current = { id: 'x', name: 'New' }; });
    render(<StartScreen onDismiss={onDismiss} />);

    fireEvent.click(screen.getByText('New Project'));

    await waitFor(() => expect(onDismiss).toHaveBeenCalled());
  });

  it('says so when there is nothing to show', () => {
    list = [];
    render(<StartScreen onDismiss={() => {}} />);
    expect(screen.getByText(/Nothing yet/)).toBeInTheDocument();
  });
});
