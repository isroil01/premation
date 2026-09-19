/**
 * The listing's pictures, as a publisher operates them.
 *
 * The rules this pins are the ones the registry enforces, so a surface that
 * disagreed with them would offer an action and then be refused:
 *   • one icon, REPLACED rather than added to;
 *   • screenshots append, up to the ceiling, and the control disappears there
 *     rather than staying and failing;
 *   • a refused upload says what was wrong and leaves the gallery alone.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ListingMediaEditor } from './ListingMediaEditor';

const uploadPluginMedia = jest.fn(async () => ({ id: 'new', url: '/plugins/media/new' }));
const deletePluginMedia = jest.fn(async () => undefined);

jest.mock('@core/plugins/registry', () => ({
  MAX_PLUGIN_IMAGE_BYTES: 2 * 1024 * 1024,
  MAX_PLUGIN_SCREENSHOTS: 6,
  PLUGIN_IMAGE_MIME: ['image/png', 'image/jpeg', 'image/webp'],
  registryMediaUrl: (p: string | null) => (p ? `https://registry.test${p}` : null),
  uploadPluginMedia: (...a: unknown[]) => uploadPluginMedia(...(a as [])),
  deletePluginMedia: (...a: unknown[]) => deletePluginMedia(...(a as [])),
}));

const file = (name = 'a.png', type = 'image/png'): File =>
  new File([new Uint8Array(16)], name, { type });

const shots = (n: number): Array<{ id: string; url: string }> =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, url: `/plugins/media/s${i}` }));

function setup(props: Partial<React.ComponentProps<typeof ListingMediaEditor>> = {}) {
  const onChanged = jest.fn();
  const onError = jest.fn();
  const view = render(
    <ListingMediaEditor
      pluginId="acme.thing"
      iconUrl={null}
      screenshots={[]}
      onChanged={onChanged}
      onError={onError}
      {...props}
    />,
  );
  return { view, onChanged, onError };
}

beforeEach(() => {
  uploadPluginMedia.mockClear();
  uploadPluginMedia.mockResolvedValue({ id: 'new', url: '/plugins/media/new' });
  deletePluginMedia.mockClear();
});

/** Drive the hidden file input the visible button clicks through to. */
const choose = (label: string, f: File): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { files: [f] } });
};

describe('icon', () => {
  it('offers "Choose" with no icon and "Replace" with one', () => {
    const { view } = setup();
    expect(screen.getByText('Choose icon')).toBeInTheDocument();
    view.unmount();

    setup({ iconUrl: '/plugins/media/i1' });
    // One icon is a property of the plugin; "add another" has no meaning, and
    // the registry deletes the old one on upload regardless.
    expect(screen.getByText('Replace icon')).toBeInTheDocument();
    expect(screen.queryByText('Choose icon')).toBeNull();
  });

  it('uploads as the icon kind and shows the result without waiting for a refetch', async () => {
    const { onChanged } = setup();
    choose('Choose an icon image', file());
    await waitFor(() => expect(uploadPluginMedia).toHaveBeenCalledWith('acme.thing', 'icon', expect.any(File)));
    // Optimistic: an image upload that shows nothing for a second reads as one
    // that failed, so the thumbnail appears before the parent re-reads.
    await waitFor(() => {
      expect(document.querySelector('img')).toHaveAttribute('src', 'https://registry.test/plugins/media/new');
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports a refusal and leaves the slot empty', async () => {
    uploadPluginMedia.mockRejectedValueOnce(new Error('Images are limited to 2 MB.'));
    const { onError, onChanged } = setup();
    choose('Choose an icon image', file());
    await waitFor(() => expect(onError).toHaveBeenCalledWith('Images are limited to 2 MB.'));
    expect(onChanged).not.toHaveBeenCalled();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('screenshots', () => {
  it('appends rather than replacing', async () => {
    setup({ screenshots: shots(2) });
    expect(document.querySelectorAll('img')).toHaveLength(2);
    choose('Add a screenshot', file());
    await waitFor(() => expect(document.querySelectorAll('img')).toHaveLength(3));
    expect(uploadPluginMedia).toHaveBeenCalledWith('acme.thing', 'screenshot', expect.any(File));
  });

  it('withdraws the add control at the ceiling instead of offering a refused upload', () => {
    setup({ screenshots: shots(6) });
    expect(screen.queryByLabelText('Add a screenshot')).toBeNull();
    expect(screen.getByText(/That is all 6/)).toBeInTheDocument();
  });

  it('still offers it one below the ceiling', () => {
    setup({ screenshots: shots(5) });
    expect(screen.getByLabelText('Add a screenshot')).toBeInTheDocument();
  });

  it('removes one by its media id, not the plugin id', async () => {
    const { onChanged } = setup({ screenshots: shots(2) });
    fireEvent.click(screen.getAllByLabelText('Remove this screenshot')[0]!);
    await waitFor(() => expect(deletePluginMedia).toHaveBeenCalledWith('s0'));
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('the limits it states', () => {
  it('names them in the copy rather than leaving them to be discovered', () => {
    setup();
    // A publisher who learns the ceiling from a 400 has already picked a file.
    expect(screen.getByText(/up to 2 MB/)).toBeInTheDocument();
    expect(screen.getByText(/up to 6/)).toBeInTheDocument();
  });

  it('accepts only what the registry re-encodes', () => {
    setup();
    expect(screen.getByLabelText('Choose an icon image')).toHaveAttribute(
      'accept',
      'image/png,image/jpeg,image/webp',
    );
  });
});
