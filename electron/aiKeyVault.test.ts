/**
 * The vault's security claim, asserted rather than described.
 *
 * The claim is: a compromised renderer can SPEND the user's provider key but
 * cannot READ it. That rests entirely on the IPC surface having no read verb — so
 * that is what this file checks. A future `aiKeys:get` added for convenience
 * (debugging, a "reveal key" button, a settings export) would quietly undo the
 * whole design, and this test is the thing that objects.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
let encryptionAvailable = true;

jest.mock('electron', () => ({
  app: { getPath: () => '/tmp/motion-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}));

// An in-memory disk, so nothing here touches the real filesystem.
const disk = new Map<string, Buffer>();
jest.mock('node:fs/promises', () => ({
  readFile: async (p: string) => {
    const found = disk.get(p);
    if (!found) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return found;
  },
  writeFile: async (p: string, data: Buffer) => void disk.set(p, Buffer.from(data)),
  rename: async (from: string, to: string) => {
    const v = disk.get(from);
    if (v) {
      disk.set(to, v);
      disk.delete(from);
    }
  },
  unlink: async (p: string) => void disk.delete(p),
  chmod: async () => undefined,
}));

import path from 'node:path';
import { registerAiKeyIpc, maskKey, keyStatuses, getKeyForProvider, resetVaultCacheForTests } from './aiKeyVault';

/**
 * Built with `path.join`, not written as a literal — the module under test uses
 * `path.join`, so on Windows a hardcoded '/tmp/x/y' silently fails to match the
 * backslash-separated key the vault actually writes.
 */
const VAULT_FILE = path.join('/tmp/motion-test', 'ai-keys.bin');

const invoke = (channel: string, ...args: unknown[]): unknown => {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler for ${channel}`);
  return fn({}, ...args);
};

beforeEach(() => {
  handlers.clear();
  disk.clear();
  encryptionAvailable = true;
  resetVaultCacheForTests();
  registerAiKeyIpc();
});

describe('the IPC surface is write-only', () => {
  it('exposes exactly four channels, none of which reads a key', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'aiKeys:available',
      'aiKeys:clear',
      'aiKeys:set',
      'aiKeys:status',
    ]);
  });

  it('has no channel whose name suggests reading one', () => {
    // Deliberately broad. The point is not the exact names — it is that nothing
    // reachable from the renderer returns key material.
    for (const channel of handlers.keys()) {
      expect(channel).not.toMatch(/get|read|reveal|export|dump/i);
    }
  });

  it('never returns key material from any channel', async () => {
    const secret = 'sk-super-secret-value-1234';
    await invoke('aiKeys:set', 'openai', secret);

    for (const channel of handlers.keys()) {
      const result = await invoke(channel, 'openai');
      expect(JSON.stringify(result ?? null)).not.toContain(secret);
    }
  });
});

describe('aiKeys:set', () => {
  it('stores a key and reports only its masked tail', async () => {
    const res = (await invoke('aiKeys:set', 'openai', 'sk-abcdefghijkl4f2a')) as {
      persisted: boolean;
      hint: string;
    };
    expect(res.persisted).toBe(true);
    expect(res.hint).toBe('sk-…4f2a');

    const status = (await invoke('aiKeys:status')) as Record<string, { present: boolean }>;
    expect(status.openai.present).toBe(true);
    expect(status.anthropic.present).toBe(false);
  });

  it('encrypts what it writes — the file never holds the plaintext', async () => {
    await invoke('aiKeys:set', 'openai', 'sk-plaintext-must-not-appear');
    const written = [...disk.values()].map((b) => b.toString()).join('');
    expect(written).toContain('enc:');
    // With the real safeStorage this is ciphertext; the stub only proves the key
    // goes through the encrypt path rather than straight to disk.
    expect(written.startsWith('enc:')).toBe(true);
  });

  it('refuses a provider it cannot proxy', async () => {
    // An entry no proxy can spend would show as a connected provider that never
    // works — worse than refusing it.
    const res = (await invoke('aiKeys:set', 'mistral', 'sk-whatever-1234')) as { persisted: boolean };
    expect(res.persisted).toBe(false);
    expect(await getKeyForProvider('openai')).toBeNull();
  });

  it('bounds the input', async () => {
    for (const bad of ['short', 'x'.repeat(513), 42, null, undefined]) {
      const res = (await invoke('aiKeys:set', 'openai', bad)) as { persisted: boolean };
      expect(res.persisted).toBe(false);
    }
  });

  it('keeps other providers when one is replaced', async () => {
    await invoke('aiKeys:set', 'openai', 'sk-openai-key-aaaa');
    await invoke('aiKeys:set', 'gemini', 'gm-gemini-key-bbbb');
    await invoke('aiKeys:set', 'openai', 'sk-openai-new-cccc');

    expect(await getKeyForProvider('gemini')).toBe('gm-gemini-key-bbbb');
    expect(await getKeyForProvider('openai')).toBe('sk-openai-new-cccc');
  });
});

describe('aiKeys:clear', () => {
  it('forgets one provider without touching the others', async () => {
    await invoke('aiKeys:set', 'openai', 'sk-openai-key-aaaa');
    await invoke('aiKeys:set', 'gemini', 'gm-gemini-key-bbbb');

    await invoke('aiKeys:clear', 'openai');
    expect(await getKeyForProvider('openai')).toBeNull();
    expect(await getKeyForProvider('gemini')).toBe('gm-gemini-key-bbbb');
  });

  it('forgets everything and deletes the file when passed nothing', async () => {
    await invoke('aiKeys:set', 'openai', 'sk-openai-key-aaaa');
    await invoke('aiKeys:clear', null);

    // An encrypted empty object would keep an OS-keystore entry alive for data
    // the user explicitly removed.
    expect(disk.size).toBe(0);
    const status = (await invoke('aiKeys:status')) as Record<string, { present: boolean }>;
    expect(Object.values(status).every((s) => !s.present)).toBe(true);
  });
});

describe('without an OS keystore', () => {
  it('stores nothing rather than writing plaintext', async () => {
    encryptionAvailable = false;
    const res = (await invoke('aiKeys:set', 'openai', 'sk-would-be-plaintext')) as {
      persisted: boolean;
    };
    // The honest failure: the user re-enters the key each launch. A plaintext
    // fallback would look identical and protect nothing.
    expect(res.persisted).toBe(false);
    expect(disk.size).toBe(0);
    expect(await invoke('aiKeys:available')).toBe(false);
  });
});

describe('reading a vault written by another build', () => {
  it('drops entries for providers it cannot proxy', async () => {
    disk.set(
      VAULT_FILE,
      Buffer.from(`enc:${JSON.stringify({ openai: 'sk-good-key-aaaa', mistral: 'sk-stale-bbbb' })}`),
    );
    resetVaultCacheForTests();

    const status = await keyStatuses();
    expect(status.openai.present).toBe(true);
    expect((status as Record<string, unknown>).mistral).toBeUndefined();
  });

  it('treats an undecryptable file as no keys, not as a crash', async () => {
    disk.set(VAULT_FILE, Buffer.from('not-encrypted-garbage'));
    resetVaultCacheForTests();
    await expect(keyStatuses()).resolves.toBeDefined();
    expect(await getKeyForProvider('openai')).toBeNull();
  });
});

describe('maskKey', () => {
  it('keeps the prefix and last four, and nothing else', () => {
    expect(maskKey('sk-proj-abcdefgh4f2a')).toBe('sk-…4f2a');
    expect(maskKey('short')).toBe('…');
    expect(maskKey('  sk-abcdefghijkl9999  ')).toBe('sk-…9999');
  });
});
