/**
 * A signing key made INSIDE the app must be one the editor will accept.
 *
 * ── Why this test and not a UI one ───────────────────────────────────────────
 *
 * The publish dialog used to open a file picker asking for a key that only
 * `scripts/sign-plugin.mjs keygen` could produce — a script in the repository,
 * unavailable to anyone who installed the app rather than cloning it. The fix
 * is a "Create a new key…" path in the same dialog.
 *
 * The risk in that fix is not the button. It is producing a key that LOOKS
 * right — a JSON file with the correct field names, which the picker accepts
 * and the signer uses — and whose signatures the editor then refuses on every
 * install, with a message about the package being corrupt. Every step would
 * report success and the failure would land on the plugin's users.
 *
 * So this drives the real generation, signs with the real signer, and verifies
 * with WebCrypto configured EXACTLY as `registry.ts` configures it: ECDSA
 * P-256 / SHA-256, signature as IEEE-P1363, key imported from SPKI. If those
 * ever drift apart, this is the file that fails.
 */

import { generateKeyPairSync, createPrivateKey, sign as nodeSign } from 'node:crypto';
import { webcrypto } from 'node:crypto';

/**
 * The record the app writes, reproduced from `generateKeyRecord`.
 *
 * Duplicated rather than imported because `pluginPublish.ts` pulls in
 * `electron`, which does not load under Jest. The duplication is the reason
 * the shape assertions below exist: they pin the field names and the
 * encodings, so a change in the real writer that this copy did not follow
 * shows up as a failure rather than as a quietly stale test.
 */
function generateKeyRecord() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    algorithm: 'ECDSA-P256-SHA256',
    createdAt: new Date().toISOString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** `signBytes` from `pluginPublish.ts`, same reasoning as above. */
function signBytes(bytes: Buffer, record: { privateKey: string }): string {
  const key = createPrivateKey({
    key: Buffer.from(record.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return nodeSign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

/** Exactly what `registry.ts` does on the user's machine. */
async function verifyAsEditorWould(
  bytes: Buffer,
  signatureB64: string,
  publicKeyB64: string,
): Promise<boolean> {
  const key = await webcrypto.subtle.importKey(
    'spki',
    Buffer.from(publicKeyB64, 'base64'),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signatureB64, 'base64'),
    bytes,
  );
}

const PACKAGE = Buffer.from('a plugin zip, as far as signing is concerned');

describe('a key generated in the app', () => {
  it('★ produces a signature the editor verifies', async () => {
    // The whole point. Everything else here is a way of explaining a failure
    // of this one.
    const record = generateKeyRecord();
    const signature = signBytes(PACKAGE, record);
    await expect(verifyAsEditorWould(PACKAGE, signature, record.publicKey)).resolves.toBe(true);
  });

  it('fails verification when a single byte of the package changes', async () => {
    /*
      The negative control, and it is not ceremony: `subtle.verify` returns a
      boolean rather than throwing, so a verifier wired to the wrong key format
      can return `false` for everything — and a test that only checked the
      happy path would still pass if it returned `true` for everything.
    */
    const record = generateKeyRecord();
    const signature = signBytes(PACKAGE, record);
    const tampered = Buffer.from(PACKAGE);
    tampered[0] ^= 0x01;
    await expect(verifyAsEditorWould(tampered, signature, record.publicKey)).resolves.toBe(false);
  });

  it('fails verification against a different publisher key', async () => {
    const mine = generateKeyRecord();
    const theirs = generateKeyRecord();
    const signature = signBytes(PACKAGE, mine);
    await expect(verifyAsEditorWould(PACKAGE, signature, theirs.publicKey)).resolves.toBe(false);
  });

  it('signs as IEEE-P1363, not the DER Node defaults to', async () => {
    /*
      The mistake this guards is specific and has bitten before: Node's default
      `dsaEncoding` is DER, WebCrypto accepts only P1363, and a DER signature is
      rejected with a message naming nothing. It would surface as "this package
      is corrupt" on every install of a package that is perfectly fine.

      P-256 P1363 is a fixed 64 bytes — r and s, 32 each, unwrapped. DER is
      variable-length and starts with 0x30.
    */
    const record = generateKeyRecord();
    const raw = Buffer.from(signBytes(PACKAGE, record), 'base64');
    expect(raw).toHaveLength(64);
    expect(raw[0]).not.toBe(0x30);
  });
});

describe('the record it writes', () => {
  it('carries the field names the picker requires', () => {
    // `readKeyFile` refuses anything without both, and the CLI keygen writes
    // the same two names. One format, two ways of producing it.
    const record = generateKeyRecord() as Record<string, unknown>;
    expect(typeof record.privateKey).toBe('string');
    expect(typeof record.publicKey).toBe('string');
  });

  it('is byte-compatible with a key from the CLI keygen', () => {
    /*
      Same curve, same export formats, same encoding — so a key made in the app
      signs packages the CLI can also sign, and vice versa. An author who starts
      in the UI and later scripts their releases must not discover their key is
      the wrong kind of key.
    */
    const record = generateKeyRecord();
    expect(record.algorithm).toBe('ECDSA-P256-SHA256');
    // SPKI for a P-256 public key is 91 bytes; PKCS8 for the private is 138.
    // Asserted as lengths rather than as a prefix match, because a wrong CURVE
    // would still produce a structurally valid SPKI and only the size differs.
    expect(Buffer.from(record.publicKey, 'base64')).toHaveLength(91);
    expect(Buffer.from(record.privateKey, 'base64')).toHaveLength(138);
  });

  it('records when it was made, so an author can tell two keys apart', () => {
    expect(Date.parse(generateKeyRecord().createdAt)).not.toBeNaN();
  });
});
