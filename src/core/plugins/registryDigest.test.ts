/**
 * The digest check, and what it is actually for.
 *
 * `registry.test.ts` covers the signature — the real boundary, the thing that
 * survives a compromised registry. This covers the digest, which is a smaller
 * and more specific claim: **are these the bytes the registry said this version
 * was?**
 *
 * The distinction that makes it worth having is WHERE the expected value comes
 * from. The `/download` response carries a `sha256` of its own and it is
 * deliberately ignored — a digest that travels with the bytes it describes
 * cannot detect anything about them, because whatever altered one altered the
 * other. The value checked here came from the LISTING or the UPDATE OFFER: a
 * different response today, and a different ORIGIN once package bytes move to
 * object storage.
 *
 * That move is Stage 4's "when the numbers demand it". This check exists before
 * it because adding a field to a response is cheap now and is a protocol change
 * made under pressure afterwards.
 */

import { webcrypto } from 'node:crypto';

const requestMock = jest.fn();
jest.mock('@core/api/client', () => ({
  request: (...args: unknown[]) => requestMock(...args),
  apiBaseUrl: () => 'https://registry.test',
}));
jest.mock('@core/config/edition', () => ({ pluginRegistryEnabled: () => true }));

import { fetchRegistryPackage } from './registry';

beforeAll(() => {
  // jsdom has no WebCrypto, and both the digest and the signature use it.
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const PACKAGE = 'the real package bytes';

/** Hex SHA-256, computed independently of the code under test. */
async function digestOf(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const out = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(out)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A signing pair, so the signature check passes and the DIGEST is what decides
 * the outcome. Without this every test would pass for the wrong reason — the
 * signature failing first.
 */
async function signedResponse(body: string) {
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const bytes = new TextEncoder().encode(body);
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes,
  );
  const spki = await webcrypto.subtle.exportKey('spki', pair.publicKey);
  const key = Buffer.from(new Uint8Array(spki)).toString('base64');
  return {
    key,
    body: {
      package: Buffer.from(body, 'utf8').toString('base64'),
      signature: Buffer.from(new Uint8Array(signature)).toString('base64'),
      publisherKey: key,
      // What `/download` claims. Never the value that gets checked.
      sha256: 'deadbeef',
    },
  };
}

beforeEach(() => requestMock.mockReset());

describe('the digest from metadata', () => {
  it('accepts bytes matching the digest the listing gave', async () => {
    const { key, body } = await signedResponse(PACKAGE);
    requestMock.mockResolvedValue(body);

    const result = await fetchRegistryPackage('a.b', '1.0.0', key, await digestOf(PACKAGE));
    expect(new TextDecoder().decode(result.bytes)).toBe(PACKAGE);
  });

  it('★ refuses bytes that do not match, even when the signature is valid', async () => {
    // The case the check exists for: a correctly signed package that is not the
    // one the registry described — a stale CDN object, or a different version
    // served under this one's URL. The signature cannot see this, because the
    // bytes really were signed by this publisher.
    const { key, body } = await signedResponse('a DIFFERENT package');
    requestMock.mockResolvedValue(body);

    await expect(fetchRegistryPackage('a.b', '1.0.0', key, await digestOf(PACKAGE)))
      .rejects.toThrow(/not the one this version was listed as/i);
  });

  it('★ ignores the digest the download supplied', async () => {
    // `/download` says `deadbeef`. If that were what gets compared, this would
    // fail — and a check that reads its expectation from the same response as
    // the bytes is not a check at all.
    const { key, body } = await signedResponse(PACKAGE);
    requestMock.mockResolvedValue(body);

    await expect(fetchRegistryPackage('a.b', '1.0.0', key, await digestOf(PACKAGE)))
      .resolves.toBeDefined();
  });

  it('compares case-insensitively, so hex casing is not a false alarm', async () => {
    const { key, body } = await signedResponse(PACKAGE);
    requestMock.mockResolvedValue(body);

    const upper = (await digestOf(PACKAGE)).toUpperCase();
    await expect(fetchRegistryPackage('a.b', '1.0.0', key, upper)).resolves.toBeDefined();
  });

  it('falls back to the signature alone when no digest was available', async () => {
    // Not every caller has metadata to hand, and a registry older than this
    // field sends none. The install then has exactly the guarantee it had
    // before — the signature — rather than being refused.
    const { key, body } = await signedResponse(PACKAGE);
    requestMock.mockResolvedValue(body);

    await expect(fetchRegistryPackage('a.b', '1.0.0', key)).resolves.toBeDefined();
  });

  it('★ still refuses a bad signature when the digest matches', async () => {
    /*
      The direction that matters most, and the reason the digest must never be
      described as a security check.

      Here the bytes ARE what the registry described — digest correct — but they
      are signed by someone else. A registry that had been taken over could
      serve consistent metadata for a package it substituted, and the digest
      would agree with it perfectly. Only the pinned publisher key catches this.
    */
    const { body } = await signedResponse(PACKAGE);
    const other = await signedResponse('unrelated');
    requestMock.mockResolvedValue({ ...body, publisherKey: other.key });

    await expect(fetchRegistryPackage('a.b', '1.0.0', other.key, await digestOf(PACKAGE)))
      .rejects.toThrow(/does not match its signature/i);
  });
});
