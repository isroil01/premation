/**
 * Installing a `.pplugin` from a file (plan P2): who signed it decides what the
 * dialog says and whether "Install anyway" is needed; a tampered package is
 * refused; the install goes through the store's stage → swap; the machine-wide
 * folder is scanned and covered by the revocation list.
 */

import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import {
  bundlesIn,
  emptyState,
  machinePluginDir,
  platformKeysFor,
  readState,
  revokedInstalled,
  type PluginStoreState,
} from './nativePluginStore';
import {
  inspectPackageFile,
  installInspected,
  packagePathsIn,
  PendingPackages,
  type InspectInput,
  type StoreIdentity,
} from './pluginFileInstall';

const enc = new TextEncoder();
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function keyPair(): { publicKey: string; sign: (b: Uint8Array) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (b) => nodeSign('sha256', b, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
  };
}

/** A package as pack-plugin writes it; `key` embeds `premation-plugin.sig`. */
function pack(opts: { key?: ReturnType<typeof keyPair>; binary?: Record<string, string>; version?: string; tamperAfterSigning?: boolean } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = { 'libglow.so': enc.encode('so-bytes'), 'glow.dll': enc.encode('dll-bytes') };
  const manifest = {
    manifestVersion: 1,
    id: 'com.acme.glow',
    name: 'Glow',
    version: opts.version ?? '1.0.0',
    vendor: 'Acme',
    sdk: { major: 1, minor: 0 },
    binary: opts.binary ?? { 'linux-x64': 'libglow.so', 'windows-x64': 'glow.dll' },
    effects: [{ matchName: 'com.acme.glow', name: 'Glow', category: 'Acme' }],
    integrity: { files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)])) },
  };
  const mbytes = enc.encode(JSON.stringify(manifest));
  const entries: Record<string, Uint8Array> = { 'premation-plugin.json': mbytes, ...files };
  if (opts.key) {
    entries['premation-plugin.sig'] = enc.encode(JSON.stringify({ signature: opts.key.sign(mbytes), publicKey: opts.key.publicKey }));
  }
  if (opts.tamperAfterSigning) {
    const changed = { ...manifest, name: 'Glow (changed)' };
    entries['premation-plugin.json'] = enc.encode(JSON.stringify(changed));
  }
  return zipSync(entries);
}

const store = (key: string, verified = true): StoreIdentity => ({ publisherKey: key, publisher: { displayName: 'Acme Studio', verified } });

function input(bytes: Uint8Array, over: Partial<InspectInput> = {}): InspectInput {
  return {
    fileName: 'glow.pplugin',
    bytes,
    sidecar: null,
    state: emptyState(),
    hereKeys: platformKeysFor('linux', 'x64'),
    isRevoked: () => false,
    lookupStore: async () => null,
    ...over,
  };
}

async function preview(bytes: Uint8Array, over: Partial<InspectInput> = {}) {
  const r = await inspectPackageFile(input(bytes, over));
  if (!r.result.ok) throw new Error(r.result.reason);
  return r.result.preview;
}

