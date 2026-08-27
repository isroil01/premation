/**
 * The `UpdateStatus` union is written out twice — once in
 * `electron/updaterPolicy.ts` for the main process, once in
 * `src/types/motionEditor.d.ts` for the renderer — because the renderer must
 * not import main-process sources (they pull in `electron`, which does not
 * resolve in a browser build).
 *
 * Two copies of a type crossing an IPC boundary is exactly the shape that drifts
 * silently: main starts sending a new `kind`, the renderer's switch has no case
 * for it, and the update notice just never appears. Nothing type-checks that,
 * because neither side imports the other.
 *
 * So it is checked as text. Crude, and it catches the only failure that matters.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

const mainSrc = readFileSync(join(ROOT, 'electron', 'updaterPolicy.ts'), 'utf8');
const rendererSrc = readFileSync(join(ROOT, 'src', 'types', 'motionEditor.d.ts'), 'utf8');

/** Pull the `UpdateStatus` union out of a file and normalise it to compare. */
function unionOf(src: string): string {
  const start = src.indexOf('export type UpdateStatus');
  expect(start).toBeGreaterThan(-1);
  // The union ends at the first `};` — every member before it closes with `}`
  // then a newline, so this cannot stop early on a member's own semicolons
  // (`{ kind: 'available'; version: string }` has two).
  const end = src.indexOf('};', start);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end + 1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('UpdateStatus stays identical on both sides of the IPC boundary', () => {
  it('declares the union in both places', () => {
    expect(mainSrc).toContain('export type UpdateStatus');
    expect(rendererSrc).toContain('export type UpdateStatus');
  });

  it('declares the SAME union in both places', () => {
    expect(unionOf(rendererSrc)).toBe(unionOf(mainSrc));
  });

  it('still covers every state the UI branches on', () => {
    // A floor, so a union emptied by a bad edit cannot make the test above pass
    // by comparing two equally-broken copies.
    for (const kind of ['idle', 'checking', 'available', 'downloading', 'ready', 'unsupported', 'error']) {
      expect(unionOf(mainSrc)).toContain(`kind: '${kind}'`);
    }
  });
});

describe('the preload bridge exposes what the renderer type promises', () => {
  const preload = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8');

  it.each([
    'getStatus',
    'onStatus',
    'getSettings',
    'setAutoDownload',
    'check',
    'downloadNow',
    'restartAndInstall',
  ])('forwards %s', (member) => {
    expect(preload).toMatch(new RegExp(`${member}\\s*:`));
  });

  it('registers a matching handler in the main process for each invoke', () => {
    const updater = readFileSync(join(ROOT, 'electron', 'updater.ts'), 'utf8');
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('(updater:[a-zA-Z]+)'/g)].map((m) => m[1]!);
    expect(invoked.length).toBeGreaterThan(0);
    for (const channel of invoked) {
      expect(updater).toContain(`handle('${channel}'`);
    }
  });
});
