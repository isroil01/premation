/**
 * ProjectCipher — client-side encryption for the opt-in sync vault (RFC §10.1).
 *
 * This is what keeps principle #6 true: the server stores only ciphertext it
 * cannot read. The project key is derived from the user's passphrase on-device
 * (PBKDF2 → AES-GCM, all Web Crypto, no dependencies) and NEVER leaves. Each
 * chunk is sealed independently; the 12-byte random IV is prepended to the
 * ciphertext so decrypt is self-describing.
 *
 * The `ProjectCipher` port is injectable so the sync engine can be tested with a
 * trivial fake; `WebCryptoCipher` is the real implementation.
 */

export interface ProjectCipher {
  encrypt(plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(sealed: Uint8Array): Promise<Uint8Array>;
}

const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 210_000; // OWASP-current floor for PBKDF2-SHA256

/** AES-256-GCM cipher with a passphrase-derived key. */
export class WebCryptoCipher implements ProjectCipher {
  private constructor(private readonly key: CryptoKey) {}

  /**
   * Derive a project cipher from a passphrase + a per-project salt (store the
   * salt with the project, NOT the passphrase). The passphrase never leaves the
   * device and the key is non-extractable.
   */
  static async fromPassphrase(passphrase: string, salt: Uint8Array): Promise<WebCryptoCipher> {
    const subtle = subtleOrThrow();
    const material = await subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const key = await subtle.deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return new WebCryptoCipher(key);
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const subtle = subtleOrThrow();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ct = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv: iv as any }, this.key, plaintext as any),
    );
    const out = new Uint8Array(IV_BYTES + ct.length);
    out.set(iv, 0);
    out.set(ct, IV_BYTES);
    return out;
  }

  async decrypt(sealed: Uint8Array): Promise<Uint8Array> {
    const subtle = subtleOrThrow();
    const iv = sealed.subarray(0, IV_BYTES);
    const ct = sealed.subarray(IV_BYTES);
    return new Uint8Array(
      await subtle.decrypt({ name: 'AES-GCM', iv: iv as any }, this.key, ct as any),
    );
  }
}

function subtleOrThrow(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCryptoCipher: WebCrypto subtle unavailable');
  return subtle;
}
