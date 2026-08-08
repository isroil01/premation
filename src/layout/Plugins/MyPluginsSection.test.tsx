/**
 * The two controls on this shelf that a publisher cannot take back.
 *
 * Withdrawing removes a listing and every version of it. Making a plugin public
 * discloses it, and disclosure does not un-happen. So the assertions here are
 * about RESTRAINT — that neither fires from a single click, and that the
 * visibility button sends the value the label promised rather than its
 * opposite, which is the classic toggle bug and is invisible in review.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MyPluginsSection } from './MyPluginsSection';

const updateListing = jest.fn(async () => undefined);
const deletePublishedPlugin = jest.fn(async () => undefined);

jest.mock('@core/config/edition', () => ({ pluginRegistryEnabled: () => true }));
jest.mock('@core/plugins/registry', () => ({
  REGISTRY_CATEGORIES: ['utility'],
  fetchRegistryDetail: jest.fn(async () => null),
  myPublishers: jest.fn(async () => [
    { id: 'p1', namespace: 'acme', displayName: 'Acme', verified: false, verifiedDomain: null },
  ]),
  myPublishedPlugins: jest.fn(async () => [
    {
      id: 'acme.thing',
      name: 'Thing',
      description: 'A thing.',
      latestVersion: '1.0.0',
      installs: 12,
      visibility: 'public',
      permissions: [],
      apiVersion: 2,
      hasPanel: false,
      publisherKey: 'k',
      sha256: 'd',
      publisher: { namespace: 'acme', displayName: 'Acme', verified: false },
      categories: [],
      license: null,
      iconUrl: null,
      homepage: null,
      contributes: { commands: [], panels: [] },
      updatedAt: new Date().toISOString(),
    },
  ]),
  registerPublisher: jest.fn(),
  updateListing: (...a: unknown[]) => updateListing(...(a as [])),
  deletePublishedPlugin: (...a: unknown[]) => deletePublishedPlugin(...(a as [])),
}));

beforeEach(() => {
  updateListing.mockClear();
  deletePublishedPlugin.mockClear();
});

async function renderShelf() {
  await act(async () => { render(<MyPluginsSection />); });
  await screen.findByText('Thing');
}

it('shows what the plugin currently is', async () => {
  await renderShelf();
  expect(screen.getByText('Public')).toBeInTheDocument();
});

it('sends the visibility the button offered, not the current one', async () => {
  // The toggle bug: a button labelled "Make private" that sends `public`
  // reads correctly, does nothing visible on a fast reload, and is wrong.
  await renderShelf();
  fireEvent.click(screen.getByRole('button', { name: 'Make private' }));
  await waitFor(() => expect(updateListing).toHaveBeenCalled());
  expect(updateListing).toHaveBeenCalledWith('acme.thing', { visibility: 'private' });
});

it('★ never withdraws on a single click', async () => {
  await renderShelf();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
  expect(deletePublishedPlugin).not.toHaveBeenCalled();
});

it('withdraws only after the confirmation', async () => {
  await renderShelf();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw permanently' }));
  await waitFor(() => expect(deletePublishedPlugin).toHaveBeenCalledWith('acme.thing'));
});

it('offers the reversible option inside the irreversible one', async () => {
  // A publisher reaching for "withdraw" usually wants "stop offering this",
  // which is what private does — and private is undoable.
  await renderShelf();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
  expect(screen.getByText(/Make.private instead/)).toBeInTheDocument();
});

it('backs out without withdrawing', async () => {
  await renderShelf();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Withdraw permanently' })).not.toBeInTheDocument();
  expect(deletePublishedPlugin).not.toHaveBeenCalled();
});
