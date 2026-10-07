/**
 * The page side of the plugin store: main installs, the engine rescans, and
 * the version / platform helpers the store UI decides with.
 */

import { compareVersions, installFromStore, platformKeysHere, runsHere } from './pluginStore';

afterEach(() => { delete (window as { motionEditor?: unknown }).motionEditor; });

describe('installFromStore', () => {
  it('installs through main, then rescans the engine and says whether the plugin loaded', async () => {
    const install = jest.fn(async () => ({ ok: true, id: 'com.acme.glow', version: '1.0.0', restartNeeded: false }));
    (window as { motionEditor?: unknown }).motionEditor = { plugins: { install, installed: jest.fn() } };
    const execute = jest.fn(async () => ({ ok: true, value: { plugins: [{ id: 'com.acme.glow', status: 'loaded', error: '' }] } }));
    const r = await installFromStore({ execute } as never, { id: 'com.acme.glow', version: '1.0.0' });
    expect(install).toHaveBeenCalledWith({ id: 'com.acme.glow', version: '1.0.0' });
    expect(execute).toHaveBeenCalledWith({ type: 'rescanPlugins' });
    expect(r).toMatchObject({ ok: true, restartNeeded: false });
    expect(r.message).toMatch(/Effects panel/);
  });

  it('does not rescan when the new version waits for a restart, and passes main refusals through', async () => {
    const install = jest.fn()
      .mockResolvedValueOnce({ ok: true, id: 'a.b', version: '2.0.0', restartNeeded: true })
      .mockResolvedValueOnce({ ok: false, code: 'signature', reason: 'The publisher signature does not verify.' });
    (window as { motionEditor?: unknown }).motionEditor = { plugins: { install, installed: jest.fn() } };
    const execute = jest.fn();
    expect(await installFromStore({ execute } as never, { id: 'a.b', version: '2.0.0' })).toMatchObject({ ok: true, restartNeeded: true });
    expect(execute).not.toHaveBeenCalled();
    expect(await installFromStore({ execute } as never, { id: 'a.b', version: '2.0.0' })).toEqual({ ok: false, message: 'The publisher signature does not verify.' });
  });

  it('outside the desktop app it says so', async () => {
    expect(await installFromStore({ execute: jest.fn() } as never, { id: 'a.b', version: '1' })).toMatchObject({ ok: false });
  });
});

describe('helpers', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('0.9.0', '1.0.0')).toBe(-1);
  });

  it('knows which binaries this machine loads', () => {
    expect(platformKeysHere('darwin', 'arm64')).toEqual(['macos-arm64', 'macos-universal', 'macos']);
    expect(platformKeysHere('win32', 'x64')).toEqual(['windows-x64', 'windows']);
    expect(runsHere(['macos-universal'], platformKeysHere('darwin', 'x64'))).toBe(true);
    expect(runsHere(['windows-x64'], platformKeysHere('linux', 'x64'))).toBe(false);
  });
});
