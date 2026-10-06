#!/usr/bin/env node
/**
 * Pack a native plugin bundle into a `.pplugin` (docs/PLUGIN_STORE.md §2).
 *
 *   node scripts/pack-plugin.mjs <bundle-folder> [--out x.pplugin] [--key plugin-key.json] [--only-present]
 *
 * `--only-present` drops `binary` keys whose file is not in the folder (a
 * one-OS local build) instead of refusing; a release packs every platform
 * (examples/plugin-ci merges the per-OS builds first).
 *
 * The bundle is the folder `premation-engine` loads (docs/PLUGIN_SDK.md):
 * `premation-plugin.json` plus the binary each `binary` key names. The packer
 *
 *   1. checks the manifest the way the engine will (manifestVersion 1, id and
 *      effect match names, sdk, every `binary` key known and its file present),
 *   2. refuses unsafe or unexpected files (symlinks, dot-files, `..`, sizes),
 *   3. writes `integrity.files` — the SHA-256 of every file — into the manifest,
 *   4. zips the bundle deterministically (sorted, fixed timestamps), so the same
 *      folder always packs to the same bytes and a signature is reproducible,
 *   5. with `--key`, signs the package (sign-plugin.mjs's scheme) and writes
 *      `<out>.sig` next to it.
 *
 * Everything here is checked again by the registry on upload and by the
 * editor before install; failing here is just the earliest, cheapest moment.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { zipSync } from 'fflate';
import { loadKey, signBytes } from './sign-plugin.mjs';

export const MANIFEST = 'premation-plugin.json';
export const BINARY_KEYS = ['windows', 'windows-x64', 'macos', 'macos-arm64', 'macos-x64', 'macos-universal', 'linux', 'linux-x64', 'linux-arm64'];
export const MAX_FILES = 2000;
export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,99}$/;

/** The engine's manifest rules (native/engine/src/plugins/manifest.cpp), plus the store's binary keys. */
export function checkManifest(m, files) {
  const problems = [];
  if (!m || typeof m !== 'object') return ['the manifest is not a JSON object'];
  if (m.manifestVersion !== 1) problems.push('manifestVersion must be 1');
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) problems.push(`invalid plugin id "${m.id}"`);
  if (typeof m.version !== 'string' || m.version === '') problems.push('a version is required');
  if (!m.sdk || !Number.isInteger(m.sdk.major) || !Number.isInteger(m.sdk.minor)) problems.push('sdk {major, minor} is required');
  if (!m.binary || typeof m.binary !== 'object' || Object.keys(m.binary).length === 0) problems.push('binary names no platform');
  for (const [key, file] of Object.entries(m.binary ?? {})) {
    if (!BINARY_KEYS.includes(key)) problems.push(`unknown binary key "${key}" (known: ${BINARY_KEYS.join(', ')})`);
    if (typeof file !== 'string' || file === '' || /[\\/]|\.\./.test(file)) problems.push(`binary.${key} must be a file name inside the bundle`);
    else if (!files.has(file)) problems.push(`binary.${key} names "${file}", which is not in the bundle`);
  }
  if (!Array.isArray(m.effects) || m.effects.length === 0) problems.push('the manifest lists no effects');
  const seen = new Set();
  for (const e of m.effects ?? []) {
    const mn = e?.matchName;
    const owned = typeof mn === 'string' && (mn === m.id || mn.startsWith(`${m.id}.`)) && ID_RE.test(mn);
    if (!owned) problems.push(`effect match name "${mn}" must be "${m.id}" or "${m.id}.<name>"`);
    if (seen.has(mn)) problems.push(`effect "${mn}" is listed twice`);
    seen.add(mn);
  }
  return problems;
}

/** Every file of the bundle, `/`-relative, sorted. Refusals are collected. */
export function collectBundle(root) {
  const files = new Map();
  const problems = [];
  let total = 0;
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) { problems.push(`${relPath}: symlinks are not packed`); continue; }
      if (name.startsWith('.')) continue; // .DS_Store, .git — never part of a plugin
      if (st.isDirectory()) { walk(full, relPath); continue; }
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) problems.push(`${relPath}: ${st.size} bytes is over the ${MAX_FILE_BYTES}-byte file limit`);
      total += st.size;
      files.set(relPath, readFileSync(full));
    }
  };
  walk(root, '');
  if (files.size > MAX_FILES) problems.push(`${files.size} files is over the ${MAX_FILES}-file limit`);
  if (total > MAX_PACKAGE_BYTES) problems.push(`${total} bytes is over the ${MAX_PACKAGE_BYTES}-byte package limit`);
  return { files, problems };
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Manifest with `integrity` + the deterministic zip. Throws with every problem listed. */
export function packBundle(root, opts = {}) {
  const { files, problems } = collectBundle(root);
  const manifestBytes = files.get(MANIFEST);
  if (!manifestBytes) throw new Error(`no ${MANIFEST} at the root of ${root}`);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (e) {
    throw new Error(`${MANIFEST} is not valid JSON: ${e.message}`);
  }
  const dropped = [];
  if (opts.onlyPresent && manifest && typeof manifest.binary === 'object') {
    for (const [key, file] of Object.entries(manifest.binary)) {
      if (typeof file === 'string' && !files.has(file)) {
        delete manifest.binary[key];
        dropped.push(key);
      }
    }
  }
  problems.push(...checkManifest(manifest, files));
  if (problems.length > 0) throw new Error(`cannot pack:\n  - ${problems.join('\n  - ')}`);
  const integrity = {};
  for (const [path, bytes] of files) if (path !== MANIFEST) integrity[path] = sha256(bytes);
  const out = { ...manifest, integrity: { files: integrity } };
  const entries = {};
  // Fixed mtime and sorted order: the same bundle always packs to the same bytes.
  const mtime = new Date('2000-01-01T00:00:00Z');
  entries[MANIFEST] = [new TextEncoder().encode(`${JSON.stringify(out, null, 2)}\n`), { mtime }];
  for (const [path, bytes] of files) if (path !== MANIFEST) entries[path] = [new Uint8Array(bytes), { mtime }];
  return { manifest: out, dropped, bytes: Buffer.from(zipSync(entries, { level: 9 })) };
}

function main(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--only-present') args.onlyPresent = true;
    else if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i += 1; } else args._.push(a);
  }
  const onlyPresent = args.onlyPresent === true;
  const root = args._[0];
  if (!root || !existsSync(root)) {
    console.error('Usage: node scripts/pack-plugin.mjs <bundle-folder> [--out x.pplugin] [--key plugin-key.json] [--only-present]');
    process.exit(2);
  }
  try {
    const { manifest, bytes, dropped } = packBundle(resolve(root), { onlyPresent });
    if (dropped.length > 0) console.warn(`\n  warning: no binary for ${dropped.join(', ')} — packed without those platforms`);
    const out = args.out || `${manifest.id}-${manifest.version}.pplugin`;
    writeFileSync(out, bytes);
    console.log(`\n  ${basename(out)}  ${manifest.id}@${manifest.version}  (${bytes.length} bytes)`);
    console.log(`  platforms  ${Object.keys(manifest.binary).join(', ')}`);
    console.log(`  sha256     ${sha256(bytes)}`);
    if (args.key) {
      const key = loadKey(args.key);
      const signature = signBytes(bytes, key);
      writeFileSync(`${out}.sig`, `${JSON.stringify({ signature, publicKey: key.publicKey }, null, 2)}\n`);
      console.log(`  signature  ${out}.sig`);
    }
    console.log('');
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('pack-plugin.mjs')) main(process.argv.slice(2));
