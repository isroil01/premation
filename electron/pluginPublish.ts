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

import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { dialog, BrowserWindow } from 'electron';
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
  const picked = await dialog.showOpenDialog(parent!, {
    title: 'Choose your publisher signing key',
    message: 'The key is read, used to sign this package, and not stored.',
    properties: ['openFile'],
    filters: [{ name: 'Signing key', extensions: ['json'] }],
  });
  // Cancelling is not an error — it is the user changing their mind, and a
  // dialog that reports it as a failure trains people to ignore failures.
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, error: '', cancelled: true };

  let signature: string;
  let publicKey: string;
  try {
    const record = readKeyFile(picked.filePaths[0]);
    signature = signBytes(bytes, record);
    publicKey = record.publicKey;
    // `record` goes out of scope here and is never written anywhere.
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
