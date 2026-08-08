/**
 * The reconciliation report reaches a human.
 *
 * `pluginStore.hydrate()` has always recorded what boot had to drop, and until
 * now nothing rendered it — so a plugin whose package went missing vanished
 * between sessions with no message anywhere. That is the failure this guards:
 * not that the store computes the report, but that the report is SEEN.
 *
 * Asserted through the real store rather than a mocked selector. A mock would
 * prove the JSX renders a prop, which is the half that was never broken.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { usePluginStore } from '@stores/pluginStore';
import { PluginsList } from './PluginsList';

jest.mock('@core/config/edition', () => ({ pluginRegistryEnabled: () => false }));
jest.mock('@core/plugins/registry', () => ({
  browseRegistry: jest.fn(async () => ({ available: false, items: [], total: 0 })),
  checkForUpdates: jest.fn(async () => []),
  registryMediaUrl: (p: string | null) => p,
}));

function setReport(over: Partial<{ droppedNoPayload: string[]; orphansRemoved: string[] }>) {
  usePluginStore.setState({
    lastHydration: { restored: [], droppedNoPayload: [], orphansRemoved: [], ...over },
  });
}

afterEach(() => { usePluginStore.setState({ lastHydration: null }); });

it('says nothing when the reconciliation was clean', () => {
  setReport({});
  render(<PluginsList />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('★ names a plugin that was dropped for having no package', () => {
  // The whole point. Silence here is indistinguishable from the app deciding
  // to uninstall something on the user's behalf.
  setReport({ droppedNoPayload: ['studio.acme.easing-lab'] });
  render(<PluginsList />);
  expect(screen.getByRole('status')).toHaveTextContent('studio.acme.easing-lab');
  expect(screen.getByText(/could not be restored/i)).toBeInTheDocument();
});

it('counts correctly when several were dropped', () => {
  setReport({ droppedNoPayload: ['a.b.c', 'd.e.f'] });
  render(<PluginsList />);
  expect(screen.getByText(/2 plugins could not be restored/i)).toBeInTheDocument();
});

it('reports freed orphans even though nothing visible was lost', () => {
  setReport({ orphansRemoved: ['a.b.c'] });
  render(<PluginsList />);
  expect(screen.getByRole('status')).toHaveTextContent(/leftover package was.*cleared/is);
});

it('can be dismissed', () => {
  setReport({ droppedNoPayload: ['a.b.c'] });
  render(<PluginsList />);
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
