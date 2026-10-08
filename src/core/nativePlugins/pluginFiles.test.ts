/**
 * The install-from-file dialog's wording: who signed the package, and whether
 * installing needs the explicit "Install anyway".
 */

import { accessLine, trustLine } from './pluginFiles';
import type { NativePluginPackagePreview } from '@/types/motionEditor';

const base: NativePluginPackagePreview = {
  token: 't',
  fileName: 'glow.pplugin',
  id: 'com.acme.glow',
  name: 'Glow',
  version: '1.0.0',
  vendor: 'Acme',
  sdk: '1.0',
  effects: [{ matchName: 'com.acme.glow', name: 'Glow', category: 'Acme' }],
  platforms: ['linux-x64'],
  runsHere: true,
  trust: 'store-verified',
  publisher: 'Acme Studio',
  entitlement: null,
  installedVersion: null,
  problem: null,
  storeUnreachable: false,
};

describe('trustLine', () => {
  it('a store publisher installs with a plain Install', () => {
    expect(trustLine(base)).toMatchObject({ label: 'Verified publisher: Acme Studio', tone: 'ok', needsAnyway: false });
    expect(trustLine({ ...base, trust: 'store' })).toMatchObject({ label: 'Store publisher: Acme Studio', needsAnyway: false });
    expect(trustLine({ ...base, trust: 'pinned' }).needsAnyway).toBe(false);
  });

  it('★ unknown and unsigned packages need "Install anyway"', () => {
    expect(trustLine({ ...base, trust: 'unknown' })).toMatchObject({ label: 'Unknown publisher (says it is from Acme)', tone: 'warn', needsAnyway: true });
    expect(trustLine({ ...base, trust: 'unknown', storeUnreachable: true }).detail).toMatch(/could not be reached/);
    expect(trustLine({ ...base, trust: 'unsigned' })).toMatchObject({ label: 'Unsigned', needsAnyway: true });
  });
});

describe('accessLine', () => {
  it('says plainly that native code is not sandboxed', () => {
    expect(accessLine(base)).toBe('Adds 1 effect (Glow). It runs as native code inside the Premation engine, with the same access to your computer as Premation itself.');
    expect(accessLine({ ...base, effects: [...base.effects, { matchName: 'com.acme.glow.b', name: 'B', category: '' }] })).toMatch(/^Adds 2 effects\./);
  });
});
