/**
 * Installing native plugins from the store (nativePluginStore.ts): the checks
 * run in order and nothing reaches the plugins folder unless all pass; the
 * Windows path queues a swap for the next start; uninstall is a queue; the
 * revocation list verifies against the operator key and hits only what is
 * installed. Real packages, real signatures, a real temp folder.
 */

import { generateKeyPairSync, sign as nodeSign, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import {
  applyPendingAtStart,
  engineArgsFor,
  installPackage,
  queueUninstall,
  readState,
  revokedInstalled,
  safeEntryPath,
  verifyRevocationList,
  type DownloadRecord,
} from './nativePluginStore';

const enc = new TextEncoder();
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function keyPair(): { publicKey: string; sign: (b: Uint8Array) => string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (b) => nodeSign('sha256', b, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
  };
}

function pack(opts: { id?: string; version?: string; files?: Record<string, Uint8Array>; tamper?: (m: Record<string, unknown>) => void; extra?: Record<string, Uint8Array> } = {}): Uint8Array {
  const files = opts.files ?? { 'libglow.so': enc.encode('binary-bytes'), 'glow.dll': enc.encode('dll-bytes') };
  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    id: opts.id ?? 'com.acme.glow',
    version: opts.version ?? '1.0.0',
    sdk: { major: 1, minor: 0 },
    binary: { 'linux-x64': 'libglow.so', 'windows-x64': 'glow.dll' },
    effects: [{ matchName: 'com.acme.glow', name: 'Glow' }],
    integrity: { files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, sha(b)])) },
  };
  opts.tamper?.(manifest);
  return zipSync({ 'premation-plugin.json': enc.encode(JSON.stringify(manifest)), ...files, ...(opts.extra ?? {}) });
}

function record(bytes: Uint8Array, key: ReturnType<typeof keyPair>, over: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'com.acme.glow', version: '1.0.0', kind: 'native', packageUrl: 'https://x/y', size: bytes.byteLength,
    sha256: sha(bytes), signature: key.sign(bytes), publisherKey: key.publicKey, ...over,
  };
}

let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'nps-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const install = (bytes: Uint8Array, rec: DownloadRecord, platform: NodeJS.Platform = 'linux') =>
  installPackage({ dir, bytes, record: rec, platform, clearQuarantine: async () => undefined, now: () => 42 });

describe('installPackage', () => {
  it('verifies and installs, pinning the publisher key', async () => {
    const key = keyPair();
    const bytes = pack();
    expect(await install(bytes, record(bytes, key))).toEqual({ ok: true, id: 'com.acme.glow', version: '1.0.0', restartNeeded: false });
    expect((await readdir(path.join(dir, 'com.acme.glow'))).sort()).toEqual(['glow.dll', 'libglow.so', 'premation-plugin.json']);
    expect((await readState(dir)).plugins['com.acme.glow']).toEqual({ version: '1.0.0', publisherKey: key.publicKey, enabled: true, installedAt: 42 });
  });

  it('refuses a wrong size, hash or signature and writes nothing', async () => {
    const key = keyPair();
    const bytes = pack();
    expect(await install(bytes, record(bytes, key, { size: 3 }))).toMatchObject({ ok: false, code: 'size' });
    expect(await install(bytes, record(bytes, key, { sha256: '0'.repeat(64) }))).toMatchObject({ ok: false, code: 'hash' });
    expect(await install(bytes, record(bytes, key, { signature: keyPair().sign(bytes) }))).toMatchObject({ ok: false, code: 'signature' });
    expect(existsSync(path.join(dir, 'com.acme.glow'))).toBe(false);
  });

  it('refuses an update signed by a different key than the pinned one', async () => {
    const a = keyPair();
    const v1 = pack();
    await install(v1, record(v1, a));
    const b = keyPair();
    const v2 = pack({ version: '1.1.0' });
    expect(await install(v2, record(v2, b, { version: '1.1.0' }))).toMatchObject({ ok: false, code: 'key-changed' });
  });

  it('refuses a package whose files do not match its integrity list, an unlisted file, or a different id', async () => {
    const key = keyPair();
    const bad = pack({ tamper: (m) => { (m.integrity as { files: Record<string, string> }).files['libglow.so'] = 'f'.repeat(64); } });
    expect(await install(bad, record(bad, key))).toMatchObject({ ok: false, code: 'package', reason: expect.stringMatching(/hash/) });
    const extra = pack({ extra: { 'evil.sh': enc.encode('rm -rf') } });
    expect(await install(extra, record(extra, key))).toMatchObject({ ok: false, code: 'package', reason: expect.stringMatching(/does not list/) });
    const other = pack({ id: 'com.other.thing' });
    expect(await install(other, record(other, key))).toMatchObject({ ok: false, code: 'package' });
  });

  it('on Windows, an update over an installed copy waits for the next start, then swaps in', async () => {
    const key = keyPair();
    const v1 = pack();
    await install(v1, record(v1, key), 'win32');
    const v2files = { 'libglow.so': enc.encode('v2'), 'glow.dll': enc.encode('v2-dll') };
    const v2 = pack({ version: '2.0.0', files: v2files });
    expect(await install(v2, record(v2, key, { version: '2.0.0' }), 'win32')).toMatchObject({ ok: true, restartNeeded: true });
    expect(await readFile(path.join(dir, 'com.acme.glow', 'glow.dll'), 'utf8')).toBe('dll-bytes');
    expect((await readState(dir)).plugins['com.acme.glow']?.pending).toBe(true);
    await applyPendingAtStart(dir);
    expect(await readFile(path.join(dir, 'com.acme.glow', 'glow.dll'), 'utf8')).toBe('v2-dll');
    expect((await readState(dir)).plugins['com.acme.glow']?.pending).toBeUndefined();
  });

  it('a revoked plugin does not install', async () => {
    const key = keyPair();
    const bytes = pack();
    const r = await installPackage({ dir, bytes, record: record(bytes, key), platform: 'linux', revoked: new Set(['com.acme.glow']) });
    expect(r).toMatchObject({ ok: false, code: 'revoked' });
  });
});

