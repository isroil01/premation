/**
 * The native plugins folder IPC: the page can open ONE folder and learn its
 * name, never an arbitrary path, and a missing folder is created first.
 */

const handled = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('electron', () => ({ shell: { openPath: jest.fn(async () => '') } }));
jest.mock('../ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handled.set(channel, fn),
}));

import { nativePluginHandlers, registerNativePluginIpc } from './nativePlugins';

const DIR = '/userData/native-plugins';

describe('native plugins folder IPC', () => {
  beforeEach(() => handled.clear());

  it('registers both channels through the guarded handle', () => {
    registerNativePluginIpc({ dir: () => DIR, ensureDir: () => {}, openPath: async () => '' });
    expect([...handled.keys()].sort()).toEqual(['plugins:nativeFolderPath', 'plugins:openNativeFolder']);
  });

  it('creates the folder, then opens exactly that folder', async () => {
    const ensureDir = jest.fn();
    const openPath = jest.fn(async () => '');
    const h = nativePluginHandlers({ dir: () => DIR, ensureDir, openPath });
    await expect(h.openFolder()).resolves.toEqual({ ok: true, path: DIR });
    expect(ensureDir).toHaveBeenCalledWith(DIR);
    expect(openPath).toHaveBeenCalledWith(DIR);
  });

  it('ignores anything the page passes and still opens the plugins folder', async () => {
    const openPath = jest.fn(async () => '');
    registerNativePluginIpc({ dir: () => DIR, ensureDir: () => {}, openPath });
    await handled.get('plugins:openNativeFolder')!({}, 'C:\\Windows\\System32');
    expect(openPath).toHaveBeenCalledWith(DIR);
  });

  it("reports the OS's error instead of throwing", async () => {
    const h = nativePluginHandlers({ dir: () => DIR, ensureDir: () => {}, openPath: async () => 'No application' });
    await expect(h.openFolder()).resolves.toEqual({ ok: false, path: DIR, error: 'No application' });
  });

  it('reports a folder that cannot be created', async () => {
    const h = nativePluginHandlers({
      dir: () => DIR,
      ensureDir: () => { throw new Error('EACCES'); },
      openPath: async () => '',
    });
    await expect(h.openFolder()).resolves.toEqual({ ok: false, path: DIR, error: 'EACCES' });
  });

  it('answers the folder path', () => {
    registerNativePluginIpc({ dir: () => DIR, ensureDir: () => {}, openPath: async () => '' });
    expect(handled.get('plugins:nativeFolderPath')!({})).toBe(DIR);
  });
});
