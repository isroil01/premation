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

interface PublishArg { bytes: Uint8Array; visibility: string }
interface PublishRes { ok: boolean; error?: string; cancelled?: boolean }

// Typed with its ARGUMENT, so `mock.calls[0][0]` is the request rather than
// `never` — the assertions below are all about what the renderer sends.
const pluginPublish = jest.fn<Promise<PublishRes>, [PublishArg]>(async () => ({ ok: true }));

beforeEach(() => {
  updateListing.mockClear();
  deletePublishedPlugin.mockClear();
  pluginPublish.mockClear();
  pluginPublish.mockResolvedValue({ ok: true });
  (window as unknown as { motionEditor?: unknown }).motionEditor = { pluginPublish };
});

afterEach(() => {
  delete (window as unknown as { motionEditor?: unknown }).motionEditor;
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

describe('publishing', () => {
  const zip = () => new File([new Uint8Array([80, 75, 3, 4])], 'p.zip', { type: 'application/zip' });

  /**
   * Attach a file to the picker.
   *
   * `fireEvent.change(input, { target: { files: [f] } })` does NOT work here: the
   * `files` property of a file input is read-only, so the assignment is dropped
   * and the change fires with an empty list. The component then sees no file, the
   * button stays disabled, and every assertion below fails on "0 calls" as if the
   * publish path were broken rather than the test.
   */
  function choose(file: File): void {
    const input = screen.getByLabelText('Package');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);
  }

  /*
    jsdom's `File` has no `arrayBuffer()`.

    Chromium does, so this is a gap in the test environment rather than in the
    component — but without the polyfill the read throws, the catch reports a
    failure, and every assertion below fails on "0 calls" as though the publish
    path were broken. Worth stating: this is the one place these tests depend on
    something the real runtime provides and jsdom does not.
  */
  beforeAll(() => {
    if (typeof File.prototype.arrayBuffer !== 'function') {
      Object.defineProperty(File.prototype, 'arrayBuffer', {
        configurable: true,
        value(this: File) {
          return Promise.resolve(new Uint8Array([80, 75, 3, 4]).buffer);
        },
      });
    }
  });

  it('★ never asks the renderer for the signing key', () => {
    /*
      The security claim, asserted as an absence.

      If a key field appears on this form, the private key is in the renderer —
      and it is the one secret whose theft cannot be undone by blocking a
      version. Main asks for the file instead. A test for the presence of
      something cannot catch this; only a test for its absence can.
    */
    render(<MyPluginsSection />);
    expect(screen.queryByLabelText(/signing key|private key/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('sends bytes and the chosen visibility, and nothing else', async () => {
    await renderShelf();
    choose(zip());
    fireEvent.click(screen.getByLabelText(/Private/));
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));

    await waitFor(() => expect(pluginPublish).toHaveBeenCalled());
    const arg = pluginPublish.mock.calls[0]![0];
    expect(arg.visibility).toBe('private');
    expect(arg.bytes).toBeInstanceOf(Uint8Array);
    expect(Object.keys(arg).sort()).toEqual(['bytes', 'visibility']);
  });

  it('defaults to public', async () => {
    await renderShelf();
    choose(zip());
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));
    await waitFor(() => expect(pluginPublish).toHaveBeenCalled());
    expect(pluginPublish.mock.calls[0]![0].visibility).toBe("public");
  });

  it('cannot publish with no package chosen', async () => {
    await renderShelf();
    expect(screen.getByRole('button', { name: /Choose signing key and publish/ })).toBeDisabled();
  });

  it('★ treats a cancelled key picker as not-an-error', async () => {
    // Cancelling is the user changing their mind. Reporting it as a failure is
    // how people learn to ignore the error line.
    pluginPublish.mockResolvedValue({ ok: false, cancelled: true, error: '' });
    await renderShelf();
    choose(zip());
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));

    await waitFor(() => expect(pluginPublish).toHaveBeenCalled());
    expect(screen.queryByText(/Sign in to publish/)).not.toBeInTheDocument();
  });

  it("surfaces the registry's own refusal", async () => {
    pluginPublish.mockResolvedValue({ ok: false, error: '"apiVersion" 9 is newer than this registry supports (4).' });
    await renderShelf();
    choose(zip());
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));

    expect(await screen.findByText(/newer than this registry supports/)).toBeInTheDocument();
  });

  it('falls back to the command line with no desktop bridge', async () => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    await renderShelf();
    expect(screen.getByText(/Publish from the command line/)).toBeInTheDocument();
  });
});

it('backs out without withdrawing', async () => {
  await renderShelf();
  fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('button', { name: 'Withdraw permanently' })).not.toBeInTheDocument();
  expect(deletePublishedPlugin).not.toHaveBeenCalled();
});