describe('uninstall and start-up', () => {
  it('queues an uninstall (disabled now), removes it at the next start, and passes disabled plugins to the engine', async () => {
    const key = keyPair();
    const bytes = pack();
    await install(bytes, record(bytes, key));
    const queued = await queueUninstall(dir, 'com.acme.glow');
    expect(queued.uninstall).toEqual(['com.acme.glow']);
    expect(await engineArgsFor(dir, queued, [])).toEqual(['--entitlement', path.join(dir, 'entitlement.json'), '--plugin-disabled', 'com.acme.glow']);
    const after = await applyPendingAtStart(dir);
    expect(existsSync(path.join(dir, 'com.acme.glow'))).toBe(false);
    expect(after.plugins).toEqual({});
  });
});

describe('revocation', () => {
  it('verifies the signed list with the operator key and hits only installed versions', async () => {
    const op = keyPair();
    const payload = JSON.stringify({ seq: 3, issuedAt: '', expiresAt: '', entries: [
      { id: 'com.acme.glow', reason: 'stole projects' },
      { id: 'com.acme.warp', versions: ['0.1.0'], reason: 'crash' },
      { id: 'com.not.installed', reason: 'x' },
    ] });
    const list = verifyRevocationList({ payload, signature: op.sign(enc.encode(payload)) }, op.publicKey);
    expect(list?.seq).toBe(3);
    expect(verifyRevocationList({ payload, signature: keyPair().sign(enc.encode(payload)) }, op.publicKey)).toBeNull();
    const state = { plugins: {
      'com.acme.glow': { version: '1.0.0', publisherKey: '', enabled: true, installedAt: 0 },
      'com.acme.warp': { version: '0.2.0', publisherKey: '', enabled: true, installedAt: 0 },
    }, uninstall: [] };
    const hit = revokedInstalled(state, list!.entries);
    expect(hit.map((e) => e.id)).toEqual(['com.acme.glow']);
    const args = await engineArgsFor(dir, state, hit);
    expect(args[2]).toBe('--revoked');
    expect(JSON.parse(await readFile(args[3]!, 'utf8'))).toEqual({ revoked: [{ id: 'com.acme.glow', reason: 'stole projects' }] });
  });
});

describe('safeEntryPath', () => {
  it('accepts plain relative paths only', () => {
    expect(safeEntryPath('lib/x.so')).toBe('lib/x.so');
    for (const bad of ['../x', '/abs', 'a/../../b', 'C:/x', 'a\\b', './x', 'a//b']) expect(safeEntryPath(bad)).toBeNull();
  });
});
