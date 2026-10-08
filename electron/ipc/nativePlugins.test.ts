/**
 * The native plugins folder IPC: the page can open ONE folder and learn its
 * name, never an arbitrary path, and a missing folder is created first.
 */

const handled = new Map<string, (...args: unknown[]) => unknown>();

jest.mock('electron', () => ({ shell: { openPath: jest.fn(async () => '') } }));
jest.mock('../ipcGuard', () => ({
  handle: (channel: string, fn: (...args: unknown[]) => unknown) => handled.set(channel, fn),
}));

import { nativePluginHandlers, registerNativePluginIpc, storeHandlers } from './nativePlugins';
import { machinePlatformKey } from '../nativePluginStore';

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

describe('store install asks for this machine\'s package', () => {
  it('maps OS and arch to the registry\'s machine keys', () => {
    expect(machinePlatformKey('win32', 'x64')).toBe('windows-x64');
    expect(machinePlatformKey('win32', 'arm64')).toBe('windows-x64');
    expect(machinePlatformKey('darwin', 'arm64')).toBe('macos-arm64');
    expect(machinePlatformKey('darwin', 'x64')).toBe('macos-x64');
    expect(machinePlatformKey('linux', 'x64')).toBe('linux-x64');
    expect(machinePlatformKey('linux', 'arm64')).toBe('linux-arm64');
  });

  it('sends ?platform= and reports the registry\'s own reason when there is no build for it', async () => {
    const body = { statusCode: 404, code: 'platform_unavailable', message: 'com.x 1.0.0 has no build for macos-arm64 (it has: windows-x64).' };
    const authedFetch = jest.fn(async () => ({ ok: false, status: 404, text: async () => JSON.stringify(body) }) as unknown as Response);
    const h = storeHandlers({ dir: () => DIR, apiBase: () => 'https://api.test/api', authedFetch, platform: 'darwin', arch: 'arm64' });
    const out = await h.install({ id: 'com.x', version: '1.0.0', owner: true });
    expect(authedFetch).toHaveBeenCalledWith('https://api.test/api/plugins/mine/com.x/versions/1.0.0/download?platform=macos-arm64', { method: 'GET' });
    expect(out).toEqual({ ok: false, code: 'package', reason: 'com.x 1.0.0 has no build for macos-arm64 (it has: windows-x64).' });
  });
});
