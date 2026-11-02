/** The asset resources the server lists (premation://asset/<id>) from list_assets' answer. */

process.env.PREMATION_MCP_NO_MAIN = '1';

const { assetIdOf, assetResources } = require('./server') as typeof import('./server');

describe('asset resources', () => {
  it('maps a resource uri to the asset id and back', () => {
    expect(assetIdOf('premation://asset/asset_1')).toBe('asset_1');
    expect(assetIdOf('premation://asset/a%20b/sheet.png')).toBe('a b');
    expect(assetIdOf('file:///x')).toBeNull();
    expect(assetIdOf('premation://asset/')).toBeNull();
  });

  it('reads list_assets\' rows out of its text answer', () => {
    const text = 'Imported assets (2) — place one with create_media { assetId }:\n- a "clip.mp4" (video 1920×1080 4.0s)\n'
      + JSON.stringify({ assets: [{ id: 'a', name: 'clip.mp4', type: 'video', width: 1920, height: 1080, duration: 4 }, { id: 'b', name: 'song.mp3', type: 'audio' }] }, null, 1);
    const rows = assetResources({ content: [{ type: 'text', text }] });
    expect(rows).toEqual([
      { uri: 'premation://asset/a', name: 'clip.mp4', description: 'video 1920×1080 4.0s — read for its metadata and contact sheet; place with create_media.', mimeType: 'video/*' },
      { uri: 'premation://asset/b', name: 'song.mp3', description: 'audio — read for its metadata and contact sheet; place with create_media.', mimeType: 'audio/*' },
    ]);
    expect(assetResources({ content: [{ type: 'text', text: 'No media has been imported.' }] })).toEqual([]);
    expect(assetResources({ content: [{ type: 'text', text: 'x' }], isError: true })).toEqual([]);
  });
});
