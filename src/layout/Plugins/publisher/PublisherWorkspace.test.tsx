/**
 * The publisher workspace's safety properties.
 *
 * Inherited wholesale from `MyPluginsSection.test.tsx`, which this replaced.
 * The screen is new; the things that must not happen are not:
 *
 *  • Withdrawing is irreversible, so it must never fire from a click.
 *  • Making a listing public is a disclosure, and disclosure does not
 *    un-happen, so the visibility button must send the value its label
 *    promised. The opposite is the classic toggle bug and is invisible in
 *    review.
 *  • The renderer must never see the signing key. That is the entire basis of
 *    "this update came from the same author", and a field on this screen would
 *    defeat it.
 *  • A publish sends package bytes and a visibility. Nothing else may start
 *    travelling alongside them.
 *
 * The redesign adds one more: the confirmation is now type-to-match, so the
 * button stays disabled until the right name is typed — the guard against
 * withdrawing the wrong listing, which is the realistic version of this
 * accident.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PublisherWorkspace } from './PublisherWorkspace';

const updateListing = jest.fn(async () => undefined);
const deletePublishedPlugin = jest.fn(async () => undefined);
const registerPublisher = jest.fn(async () => ({
  id: 'p1',
  namespace: 'acme',
  displayName: 'Acme',
  verified: false,
  verifiedDomain: null,
}));

let publishers = [{ id: 'p1', namespace: 'acme', displayName: 'Acme', verified: false, verifiedDomain: null }];

const plugin = {
  id: 'acme.thing',
  name: 'Thing',
  description: 'A thing.',
  latestVersion: '1.0.0',
  installs: 12,
  visibility: 'public' as const,
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
};

jest.mock('@core/config/edition', () => ({ pluginRegistryEnabled: () => true }));
jest.mock('@core/plugins/registry', () => ({
  REGISTRY_CATEGORIES: ['utility'],
  fetchRegistryDetail: jest.fn(async () => null),
  myPublishers: jest.fn(async () => publishers),
  myPublishedPlugins: jest.fn(async () => [plugin]),
  registerPublisher: (...a: unknown[]) => registerPublisher(...(a as [])),
  updateListing: (...a: unknown[]) => updateListing(...(a as [])),
  deletePublishedPlugin: (...a: unknown[]) => deletePublishedPlugin(...(a as [])),
  uploadPluginMedia: jest.fn(async () => ({ id: 'm1', url: '/plugins/media/m1' })),
  deletePluginMedia: jest.fn(async () => undefined),
  registryMediaUrl: (p: string | null) => p,
  MAX_PLUGIN_IMAGE_BYTES: 2 * 1024 * 1024,
  MAX_PLUGIN_SCREENSHOTS: 6,
  PLUGIN_IMAGE_MIME: ['image/png'],
}));

/** Render and wait for the shelf's first load to settle. */
async function open(): Promise<void> {
  render(<PublisherWorkspace />);
  await screen.findByText('acme');
}

/** Open the listing in the detail pane. */
async function selectListing(): Promise<void> {
  await open();
  fireEvent.click(screen.getByRole('button', { name: /Thing/ }));
  await screen.findByRole('heading', { name: 'Thing' });
}

beforeEach(() => {
  jest.clearAllMocks();
  publishers = [{ id: 'p1', namespace: 'acme', displayName: 'Acme', verified: false, verifiedDomain: null }];
});

describe('the listing', () => {
  it('shows what the plugin currently is', async () => {
    await selectListing();
    expect(screen.getByText('Public')).toBeInTheDocument();
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
  });

  it('sends the visibility the button offered, not the current one', async () => {
    await selectListing();
    fireEvent.click(screen.getByRole('button', { name: 'Make private' }));
    await waitFor(() => expect(updateListing).toHaveBeenCalled());
    expect(updateListing).toHaveBeenCalledWith('acme.thing', { visibility: 'private' });
  });
});

describe('withdrawing', () => {
  it('★ never withdraws on a single click', async () => {
    await selectListing();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
    expect(deletePublishedPlugin).not.toHaveBeenCalled();
  });

  it('★ stays disabled until the listing name is typed exactly', async () => {
    await selectListing();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));

    const confirm = await screen.findByRole('button', { name: 'Withdraw permanently' });
    expect(confirm).toBeDisabled();

    // The namespace is not the phrase; only the name after the dot is.
    fireEvent.change(screen.getByLabelText(/Type thing to confirm/), { target: { value: 'acme.thing' } });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type thing to confirm/), { target: { value: 'thing' } });
    expect(confirm).toBeEnabled();
  });

  it('withdraws only after the confirmation', async () => {
    await selectListing();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
    fireEvent.change(await screen.findByLabelText(/Type thing to confirm/), { target: { value: 'thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw permanently' }));
    await waitFor(() => expect(deletePublishedPlugin).toHaveBeenCalledWith('acme.thing'));
  });

  it('offers the reversible option inside the irreversible one, as an action', async () => {
    await selectListing();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));

    const instead = await screen.findByRole('button', { name: 'Make private instead' });
    fireEvent.click(instead);
    await waitFor(() => expect(updateListing).toHaveBeenCalledWith('acme.thing', { visibility: 'private' }));
    expect(deletePublishedPlugin).not.toHaveBeenCalled();
  });

  it('backs out without withdrawing', async () => {
    await selectListing();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Withdraw permanently' })).not.toBeInTheDocument(),
    );
    expect(deletePublishedPlugin).not.toHaveBeenCalled();
  });
});

