/**
 * Publishing a plugin from inside the editor, without the key entering the app.
 *
 * ── Why this is in MAIN ──────────────────────────────────────────────────────
 *
 * Two secrets meet in a publish: the account session and the publisher's private
 * signing key. Both must stay out of the renderer — the session because that is
 * the whole point of `apiSession`/`credentialStore`, and the key because it is
 * the only thing that makes "this update came from the same author" mean
 * anything. A stolen key cannot be revoked by blocking a version; the publisher
 * has to rotate, and every installed copy has to accept the new key.
 *
 * So the renderer sends package BYTES and a visibility choice, and gets back a
 * result. It never sees the key, the derived public key path, or the token.
 *
 * ── Why the key is picked every time ─────────────────────────────────────────
 *
 * Deliberate, and the cost is one file picker per publish. The alternative —
 * remembering it in the OS keychain — makes anything that can run as this user
 * able to publish as this publisher, which is exactly the compromise the
 * signing model is supposed to survive. Read, used, dropped: it is never
 * written anywhere by this process and never held past the call.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { app, dialog, BrowserWindow } from 'electron';
import { createPrivateKey, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import * as ipcGuard from './ipcGuard';
import { postMultipartFromMain } from './apiProxy';

/** Mirrors the record `scripts/sign-plugin.mjs keygen` writes. */
interface KeyRecord {
  publicKey: string;
  privateKey: string;
}

export interface PublishRequest {
  /** The `.zip` the user chose, as raw bytes from the renderer. */
  bytes: Uint8Array | ArrayBuffer;
  visibility?: 'public' | 'private';
}

export type PublishResult =
  | { ok: true; plugin: unknown }
  | { ok: false; error: string; cancelled?: true };

/** The largest package the registry accepts. Refused here so a 10 MB upload
 *  fails instantly and locally rather than after crossing the network. */
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;

function readKeyFile(path: string): KeyRecord {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    throw new Error('That key file could not be read.');
  }
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    throw new Error('That file is not a key file written by `sign-plugin.mjs keygen`.');
  }
  const r = record as Partial<KeyRecord>;
  if (typeof r?.privateKey !== 'string' || typeof r?.publicKey !== 'string') {
    throw new Error('That file is missing `privateKey` or `publicKey` — it is not a keygen key file.');
  }
  return { publicKey: r.publicKey, privateKey: r.privateKey };
}

/**
 * Make a publisher signing key, from inside the app.
 *
 * ── Why this had to exist ────────────────────────────────────────────────────
 *
 * The publish flow opened a file picker asking for a key, and there was no way
 * to make one except `scripts/sign-plugin.mjs keygen` — a CLI script in the
 * repository. Anyone who installed the app rather than cloning it therefore hit
 * a dialog demanding a file that could not be produced, with nothing on screen
 * saying so. That is not a missing convenience; it is a dead end at the exact
 * moment someone is trying to ship their first plugin.
 *
 * ── Same key, same file, same guarantees ─────────────────────────────────────
 *
 * P-256, SPKI/PKCS8 base64, written with the same field names and `0600` the
 * script uses — so a key made here works with the CLI and vice versa. One
 * format, two doors into it. Generating in MAIN keeps the private key out of
 * the renderer, exactly as signing does.
 */
