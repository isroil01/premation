#!/usr/bin/env node
/**
 * Plugin signing keys and signatures (docs/PLUGIN_STORE.md §2).
 *
 *   node scripts/sign-plugin.mjs keygen [--out plugin-key.json]
 *   node scripts/sign-plugin.mjs sign <x.pplugin> [--key plugin-key.json]
 *   node scripts/sign-plugin.mjs verify <x.pplugin> --signature <b64> --public-key <b64>
 *   node scripts/sign-plugin.mjs publish <x.pplugin> --token <access token> [--key …] [--api …] [--visibility private|public]
 *
 * The scheme is the registry's (motion-back/src/plugins/plugin-signature.ts):
 * ECDSA P-256 over the raw package bytes with SHA-256, the signature in IEEE
 * P1363 form (r‖s, 64 bytes) and base64, the public key SPKI DER in base64.
 * The manifest inside the package carries every file's SHA-256, so this one
 * signature covers the manifest and every platform's binary.
 *
 * Keep the key file. It is the only thing that can ship an update: the editor
 * pins a plugin's key at first install and refuses a package signed by another.
 */

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export function loadKey(path = './plugin-key.json') {
  if (!existsSync(path)) throw new Error(`No key at ${path}. Run: node scripts/sign-plugin.mjs keygen`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  if (!record.privateKey || !record.publicKey) throw new Error(`${path} is not a key file written by keygen.`);
  return record;
}

export function signBytes(bytes, record) {
  const key = createPrivateKey({ key: Buffer.from(record.privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return nodeSign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

export function verifyBytes(bytes, signatureB64, publicKeyB64) {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    const sig = Buffer.from(signatureB64, 'base64');
    return sig.length === 64 && nodeVerify('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

export function keygen(out = './plugin-key.json') {
  if (existsSync(out)) throw new Error(`${out} already exists. Refusing to overwrite a signing key.`);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const record = {
    algorithm: 'ECDSA-P256-SHA256',
    createdAt: new Date().toISOString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  return record;
}

async function main([cmd, ...rest]) {
  const args = { _: [] };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i].startsWith('--')) { args[rest[i].slice(2)] = rest[i + 1]; i += 1; } else args._.push(rest[i]);
  }
  if (cmd === 'keygen') {
    const r = keygen(args.out);
    console.log(`\n  Wrote ${args.out || './plugin-key.json'}\n  Public key: ${r.publicKey.slice(0, 44)}…\n  Back it up: it is the only key that can update your plugin.\n`);
    return;
  }
  const file = args._[0];
  if (!file || !existsSync(file)) throw new Error(`Usage: sign-plugin.mjs ${cmd ?? '<keygen|sign|verify|publish>'} <x.pplugin> …`);
  const bytes = readFileSync(file);
  if (cmd === 'sign') {
    const key = loadKey(args.key);
    const signature = signBytes(bytes, key);
    console.log(`\n  ${basename(file)}  (${bytes.length} bytes)\n  sha256     ${createHash('sha256').update(bytes).digest('hex')}\n  signature  ${signature}\n  publicKey  ${key.publicKey}\n`);
    return;
  }
  if (cmd === 'verify') {
    const ok = verifyBytes(bytes, args.signature ?? '', args['public-key'] ?? '');
    console.log(ok ? '\n  signature OK\n' : '\n  signature does NOT verify\n');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (cmd === 'publish') {
    if (!args.token) throw new Error('A --token is required (an access token from a signed-in editor session).');
    const api = (args.api || process.env.MOTION_API || 'http://localhost:4000/api').replace(/\/$/, '');
    const key = loadKey(args.key);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: 'application/zip' }), basename(file));
    form.append('signature', signBytes(bytes, key));
    form.append('publicKey', key.publicKey);
    if (args.visibility) form.append('visibility', args.visibility);
    const res = await fetch(`${api}/plugins`, { method: 'POST', headers: { Authorization: `Bearer ${args.token}` }, body: form });
    const text = await res.text();
    if (!res.ok) throw new Error(`Publish failed (${res.status}): ${text}`);
    const out = JSON.parse(text);
    console.log(`\n  Published ${out.id}@${out.latestVersion}\n`);
    return;
  }
  throw new Error(`Unknown command "${cmd}". Use keygen, sign, verify or publish.`);
}

if (process.argv[1]?.endsWith('sign-plugin.mjs')) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  });
}
