/**
 * The list is paged, and paging a list that is a UNION of two sources is where
 * this goes wrong quietly.
 *
 * Rows come from two places: the registry, which pages, and this machine, which
 * does not. Get the seam wrong in the obvious direction and every installed
 * plugin repeats on all eight pages. Get it wrong in the other and a plugin the
 * user already has shows an Install button on page 2, because the code looked
 * for local state in a map that only page 1 fills.
 *
 * Both of those look fine on a registry with twelve plugins in it, which is the
 * only registry that exists while the feature is being written. So they are
 * asserted here instead.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import pluginHost from '@core/plugins/PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { FakeWorker, useFakeWorkers, testPackage, bootPlugin } from '@core/plugins/fakeWorker.testkit';
import type { RegistryPlugin } from '@core/plugins/registry';
import { PluginsList } from './PluginsList';

jest.mock('@core/plugins/registry', () => ({
  browseRegistry: jest.fn(),
  checkForUpdates: jest.fn(async () => []),
  registryMediaUrl: (p: string | null) => p,
}));

const registry = require('@core/plugins/registry') as { browseRegistry: jest.Mock };

/** A registry summary. Only the fields the row actually reads are populated. */
function entry(id: string, name: string, installs = 100): RegistryPlugin {
  return {
    id,
    name,
    description: `${name} does a thing.`,
    homepage: null,
    latestVersion: '1.0.0',
    permissions: [],
    apiVersion: 2,
    hasPanel: false,
    installs,
    publisherKey: 'KEY',
    sha256: '',
    publisher: { namespace: 'acme', displayName: 'Acme', verified: false },
    categories: [],
    license: null,
    iconUrl: null,
    contributes: { commands: [], panels: [] },
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 20 registry rows per page, out of a catalogue of 60. */
function pageOf(offset: number, total = 60): { available: true; items: RegistryPlugin[]; total: number } {
  const items = Array.from({ length: Math.min(20, total - offset) }, (_, i) =>
    entry(`acme.p${offset + i}`, `Plugin ${offset + i}`, 1000 - (offset + i)),
  );
  return { available: true, items, total };
}

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  FakeWorker.last = null;
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => { jest.useRealTimers(); });

/** The list debounces its query by 250ms before it fetches anything. */
async function settle(): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(300); });
}

describe('paging the registry', () => {
  it('asks for one page, not the whole catalogue', async () => {
    registry.browseRegistry.mockResolvedValue(pageOf(0));
    render(<PluginsList />);
    await settle();

    // The bug this replaces: one unbounded request, rendered as if it were
    // everything. A `limit` the server silently caps is a list that stops
    // without saying so.
    expect(registry.browseRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20, offset: 0 }),
    );
    expect(await screen.findByText('1–20 of 60 plugins')).toBeTruthy();
  });

  it('advances by a page, and says which page it is on', async () => {
    registry.browseRegistry.mockImplementation(async (q: { offset?: number }) => pageOf(q.offset ?? 0));
    render(<PluginsList />);
    await settle();

    fireEvent.click(screen.getByLabelText('Next page'));
    await settle();

    expect(registry.browseRegistry).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 20, offset: 20 }),
    );
    expect(await screen.findByText('21–40 of 60 plugins')).toBeTruthy();
    expect(screen.getByText('Plugin 20')).toBeTruthy();
    expect(screen.queryByText('Plugin 0')).toBeNull();
  });

  it('returns to page one when the search changes', async () => {
    registry.browseRegistry.mockImplementation(async (q: { offset?: number }) => pageOf(q.offset ?? 0));
    render(<PluginsList />);
    await settle();
    fireEvent.click(screen.getByLabelText('Next page'));
    await settle();

    fireEvent.change(screen.getByLabelText('Search plugins'), { target: { value: 'easing' } });
    await settle();

    // Otherwise the first result of a new search is page 3 of it — which is
    // empty for most searches, and reads as "no matches".
    expect(registry.browseRegistry).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: 'easing', offset: 0 }),
    );
  });

  it('shows no pager at all where there is no registry', async () => {
    registry.browseRegistry.mockResolvedValue({ available: false });
    bootPlugin(testPackage([], 'com.test.local', { name: 'Local Only' }));
    render(<PluginsList />);
    await settle();

    // The local edition has one page by definition. A control offering to move
    // through pages that cannot exist is worse than no control.
    expect(screen.queryByLabelText('Pagination')).toBeNull();
    expect(await screen.findByText('Local Only')).toBeTruthy();
  });
});

