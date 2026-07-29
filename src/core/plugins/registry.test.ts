/**
 * Client-side signature verification.
 *
 * This is the check that matters. The backend verifies at publish time, which
 * protects the registry's own contents; THIS one runs on the user's machine
 * over the exact bytes about to be installed, and it is the only thing standing
 * between a compromised server — or a proxy, or a modified download — and code
 * running in the editor.
 *
 * A verifier that wrongly returns true is indistinguishable from a working one
 * until the day it matters, so these tests are mostly about the false-accept
 * cases: wrong key, tampered bytes, wrong encoding, and the "no signature at
 * all" shapes an attacker would try first.
 */

import { webcrypto } from 'node:crypto';
import { verifyPackageSignature } from './registry';

// jsdom has no WebCrypto; the code under test uses the standard API, so Node's
// implementation of that same API is the honest stand-in.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

/** Backed by a plain ArrayBuffer — WebCrypto will not take a view over a
 *  SharedArrayBuffer, and `TextEncoder` alone does not promise one. */
const enc = (s: string): Uint8Array<ArrayBuffer> => {
  const src = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
};
const b64 = (b: ArrayBuffer): string => Buffer.from(new Uint8Array(b)).toString('base64');

async function keypair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  return {
    pub: b64(await crypto.subtle.exportKey('spki', pair.publicKey)),
    priv: pair.privateKey,
  };
}

async function sign(bytes: Uint8Array, priv: CryptoKey): Promise<string> {
  const data = new Uint8Array(bytes);
  return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, data));
}

describe('verifying a downloaded package', () => {
  const bytes = enc('PK pretend this is a plugin zip');

  it('accepts a package signed by the expected key', async () => {
    const { pub, priv } = await keypair();
    expect(await verifyPackageSignature(bytes, await sign(bytes, priv), pub)).toBe(true);
  });

  it('rejects a package signed by a different key', async () => {
    // The impersonation case: someone serves their own package for a plugin id
    // the user already trusts. The pin is the stored key, so this must fail.
    const author = await keypair();
    const attacker = await keypair();
    const sig = await sign(bytes, attacker.priv);
    expect(await verifyPackageSignature(bytes, sig, author.pub)).toBe(false);
  });

  it('rejects a package modified after signing, down to one byte', async () => {
    const { pub, priv } = await keypair();
    const sig = await sign(bytes, priv);
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(await verifyPackageSignature(tampered, sig, pub)).toBe(false);
  });

  it('rejects an empty or truncated signature instead of treating it as absent', async () => {
    const { pub } = await keypair();
    expect(await verifyPackageSignature(bytes, '', pub)).toBe(false);
    expect(await verifyPackageSignature(bytes, 'AAAA', pub)).toBe(false);
  });

  it('rejects a signature of the wrong length before asking WebCrypto', async () => {
    // P-256 r||s is exactly 64 bytes. A DER signature (what Node produces by
    // default) is ~70 and must not be quietly accepted by some other path.
    const { pub } = await keypair();
    const wrongLength = Buffer.alloc(70, 7).toString('base64');
    expect(await verifyPackageSignature(bytes, wrongLength, pub)).toBe(false);
  });

  it('returns false rather than throwing on a malformed key', async () => {
    // The response is attacker-controlled; an exception here would be an
    // unhandled rejection in the install path rather than a refusal.
    expect(await verifyPackageSignature(bytes, 'AAAA', 'not-a-key')).toBe(false);
    expect(await verifyPackageSignature(bytes, 'AAAA', '')).toBe(false);
  });

  it('does not accept a signature over DIFFERENT bytes', async () => {
    // Signing something adjacent — the manifest, a hash — and presenting it as
    // a package signature is the subtle version of the tampering case.
    const { pub, priv } = await keypair();
    const sig = await sign(enc('some other content entirely'), priv);
    expect(await verifyPackageSignature(bytes, sig, pub)).toBe(false);
  });

  it('verifies a package of realistic size', async () => {
    const { pub, priv } = await keypair();
    const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 251);
    expect(await verifyPackageSignature(big, await sign(big, priv), pub)).toBe(true);
  });
});

/**
 * The cross-implementation seam, and the one most likely to break silently.
 *
 * The publisher signs with Node (`scripts/sign-plugin.mjs`); the editor verifies
 * with WebCrypto. Every other test in this file signs and verifies with the same
 * implementation, so all of them would still pass if the two disagreed about
 * encoding — and publishing would look fine right up until nobody could install
 * anything.
 */
describe('signatures made by the publishing CLI', () => {
  const bytes = enc('a package, signed the way the CLI signs it');

  it('verify in the editor', () => {
    const { generateKeyPairSync, sign: nodeSign } = require('node:crypto') as typeof import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const sig = nodeSign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');

    return expect(verifyPackageSignature(bytes, sig, spki)).resolves.toBe(true);
  });

  it('do NOT verify if the CLI ever switches to Node s default DER encoding', () => {
    // Guards the exact regression: dropping `dsaEncoding` from the CLI produces
    // a signature the backend would also accept if IT were sloppy, and that the
    // editor can never accept. Better to fail loudly here than in the field.
    const { generateKeyPairSync, sign: nodeSign } = require('node:crypto') as typeof import('node:crypto');
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

    const spki = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const der = nodeSign('sha256', bytes, { key: privateKey }).toString('base64');

    return expect(verifyPackageSignature(bytes, der, spki)).resolves.toBe(false);
  });
});