describe('inspectPackageFile: who signed it', () => {
  it('a package signed with the store key of a verified publisher', async () => {
    const k = keyPair();
    const p = await preview(pack({ key: k }), { lookupStore: async () => store(k.publicKey) });
    expect(p).toMatchObject({ trust: 'store-verified', publisher: 'Acme Studio', id: 'com.acme.glow', runsHere: true, problem: null });
    expect(p.effects).toEqual([{ matchName: 'com.acme.glow', name: 'Glow', category: 'Acme' }]);
  });

  it('a store key whose publisher is not verified, and a key the store authorised as the next one', async () => {
    const k = keyPair();
    expect((await preview(pack({ key: k }), { lookupStore: async () => store(k.publicKey, false) })).trust).toBe('store');
    const next = { ...store('someone-else'), nextPublisherKey: k.publicKey };
    expect((await preview(pack({ key: k }), { lookupStore: async () => next })).trust).toBe('store-verified');
  });

  it('a key the store does not know is unknown, unless this machine already pinned it', async () => {
    const k = keyPair();
    expect((await preview(pack({ key: k }), { lookupStore: async () => store('other') })).trust).toBe('unknown');
    const state: PluginStoreState = { plugins: { 'com.acme.glow': { version: '0.9.0', publisherKey: k.publicKey, enabled: true, installedAt: 1 } }, uninstall: [] };
    const p = await preview(pack({ key: k }), { state, lookupStore: async () => 'unreachable' });
    expect(p).toMatchObject({ trust: 'pinned', installedVersion: '0.9.0', storeUnreachable: true });
  });

  it('the packer\'s detached .sig counts as a signature too', async () => {
    const k = keyPair();
    const bytes = pack();
    const sidecar = JSON.stringify({ signature: k.sign(bytes), publicKey: k.publicKey });
    expect((await preview(bytes, { sidecar, lookupStore: async () => store(k.publicKey) })).trust).toBe('store-verified');
  });

  it('no signature at all is unsigned', async () => {
    expect((await preview(pack())).trust).toBe('unsigned');
  });

  it('★ refuses a package changed after it was signed (embedded or detached)', async () => {
    const k = keyPair();
    const r = await inspectPackageFile(input(pack({ key: k, tamperAfterSigning: true })));
    // Changing the manifest breaks its own integrity first or the signature; either way, refused.
    expect(r.result.ok).toBe(false);
    const bytes = pack();
    const other = pack({ version: '2.0.0' });
    const sidecar = JSON.stringify({ signature: k.sign(other), publicKey: k.publicKey });
    const r2 = await inspectPackageFile(input(bytes, { sidecar }));
    expect(r2.result).toMatchObject({ ok: false, reason: expect.stringMatching(/does not verify/) });
  });

  it('refuses something that is not a package', async () => {
    const r = await inspectPackageFile(input(enc.encode('hello')));
    expect(r.result).toMatchObject({ ok: false, reason: expect.stringMatching(/not a Premation plugin package/) });
  });
});

describe('inspectPackageFile: problems that block the install', () => {
  it('a different key than the one pinned here', async () => {
    const k = keyPair();
    const state: PluginStoreState = { plugins: { 'com.acme.glow': { version: '1.0.0', publisherKey: 'pinned-key', enabled: true, installedAt: 1 } }, uninstall: [] };
    expect((await preview(pack({ key: k }), { state })).problem).toMatch(/different publisher key/);
    expect((await preview(pack(), { state })).problem).toMatch(/this copy is unsigned/);
  });

  it('no build for this computer', async () => {
    const p = await preview(pack({ binary: { 'windows-x64': 'glow.dll' } }));
    expect(p).toMatchObject({ runsHere: false, problem: expect.stringMatching(/no build for this computer \(it has: windows-x64\)/) });
  });

  it('revoked by the store', async () => {
    expect((await preview(pack(), { isRevoked: (id) => id === 'com.acme.glow' })).problem).toMatch(/revoked/);
  });
});

describe('installInspected', () => {
  let dir = '';
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'pfi-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function held(bytes: Uint8Array, over: Partial<InspectInput> = {}) {
    const pending = new PendingPackages();
    const r = await inspectPackageFile(input(bytes, over));
    if (!r.result.ok) throw new Error(r.result.reason);
    const p = pending.put(r.result.preview, r.unpacked!, r.key ?? '');
    return { pending, token: p.token };
  }
  const deps = () => ({ dir, platform: 'linux' as const, clearQuarantine: async () => undefined, now: () => 7 });

  it('installs a store-signed package without asking twice, pins its key, and leaves the signature member out', async () => {
    const k = keyPair();
    const { pending, token } = await held(pack({ key: k }), { lookupStore: async () => store(k.publicKey) });
    await expect(installInspected(pending, { token }, deps())).resolves.toEqual({ ok: true, id: 'com.acme.glow', version: '1.0.0', restartNeeded: false });
    expect(existsSync(path.join(dir, 'com.acme.glow', 'libglow.so'))).toBe(true);
    expect(existsSync(path.join(dir, 'com.acme.glow', 'premation-plugin.sig'))).toBe(false);
    expect((await readState(dir)).plugins['com.acme.glow']).toMatchObject({ publisherKey: k.publicKey, version: '1.0.0' });
  });

  it('★ an unknown publisher installs only with "Install anyway", and its key is pinned then', async () => {
    const k = keyPair();
    const first = await held(pack({ key: k }));
    await expect(installInspected(first.pending, { token: first.token }, deps())).resolves.toMatchObject({ ok: false, code: 'unknown-publisher' });
    // A refused token is spent; the dialog inspects again.
    const again = await held(pack({ key: k }));
    await expect(installInspected(again.pending, { token: again.token, allowUnknown: true }, deps())).resolves.toMatchObject({ ok: true });
    expect((await readState(dir)).plugins['com.acme.glow']!.publisherKey).toBe(k.publicKey);
  });

  it('a token works once, and an unknown token installs nothing', async () => {
    const k = keyPair();
    const { pending, token } = await held(pack({ key: k }), { lookupStore: async () => store(k.publicKey) });
    await installInspected(pending, { token }, deps());
    await expect(installInspected(pending, { token }, deps())).resolves.toMatchObject({ ok: false, code: 'package' });
    await expect(installInspected(pending, { token: 'nope' }, deps())).resolves.toMatchObject({ ok: false });
  });

  it('refuses a package with a blocking problem even with "Install anyway"', async () => {
    const { pending, token } = await held(pack({ binary: { 'windows-x64': 'glow.dll' } }));
    await expect(installInspected(pending, { token, allowUnknown: true }, deps())).resolves.toMatchObject({ ok: false, code: 'platform' });
  });

  it('forgets held packages after ten minutes', async () => {
    let now = 0;
    const pending = new PendingPackages(() => now);
    const r = await inspectPackageFile(input(pack()));
    if (!r.result.ok) throw new Error('inspect');
    const p = pending.put(r.result.preview, r.unpacked!, '');
    now = 11 * 60_000;
    expect(pending.take(p.token)).toBeUndefined();
  });
});