describe('claiming a namespace', () => {
  beforeEach(() => {
    publishers = [];
  });

  it('refuses a namespace the registry would reject, before sending it', async () => {
    render(<PublisherWorkspace />);
    const field = await screen.findByLabelText('Namespace');

    fireEvent.change(field, { target: { value: 'Acme Corp' } });
    fireEvent.blur(field);
    expect(screen.getByText('No spaces — use a hyphen.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim/ })).toBeDisabled();
  });

  it('lower-cases the claim and sends both fields', async () => {
    render(<PublisherWorkspace />);
    fireEvent.change(await screen.findByLabelText('Namespace'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Acme Studio' } });
    fireEvent.click(screen.getByRole('button', { name: /Claim/ }));
    await waitFor(() => expect(registerPublisher).toHaveBeenCalledWith('acme', 'Acme Studio'));
  });

  it('shows the id the namespace will produce', async () => {
    render(<PublisherWorkspace />);
    fireEvent.change(await screen.findByLabelText('Namespace'), { target: { value: 'acme' } });
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('.easing-lab')).toBeInTheDocument();
  });
});

describe('publishing', () => {
  type PublishRequest = { bytes: Uint8Array; visibility: string };
  type PublishResult = { ok: boolean; error?: string; cancelled?: boolean };
  const pluginPublish = jest.fn<Promise<PublishResult>, [PublishRequest]>(async () => ({ ok: true }));

  beforeEach(() => {
    (window as unknown as { motionEditor: unknown }).motionEditor = { pluginPublish };
    pluginPublish.mockClear();
  });

  afterEach(() => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
  });

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

  /**
   * Attach a file to the picker.
   *
   * `fireEvent.change(input, { target: { files: [f] } })` does NOT work here:
   * the `files` property of a file input is read-only, so the assignment is
   * dropped and the change fires with an empty list. The component then sees no
   * file, the button stays disabled, and every assertion below fails on
   * "0 calls" as if the publish path were broken rather than the test.
   */
  const choosePackage = async (): Promise<void> => {
    await open();
    const file = new File([new Uint8Array([80, 75, 3, 4])], 'p.zip', { type: 'application/zip' });
    const input = screen.getByLabelText('Package');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => {
      fireEvent.change(input);
    });
  };

  it('★ never asks the renderer for the signing key', async () => {
    await open();
    expect(screen.queryByLabelText(/signing key|private key/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('sends bytes and the chosen visibility, and nothing else', async () => {
    await choosePackage();
    fireEvent.click(screen.getByLabelText('Private listing'));
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));
    await waitFor(() => expect(pluginPublish).toHaveBeenCalled());

    const arg = pluginPublish.mock.calls[0]![0];
    expect(arg.visibility).toBe('private');
    expect(arg.bytes).toBeInstanceOf(Uint8Array);
    expect(Object.keys(arg).sort()).toEqual(['bytes', 'visibility']);
  });

  it('defaults to public', async () => {
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));
    await waitFor(() => expect(pluginPublish).toHaveBeenCalled());
    expect(pluginPublish.mock.calls[0]![0].visibility).toBe('public');
  });

  it('cannot publish with no package chosen', async () => {
    await open();
    expect(screen.getByRole('button', { name: /Choose signing key and publish/ })).toBeDisabled();
  });

  it('★ treats a cancelled key picker as not-an-error', async () => {
    pluginPublish.mockResolvedValueOnce({ ok: false, cancelled: true });
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));
    await waitFor(() => expect(pluginPublish).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("surfaces the registry's own refusal", async () => {
    pluginPublish.mockResolvedValueOnce({
      ok: false,
      error: 'Package API version is newer than this registry supports.',
    });
    await choosePackage();
    fireEvent.click(screen.getByRole('button', { name: /Choose signing key and publish/ }));
    expect(await screen.findByText(/newer than this registry supports/)).toBeInTheDocument();
  });

  it('falls back to the command line with no desktop bridge', async () => {
    delete (window as unknown as { motionEditor?: unknown }).motionEditor;
    await open();
    expect(screen.getByText(/Publish from the command line/)).toBeInTheDocument();
  });
});
