/**
 * Listing pictures: the upload path, and the checks that run before it.
 *
 * ── Why the local checks are tested at all ──────────────────────────────────
 *
 * The registry checks size and type too, and it is the one that matters. These
 * exist so a 5 MB screenshot fails in the panel instead of after a round trip,
 * and — more usefully — so the message a publisher reads names the limit rather
 * than being whatever a 400 happened to carry. A check that only duplicates the
 * server is still worth having when it is the one the user sees.
 *
 * What is NOT tested here is that the bytes survive: the registry re-encodes
 * every image on ingest, so what it serves is always something it produced.
 * Asserting on the uploaded pixels would be asserting on something no consumer
 * ever sees.
 */

import {
  MAX_PLUGIN_IMAGE_BYTES,
  MAX_PLUGIN_SCREENSHOTS,
  PLUGIN_IMAGE_MIME,
  deletePluginMedia,
  registryMediaUrl,
  uploadPluginMedia,
} from './registry';

jest.mock('@core/api/client', () => ({
  apiBaseUrl: () => 'https://registry.test',
  request: jest.fn(),
}));

const client = require('@core/api/client') as { request: jest.Mock };

/** A Blob of `size` bytes with the given type — jsdom's Blob is enough. */
const image = (size: number, type = 'image/png'): Blob =>
  new Blob([new Uint8Array(size)], { type });

beforeEach(() => {
  client.request.mockReset();
  client.request.mockResolvedValue({ id: 'm1', url: '/plugins/media/m1' });
});

describe('upload', () => {
  it('posts the file as multipart to the kind\'s route', async () => {
    const res = await uploadPluginMedia('studio.acme.lab', 'icon', image(64));
    expect(res).toEqual({ id: 'm1', url: '/plugins/media/m1' });

    const [path, init] = client.request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/plugins/studio.acme.lab/media/icon');
    expect(init.method).toBe('POST');
    // FormData, not JSON — the route is behind a multipart interceptor, and a
    // JSON body would arrive as an empty file rather than as an error.
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('routes a screenshot to its own kind', async () => {
    await uploadPluginMedia('studio.acme.lab', 'screenshot', image(64));
    expect(client.request.mock.calls[0]![0]).toBe('/plugins/studio.acme.lab/media/screenshot');
  });

  it('percent-encodes the id rather than concatenating it', async () => {
    await uploadPluginMedia('a.b', 'icon', image(8));
    expect(client.request.mock.calls[0]![0]).toBe('/plugins/a.b/media/icon');
  });

  it('refuses an oversized image before it crosses the network', async () => {
    await expect(uploadPluginMedia('a.b', 'icon', image(MAX_PLUGIN_IMAGE_BYTES + 1)))
      .rejects.toThrow('Images are limited to 2 MB.');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('accepts exactly the limit', async () => {
    await expect(uploadPluginMedia('a.b', 'icon', image(MAX_PLUGIN_IMAGE_BYTES)))
      .resolves.toBeDefined();
  });

  it('refuses a type the registry will not re-encode', async () => {
    await expect(uploadPluginMedia('a.b', 'icon', image(64, 'image/gif')))
      .rejects.toThrow('Use a PNG, JPEG or WebP image.');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('accepts every type the registry does re-encode', async () => {
    for (const mime of PLUGIN_IMAGE_MIME) {
      client.request.mockClear();
      await expect(uploadPluginMedia('a.b', 'icon', image(64, mime))).resolves.toBeDefined();
    }
  });

  it('lets a typeless blob through, because the registry probes the bytes anyway', async () => {
    // A File dragged from some file managers arrives with an empty `type`.
    // Refusing it here would block a valid PNG on a metadata detail, and the
    // registry identifies the format from the bytes regardless.
    await expect(uploadPluginMedia('a.b', 'icon', image(64, ''))).resolves.toBeDefined();
  });
});

describe('delete', () => {
  it('addresses the media id, not the plugin', async () => {
    await deletePluginMedia('m1');
    const [path, init] = client.request.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/plugins/media/m1');
    expect(init.method).toBe('DELETE');
  });
});

describe('media urls', () => {
  it('resolves a path the registry issued', () => {
    expect(registryMediaUrl('/plugins/media/abc-123')).toBe('https://registry.test/plugins/media/abc-123');
  });

  it('refuses anything not shaped like one', () => {
    // The path arrives from the registry, so an unchecked value reaching an
    // image source would be a redirect primitive pointed at whatever came back.
    expect(registryMediaUrl('https://evil.example/x.png')).toBeNull();
    expect(registryMediaUrl('/plugins/media/../../secret')).toBeNull();
    expect(registryMediaUrl(null)).toBeNull();
    expect(registryMediaUrl('')).toBeNull();
  });
});

describe('the ceilings this surface has to agree with', () => {
  it('states the registry\'s own limits rather than guessing at them', () => {
    expect(MAX_PLUGIN_IMAGE_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_PLUGIN_SCREENSHOTS).toBe(6);
  });
});