function generateKeyRecord(): KeyRecord & { algorithm: string; createdAt: string } {
  // P-256 to match what the editor can verify with WebCrypto everywhere.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    algorithm: 'ECDSA-P256-SHA256',
    createdAt: new Date().toISOString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/**
 * Ask where to save, generate, write, and warn.
 *
 * Returns the record so the publish that prompted it can continue immediately —
 * making someone create a key and then hunt for it in a second picker would be
 * a worse dead end than the one this replaces.
 */
async function createKeyFile(parent: BrowserWindow): Promise<
  { ok: true; record: KeyRecord; path: string } | { ok: false; error: string; cancelled?: true }
> {
  const suggested = path.join(
    app.getPath('documents'),
    'premation-publisher-key.json',
  );
  const picked = await dialog.showSaveDialog(parent, {
    title: 'Save your new publisher signing key',
    message: 'This file is your publisher identity. Keep it safe and back it up.',
    defaultPath: suggested,
    filters: [{ name: 'Signing key', extensions: ['json'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, error: '', cancelled: true };

  /*
    Refuse to overwrite, even though the save dialog already confirmed.

    The OS prompt asks "replace this file?", which is the right question for a
    document and the wrong one for a signing key: replacing it means every
    plugin published under the old key can never be updated again, and the
    dialog gives no hint of that. The same refusal is in the CLI keygen.
  */
  if (existsSync(picked.filePath)) {
    return {
      ok: false,
      error:
        'A file already exists there. Refusing to overwrite it — if it is a signing key, '
        + 'replacing it means every plugin published with it can no longer be updated. '
        + 'Choose a different name.',
    };
  }

  const record = generateKeyRecord();
  try {
    // 0600 so it is not world-readable on a shared machine. Windows ignores the
    // mode, which is why the warning below is not optional.
    writeFileSync(picked.filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `The key could not be written: ${(err as Error).message}` };
  }

  await dialog.showMessageBox(parent, {
    type: 'info',
    title: 'Signing key created',
    message: 'Back this file up somewhere you will still have in a year.',
    detail:
      `Saved to:\n${picked.filePath}\n\n`
      + 'This key is your publisher identity. The registry pins it the first time you '
      + 'publish, and every later version of that plugin must be signed with it.\n\n'
      + '• Lose it and you cannot ship an update to your own plugin.\n'
      + '• Anyone who has it can publish as you.\n\n'
      + 'It is never stored by Premation — you will be asked for it each time you publish.',
    buttons: ['I have noted that'],
    defaultId: 0,
  });

  return { ok: true, record, path: picked.filePath };
}

/**
 * Get a key for this publish: an existing file, or a newly made one.
 *
 * The choice comes FIRST rather than being offered after a cancelled picker,
 * because the person who most needs it is the one who does not know a key file
 * is a thing — and they would read an empty file dialog as "I must already have
 * something", not as "I can make one". Publishing is a rare, deliberate act, so
 * one extra click buys a path that is discoverable forever.
 */
async function obtainKey(parent: BrowserWindow): Promise<
  { ok: true; record: KeyRecord } | { ok: false; error: string; cancelled?: true }
> {
  const choice = await dialog.showMessageBox(parent, {
    type: 'question',
    title: 'Publisher signing key',
    message: 'How do you want to sign this package?',
    detail:
      'Every published plugin is signed, so the registry and everyone who installs it can '
      + 'tell that later versions came from you.\n\n'
      + 'If you have never published before, create a key now.',
    buttons: ['Use an existing key…', 'Create a new key…', 'Cancel'],
    // Enter picks the common case; Esc cancels.
    defaultId: 0,
    cancelId: 2,
  });

  if (choice.response === 2) return { ok: false, error: '', cancelled: true };

  if (choice.response === 1) {
    const made = await createKeyFile(parent);
    if (!made.ok) return made;
    return { ok: true, record: made.record };
  }

  const picked = await dialog.showOpenDialog(parent, {
    title: 'Choose your publisher signing key',
    message: 'The key is read, used to sign this package, and not stored.',
    properties: ['openFile'],
    filters: [{ name: 'Signing key', extensions: ['json'] }],
  });
  // Cancelling is not an error — it is the user changing their mind, and a
  // dialog that reports it as a failure trains people to ignore failures.
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '', cancelled: true };

  try {
    return { ok: true, record: readKeyFile(picked.filePaths[0]) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Sign the exact bytes being uploaded.
 *
 * `ieee-p1363`, NOT Node's default DER. The editor verifies with WebCrypto,
 * which accepts only the former and rejects a DER signature with a message that
 * names nothing — so the mistake would surface as "this package is corrupt" on
 * every install.
 */
function signBytes(bytes: Buffer, record: KeyRecord): string {
  const key = createPrivateKey({
    key: Buffer.from(record.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return nodeSign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

async function publish(req: PublishRequest): Promise<PublishResult> {
  const bytes = Buffer.from(
    req.bytes instanceof ArrayBuffer ? new Uint8Array(req.bytes) : req.bytes,
  );
  if (bytes.byteLength === 0) return { ok: false, error: 'That package is empty.' };
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    return { ok: false, error: `Packages are limited to ${MAX_PACKAGE_BYTES / 1024 / 1024} MB.` };
  }
  const visibility = req.visibility === 'private' ? 'private' : 'public';

  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!parent) return { ok: false, error: 'No window to show the key dialog in.' };

  const key = await obtainKey(parent);
  if (!key.ok) return key;

  let signature: string;
  let publicKey: string;
  try {
    signature = signBytes(bytes, key.record);
    publicKey = key.record.publicKey;
    // The record goes out of scope here and is never written anywhere.
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const form = new FormData();
  form.append('file', new Blob([bytes]), 'plugin.zip');
  form.append('signature', signature);
  form.append('publicKey', publicKey);
  form.append('visibility', visibility);

  let status: number;
  let text: string;
  try {
    ({ status, text } = await postMultipartFromMain('/plugins', form));
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'The registry could not be reached.' };
  }

  if (status === 201 || status === 200) {
    try {
      return { ok: true, plugin: JSON.parse(text) };
    } catch {
      return { ok: true, plugin: null };
    }
  }

  /*
    Surface the REGISTRY's own message.

    Every refusal from `readPublishedManifest` names the field it refused and
    why — "apiVersion 5 is newer than this registry supports", "no plugin.json
    at the package root". Replacing those with a generic failure would throw
    away the only useful half of a publish error.
  */
  let message = `The registry refused the package (${status}).`;
  try {
    const body = JSON.parse(text) as { message?: unknown };
    if (typeof body.message === 'string') message = body.message;
    else if (Array.isArray(body.message)) message = body.message.join(' ');
  } catch { /* keep the status line */ }
  return { ok: false, error: message };
}

/** Register the one channel. Call from the app's IPC setup. */
export function installPluginPublishIpc(): void {
  ipcGuard.handle('plugin:publish', async (_event, req: PublishRequest) => publish(req ?? ({} as PublishRequest)));
}
