#!/usr/bin/env node
/**
 * Plugin publishing toolkit: make a key, sign a package, publish it.
 *
 *   node scripts/sign-plugin.mjs keygen [--out ./my-plugin.key.json]
 *   node scripts/sign-plugin.mjs sign my-plugin.zip --key ./my-plugin.key.json
 *   node scripts/sign-plugin.mjs publish my-plugin.zip --key ./my-plugin.key.json \
 *        --token <access token> [--api http://localhost:4000/api]
 *
 * The private key never leaves this machine — `publish` sends the package, the
 * signature and the PUBLIC key, and nothing else.
 *
 * Keep the key file. The registry pins it to your plugin id the first time you
 * publish (trust-on-first-use), and every later version must be signed with the
 * same key: that is what lets a user's editor know an update came from you
 * rather than from whoever got into your account. Lose it and the plugin has to
 * be republished under a new id — which is the cost of the guarantee, not an
 * oversight.
 */

import { generateKeyPairSync, createPrivateKey, sign as nodeSign, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const [, , cmd, ...rest] = process.argv;

/** `--flag value` pairs, plus the first bare argument. */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1]; i += 1; }
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(rest);

/**
 * Report and stop.
 *
 * `process.exitCode` + throw rather than `process.exit()`: exiting hard while a
 * fetch is still in flight trips a libuv assertion on Windows, which prints a
 * wall of C-file noise underneath the actual error message and makes a clear
 * failure look like a crash.
 */
function die(msg) {
  console.error(`\n  ${msg}\n`);
  process.exitCode = 1;
  throw new SilentExit();
}

class SilentExit extends Error {}

process.on('uncaughtException', (err) => {
  if (!(err instanceof SilentExit)) throw err;
});

// ── keygen ────────────────────────────────────────────────────────────────

function keygen() {
  const out = args.out || './plugin-key.json';
  if (existsSync(out)) {
    die(`${out} already exists. Refusing to overwrite a signing key — if you replace it, every plugin signed with the old one can no longer be updated.`);
  }
  // P-256, to match what the editor can verify with WebCrypto everywhere.
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const record = {
    algorithm: 'ECDSA-P256-SHA256',
    createdAt: new Date().toISOString(),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  console.log(`\n  Wrote ${out}`);
  console.log('  Public key:  ' + record.publicKey.slice(0, 44) + '…');
  console.log('\n  Back this file up somewhere you will still have in a year.');
  console.log('  It is the only thing that can ship an update to your plugin.\n');
}

// ── sign ──────────────────────────────────────────────────────────────────

function loadKey() {
  const keyPath = args.key || './plugin-key.json';
  if (!existsSync(keyPath)) die(`No key at ${keyPath}. Run: node scripts/sign-plugin.mjs keygen`);
  const record = JSON.parse(readFileSync(keyPath, 'utf8'));
  if (!record.privateKey || !record.publicKey) die(`${keyPath} is not a key file written by keygen.`);
  return record;
}

function signBytes(bytes, record) {
  const key = createPrivateKey({
    key: Buffer.from(record.privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  // ieee-p1363 (r||s), NOT Node's default DER — WebCrypto in the editor only
  // accepts the former, and a DER signature fails there with no useful message.
  return nodeSign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
}

function sign() {
  const file = args._[0];
  if (!file) die('Usage: sign <package.zip> [--key ./plugin-key.json]');
  if (!existsSync(file)) die(`No such file: ${file}`);
  const record = loadKey();
  const bytes = readFileSync(file);
  const signature = signBytes(bytes, record);

  console.log(`\n  ${basename(file)}  (${bytes.length} bytes)`);
  console.log(`  sha256     ${createHash('sha256').update(bytes).digest('hex')}`);
  console.log(`  signature  ${signature}`);
  console.log(`  publicKey  ${record.publicKey}\n`);
  return { bytes, signature, record };
}

// ── publish ───────────────────────────────────────────────────────────────

async function publish() {
  const file = args._[0];
  if (!file) die('Usage: publish <package.zip> --token <access token> [--key ./plugin-key.json] [--api …]');
  if (!args.token) die('A --token is required. Copy an access token from a signed-in editor session.');
  const api = (args.api || process.env.MOTION_API || 'http://localhost:4000/api').replace(/\/$/, '');

  const record = loadKey();
  const bytes = readFileSync(file);
  const signature = signBytes(bytes, record);

  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/zip' }), basename(file));
  form.append('signature', signature);
  form.append('publicKey', record.publicKey);

  const res = await fetch(`${api}/plugins`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.token}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) die(`Publish failed (${res.status}):\n  ${text}`);

  const out = JSON.parse(text);
  console.log(`\n  Published ${out.id}@${out.latestVersion}`);
  console.log(`  Permissions: ${out.permissions?.join(', ') || 'none'}\n`);
}

// ── dispatch ──────────────────────────────────────────────────────────────

const commands = { keygen, sign, publish };
if (!cmd || !commands[cmd]) {
  console.log(`
  Plugin publishing toolkit

    keygen   [--out ./plugin-key.json]      make a signing key (once, per publisher)
    sign     <package.zip> [--key …]        print the signature for a package
    publish  <package.zip> --token <jwt>    sign and upload to the registry
                           [--key …] [--api http://localhost:4000/api]
`);
  process.exitCode = cmd ? 1 : 0;
} else {
  try {
    await commands[cmd]();
  } catch (err) {
    // `die()` throws SilentExit after printing its own message; anything else
    // is a real fault and should keep its stack.
    if (!(err instanceof SilentExit)) throw err;
  }
}
