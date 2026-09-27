/**
 * The vaults' encryption on Electron's async safeStorage API, and the one-time
 * read of a vault the synchronous API wrote (then flagged for rewriting).
 */

const mockStorage = {
  isAsyncEncryptionAvailable: jest.fn(async () => true),
  encryptStringAsync: jest.fn(async (s: string) => Buffer.from(`async:${s}`)),
  decryptStringAsync: jest.fn(async (b: Buffer) => {
    const t = b.toString();
    if (!t.startsWith('async:')) throw new Error('not an async blob');
    return { result: t.slice('async:'.length), shouldReEncrypt: false };
  }),
  isEncryptionAvailable: jest.fn(() => true),
  decryptString: jest.fn((b: Buffer) => b.toString().replace(/^sync:/, '')),
};

jest.mock('electron', () => ({ safeStorage: mockStorage }));

import { decryptVault, encryptVault, vaultEncryptionAvailable, vaultEncryptionKnown } from './vaultCrypto';

describe('vaultCrypto', () => {
  it('encrypts and decrypts through the async API', async () => {
    const blob = await encryptVault('{"openai":"sk-test"}');
    expect(mockStorage.encryptStringAsync).toHaveBeenCalled();
    expect(await decryptVault(blob)).toEqual({ text: '{"openai":"sk-test"}', rewrite: false });
  });

  it('reads a vault the synchronous API wrote, and asks for it to be rewritten', async () => {
    expect(await decryptVault(Buffer.from('sync:{"a":1}'))).toEqual({ text: '{"a":1}', rewrite: true });
  });

  it('remembers the async answer for synchronous callers', async () => {
    mockStorage.isAsyncEncryptionAvailable.mockResolvedValueOnce(false);
    expect(await vaultEncryptionAvailable()).toBe(false);
    expect(vaultEncryptionKnown()).toBe(false);
    expect(await vaultEncryptionAvailable()).toBe(true);
    expect(vaultEncryptionKnown()).toBe(true);
  });
});
