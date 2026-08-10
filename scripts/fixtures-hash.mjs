#!/usr/bin/env node
/**
 * Prove the cross-repo plugin fixtures are byte-identical.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 *
 * motion-editor and motion-back never import each other. Where they must agree
 * — the manifest grammar, the consent text, the method→permission table, the
 * report vocabulary — they share JSON fixtures and each side runs its own code
 * against its own copy. That is the ONLY mechanism keeping the two in step, and
 * nothing verified that the copies match.
 *
 * So the realistic failure was silent and asymmetric: one repo edits a fixture,
 * both suites pass, and the registry now validates a manifest the editor gates
 * differently. Every test in both repos stays green, because each is testing
 * its own copy against itself.
 *
 * A checksum file, committed byte-identical in both repos, turns that into a
 * red build in BOTH — the one that changed, because the recorded hash no longer
 * matches, and the sibling, because its copy of the checksum file was not
 * updated.
 *
 * ── Why this file is duplicated rather than shared ──────────────────────────
 *
 * A shared package would be a third thing to publish and version, and it would
 * have to be released before either repo could change a fixture — the change
 * this is meant to make cheap. Two identical copies of forty lines is the
 * smaller cost. The copies do not need to agree with each other: each one only
 * has to hash its own repo's files correctly.
 *
 * Usage:
 *   node scripts/fixtures-hash.mjs           verify; exit 1 on mismatch
 *   node scripts/fixtures-hash.mjs --write   record the current hashes
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The fixtures both repositories must hold identical copies of.
 *
 * A fixed list, not a directory scan. A scan would silently start policing a
 * fixture that is deliberately one-sided the moment someone adds one, and the
 * fix for that failure — deleting the file or weakening the check — is worse
 * than the problem.
 */
const SHARED = [
  'manifests.json',
  'permissions.json',
  'methodPermissions.json',
  'reportCategories.json',
  'capabilityBackCompat.json',
];

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Find the plugin `__fixtures__` directory.
 *
 * Discovered rather than hardcoded because the two repos put it in different
 * places — `src/core/plugins/__fixtures__` here, `src/plugins/__fixtures__`
 * there — and this file has to be byte-identical in both. Identified by
 * CONTENT: the directory holding `manifests.json`.
 */
function findFixtureDir(root) {
  const stack = [join(root, 'src')];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (dir.endsWith('__fixtures__') && entries.includes('manifests.json')) return dir;
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
      } catch { /* a symlink to nowhere, or a race with a build */ }
    }
  }
  return null;
}

const fixtureDir = findFixtureDir(REPO_ROOT);
if (!fixtureDir) {
  console.error('fixtures-hash: no plugin __fixtures__ directory found under src/.');
  process.exit(1);
}

const checksumPath = join(fixtureDir, 'CHECKSUMS.txt');

/**
 * Hash the bytes as they sit on disk, with one normalisation: line endings.
 *
 * Git checks these out CRLF on Windows and LF on Linux, so raw bytes would make
 * the check fail for every Windows contributor and pass in CI, which is the
 * worst possible split — a guard that only the people who cannot debug it ever
 * see fail. Normalising to LF compares the CONTENT, which is what "the two
 * repos agree" actually means.
 */
function hash(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const lines = [];
const missing = [];
for (const name of SHARED) {
  const path = join(fixtureDir, name);
  if (!existsSync(path)) { missing.push(name); continue; }
  lines.push(`${hash(path)}  ${name}`);
}

if (missing.length > 0) {
  console.error(`fixtures-hash: missing shared fixture(s): ${missing.join(', ')}`);
  process.exit(1);
}

const current = `${lines.join('\n')}\n`;

if (process.argv.includes('--write')) {
  writeFileSync(checksumPath, current, 'utf8');
  console.log(`fixtures-hash: wrote ${SHARED.length} hashes to ${checksumPath}`);
  console.log('Copy this file to the SIBLING repository as well — the check fails there until you do.');
  process.exit(0);
}

if (!existsSync(checksumPath)) {
  console.error(`fixtures-hash: ${checksumPath} does not exist. Run with --write to create it.`);
  process.exit(1);
}

const recorded = readFileSync(checksumPath, 'utf8').replace(/\r\n/g, '\n');
if (recorded === current) {
  console.log(`fixtures-hash: ${SHARED.length} shared fixtures match CHECKSUMS.txt.`);
  process.exit(0);
}

console.error(
  [
    '',
    'fixtures-hash: a shared plugin fixture changed.',
    '',
    'These files are BYTE-IDENTICAL in motion-editor and motion-back. They are the',
    'only mechanism keeping the two repositories in step — neither imports the',
    'other, so a fixture that differs means the registry validates a manifest the',
    'editor gates differently, with every test in both repos still green.',
    '',
    'BOTH repositories must be updated in the same change:',
    '',
    '  1. make the same edit to the fixture in the sibling repository',
    '     (motion-editor: src/core/plugins/__fixtures__/,',
    '      motion-back:   src/plugins/__fixtures__/)',
    '  2. run `node scripts/fixtures-hash.mjs --write` in this repository',
    '  3. copy the resulting CHECKSUMS.txt to the sibling, byte for byte',
    '  4. link the two pull requests to each other',
    '',
    'recorded:',
    recorded.trimEnd(),
    '',
    'actual:',
    current.trimEnd(),
    '',
  ].join('\n'),
);
process.exit(1);