describe('a registry that is absent versus one that is empty', () => {
  it('names the edition rather than claiming nothing is published', async () => {
    // These are different facts and only one of them is true. Told "Nothing
    // published yet", a self-hosted user waits for plugins that will never
    // arrive, because the feature is not in their build and there is nothing
    // they can do about it from this screen.
    registry.browseRegistry.mockResolvedValue({ available: false });
    render(<PluginsList />);
    await settle();

    expect(await screen.findByText(/registry isn.t available in this edition/i)).toBeTruthy();
    expect(screen.queryByText(/no plugins yet/i)).toBeNull();
  });

  it('says nothing matched when the registry answered and matched nothing', async () => {
    registry.browseRegistry.mockResolvedValue({ available: true, items: [], total: 0 });
    render(<PluginsList />);
    await settle();

    expect(await screen.findByText(/no plugins yet/i)).toBeTruthy();
    expect(screen.queryByText(/available in this edition/i)).toBeNull();
  });

  it('distinguishes both from a registry it could not reach', async () => {
    registry.browseRegistry.mockRejectedValue(new Error('offline'));
    render(<PluginsList />);
    await settle();

    // A third state, and the only one where retrying is the right advice.
    expect(await screen.findByText(/couldn.t reach the registry/i)).toBeTruthy();
  });
});

describe('installed plugins against a paged list', () => {
  it('lists a locally-installed plugin the registry has never heard of', async () => {
    registry.browseRegistry.mockResolvedValue(pageOf(0));
    bootPlugin(testPackage([], 'com.test.folder', { name: 'Work In Progress' }));
    render(<PluginsList />);
    await settle();

    // The author's own package, installed from a folder. It is in no registry
    // and a list that only rendered registry results would hide the one plugin
    // its user is actively working on.
    expect(await screen.findByText('Work In Progress')).toBeTruthy();
  });

  it('does not repeat it on every page', async () => {
    registry.browseRegistry.mockImplementation(async (q: { offset?: number }) => pageOf(q.offset ?? 0));
    bootPlugin(testPackage([], 'com.test.folder', { name: 'Work In Progress' }));
    render(<PluginsList />);
    await settle();
    expect(screen.getByText('Work In Progress')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('Next page'));
    await settle();

    // It belongs to the machine, not to the registry's stream. Carried onto
    // every page it would appear once per page in a list whose entire job is to
    // be a list of distinct plugins.
    await waitFor(() => expect(screen.queryByText('Work In Progress')).toBeNull());
  });

  it('still knows a plugin is installed when it appears on a later page', async () => {
    registry.browseRegistry.mockImplementation(async (q: { offset?: number }) => pageOf(q.offset ?? 0));
    // `acme.p25` is on page 2, and the user already has it.
    bootPlugin(testPackage([], 'acme.p25', { name: 'Plugin 25' }));
    render(<PluginsList />);
    await settle();
    fireEvent.click(screen.getByLabelText('Next page'));
    await settle();

    // Install state is read from the STORE, not from the page-1 merge map.
    // Reading it from the map would offer to install a copy the user has.
    const row = (await screen.findByText('Plugin 25')).closest('[role="button"]')!;
    expect(row.textContent).toContain('Disable');
    expect(row.textContent).not.toContain('Install');
  });
});

describe('adding a plugin from this computer', () => {
  it('is offered on the list itself, not only inside the manager modal', async () => {
    registry.browseRegistry.mockResolvedValue(pageOf(0));
    render(<PluginsList />);
    await settle();

    // The gap this closes: the list of every plugin had no way to add one. The
    // only route was a menu most users never open, to a modal, to a drop zone.
    expect(screen.getByLabelText('Add a plugin')).toBeTruthy();
  });
});

describe('an empty catalogue', () => {
  it('says so through the shared empty state, with a way back to the full list', async () => {
    registry.browseRegistry.mockResolvedValue({ available: true, items: [], total: 0 });
    render(<PluginsList />);
    await settle();

    expect(screen.getByText('No plugins yet.')).toBeTruthy();

    // With a query in the box the wording changes and an escape hatch appears
    // — the previous copy said "Try a broader search" and left the user to
    // find the field again.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search plugins' }), {
      target: { value: 'nothing-matches-this' },
    });
    await settle();

    expect(screen.getByText(/No plugins match/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show all plugins' })).toBeTruthy();
  });
});
