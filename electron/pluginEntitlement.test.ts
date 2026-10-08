/**
 * The Premation Cloud entitlement token in main (plan §3.2): verified with the
 * pinned operator key before it is kept for the engine; a plan without
 * Premation plugins keeps the token it already has (it runs to its own end);
 * sign-out drops it; offline changes nothing.
 */

import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('electron', () => ({ shell: { openPath: jest.fn() } }));
jest.mock('./ipcGuard', () => ({ handle: jest.fn() }));

import { ENTITLEMENT_FILE, readEntitlement, verifyEntitlement, writeEntitlement } from './nativePluginStore';
import { exportPluginJob, forgetEntitlement, refreshEntitlement } from './ipc/nativePlugins';

const op = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (s: string) => nodeSign('sha256', Buffer.from(s), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64'),
  };
})();

const payload = JSON.stringify({ v: 1, userId: 'u1', plan: 'pro', validUntil: '2026-11-15T00:00:00.000Z', issuedAt: '2026-10-08T00:00:00.000Z' });

let dir = '';
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'pent-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('verifyEntitlement', () => {
  it('reads a token signed by the operator key', () => {
    expect(verifyEntitlement({ payload, signature: op.sign(payload) }, op.publicKey)).toEqual({
      plan: 'pro', userId: 'u1', validUntil: Date.parse('2026-11-15T00:00:00.000Z'),
    });
  });

  it('★ refuses a forged or edited token', () => {
    const edited = payload.replace('2026-11-15', '2099-11-15');
    expect(verifyEntitlement({ payload: edited, signature: op.sign(payload) }, op.publicKey)).toBeNull();
    // Signed with the real key? Not this one: the pinned production key does not verify a test signature.
    expect(verifyEntitlement({ payload, signature: op.sign(payload) })).toBeNull();
    expect(verifyEntitlement(null, op.publicKey)).toBeNull();
  });

  it('writes only a token that verifies, and reads it back', async () => {
    expect(await writeEntitlement(dir, { payload, signature: 'bogus' }, op.publicKey)).toBeNull();
    expect(existsSync(path.join(dir, ENTITLEMENT_FILE))).toBe(false);
    await writeEntitlement(dir, { payload, signature: op.sign(payload) }, op.publicKey);
    expect((await readEntitlement(dir, op.publicKey))?.plan).toBe('pro');
  });
});

describe('refreshEntitlement', () => {
  const answer = (status: number, body: unknown) => jest.fn(async () => ({ ok: status < 400, status, json: async () => body }) as unknown as Response);

  it('keeps nothing it cannot verify (the production key does not verify a test token)', async () => {
    const authedFetch = answer(200, { plan: 'pro', token: { payload, signature: op.sign(payload) } });
    const out = await refreshEntitlement({ dir: () => dir, apiBase: () => 'https://api.test/api', authedFetch }, { force: true });
    expect(authedFetch).toHaveBeenCalledWith('https://api.test/api/plugins/entitlement', expect.objectContaining({ method: 'GET' }));
    expect(out).toEqual({ plan: 'pro', validUntil: null });
    expect(existsSync(path.join(dir, ENTITLEMENT_FILE))).toBe(false);
  });

  it('a free plan, an error or offline keep the existing token and touch nothing', async () => {
    await writeEntitlement(dir, { payload, signature: op.sign(payload) }, op.publicKey);
    const deps = (authedFetch: jest.Mock) => ({ dir: () => dir, apiBase: () => 'https://api.test/api', authedFetch });
    await refreshEntitlement(deps(answer(200, { plan: 'free', token: null })), { force: true });
    await refreshEntitlement(deps(answer(500, {})), { force: true });
    await refreshEntitlement(deps(jest.fn(async () => { throw new Error('offline'); })), { force: true });
    expect(existsSync(path.join(dir, ENTITLEMENT_FILE))).toBe(true);
  });

  it('asks at most every ten minutes unless forced', async () => {
    const authedFetch = answer(200, { plan: 'free', token: null });
    const deps = { dir: () => dir, apiBase: () => 'https://api.test/api', authedFetch };
    await refreshEntitlement(deps, { force: true, now: () => 1_000_000 });
    await refreshEntitlement(deps, { now: () => 1_000_000 + 60_000 });
    expect(authedFetch).toHaveBeenCalledTimes(1);
    await refreshEntitlement(deps, { now: () => 1_000_000 + 11 * 60_000 });
    expect(authedFetch).toHaveBeenCalledTimes(2);
  });

  it('sign-out drops the token; export jobs carry its path', async () => {
    await writeEntitlement(dir, { payload, signature: op.sign(payload) }, op.publicKey);
    expect((await exportPluginJob({ dir: () => dir })).pluginEntitlement).toBe(path.join(dir, ENTITLEMENT_FILE));
    await forgetEntitlement({ dir: () => dir });
    expect(existsSync(path.join(dir, ENTITLEMENT_FILE))).toBe(false);
  });
});