describe('the machine-wide plug-ins folder', () => {
  it('is the platform folder vendors install into', () => {
    expect(machinePluginDir('win32', { ProgramData: 'D:\\ProgramData' })).toBe('D:\\ProgramData\\Premation\\Plug-ins');
    expect(machinePluginDir('darwin')).toBe('/Library/Application Support/Premation/Plug-ins');
    expect(machinePluginDir('linux')).toBe('/usr/share/premation/plug-ins');
  });

  it('its bundles are matched by the revocation list like installed ones', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pmf-'));
    try {
      await mkdir(path.join(root, 'glow'));
      await writeFile(path.join(root, 'glow', 'premation-plugin.json'), JSON.stringify({ id: 'com.vendor.glow', version: '2.0.0' }));
      await mkdir(path.join(root, 'junk'));
      const found = await bundlesIn(root);
      expect(found).toEqual([{ id: 'com.vendor.glow', version: '2.0.0' }]);
      const hit = revokedInstalled(emptyState(), [{ id: 'com.vendor.glow', versions: ['2.0.0'], reason: 'bad' }, { id: 'com.vendor.glow', versions: ['1.0.0'], reason: 'old' }], found);
      expect(hit.map((e) => e.reason)).toEqual(['bad']);
      expect(await bundlesIn(path.join(root, 'missing'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('double-click paths', () => {
  it('finds .pplugin files in a launch argv', () => {
    expect(packagePathsIn(['C:\\Premation\\Premation.exe', '--flag', 'C:\\Users\\a\\Downloads\\glow.PPLUGIN', 'premation://oauth?code=1'])).toEqual([
      'C:\\Users\\a\\Downloads\\glow.PPLUGIN',
    ]);
  });
});

describe('scripts/pack-plugin.mjs --key', () => {
  it('★ writes a single file the installer accepts as signed, and the detached .sig the store takes', async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), 'ppk-'));
    try {
      const bundle = path.join(work, 'bundle');
      await mkdir(bundle);
      await writeFile(path.join(bundle, 'libglow.so'), 'so-bytes');
      await writeFile(path.join(bundle, 'premation-plugin.json'), JSON.stringify({
        manifestVersion: 1, id: 'com.acme.glow', version: '1.0.0', sdk: { major: 1, minor: 0 },
        binary: { 'linux-x64': 'libglow.so' }, effects: [{ matchName: 'com.acme.glow', name: 'Glow' }],
      }));
      const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const keyFile = path.join(work, 'key.json');
      const publicKey = k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      await writeFile(keyFile, JSON.stringify({ publicKey, privateKey: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') }));
      const out = path.join(work, 'glow.pplugin');
      execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'pack-plugin.mjs'), bundle, '--out', out, '--key', keyFile], { stdio: 'pipe' });

      const bytes = new Uint8Array(await readFile(out));
      const embedded = await inspectPackageFile(input(bytes, { lookupStore: async () => store(publicKey) }));
      expect(embedded.result).toMatchObject({ ok: true, preview: { trust: 'store-verified' } });
      const sidecar = await readFile(`${out}.sig`, 'utf8');
      expect(JSON.parse(sidecar)).toMatchObject({ publicKey });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
