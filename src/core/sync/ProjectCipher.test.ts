/**
 * WebCryptoCipher — real AES-GCM round-trip, guarded on WebCrypto availability
 * (jsdom has no `crypto.subtle`, so this is skipped there and runs in Electron /
 * a real browser).
 */

import { WebCryptoCipher } from './ProjectCipher';

const maybe = globalThis.crypto?.subtle ? describe : describe.skip;

maybe('WebCryptoCipher', () => {
  const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it('round-trips plaintext through encrypt/decrypt', async () => {
    const cipher = await WebCryptoCipher.fromPassphrase('correct horse battery staple', salt);
    const plain = new TextEncoder().encode('{"scene":"hello"}');
    const sealed = await cipher.encrypt(plain);
    expect(Array.from(sealed)).not.toEqual(Array.from(plain)); // actually encrypted
    const opened = await cipher.decrypt(sealed);
    expect(new TextDecoder().decode(opened)).toBe('{"scene":"hello"}');
  });

  it('a wrong passphrase cannot decrypt', async () => {
    const a = await WebCryptoCipher.fromPassphrase('right', salt);
    const b = await WebCryptoCipher.fromPassphrase('wrong', salt);
    const sealed = await a.encrypt(new TextEncoder().encode('secret'));
    await expect(b.decrypt(sealed)).rejects.toBeDefined();
  });
});
