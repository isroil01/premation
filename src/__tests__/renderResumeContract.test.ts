/**
 * `ResumableRenderJob` and `AdoptedRenderJob` are written out twice — once in
 * `electron/renderResume.ts` for the main process, once in
 * `src/types/motionEditor.d.ts` for the renderer — because the renderer must not
 * import main-process sources (they pull in `electron`, which does not resolve
 * in a browser build) and main must not import from `src/` (a separate tsconfig
 * and a separate bundle).
 *
 * Two copies of a type crossing an IPC boundary is exactly the shape that drifts
 * silently, and this pair drifts in a particularly quiet way: main adds a field,
 * the renderer's restore path never reads it, and a queue simply comes back one
 * fact poorer after every restart. Nothing type-checks that, because neither
 * side imports the other.
 *
 * So it is checked as text — the same treatment `UpdateStatus` gets in
 * `updaterStatusContract.test.ts`. Crude, and it catches the only failure that
 * matters.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

const mainSrc = readFileSync(join(ROOT, 'electron', 'renderResume.ts'), 'utf8');
const rendererSrc = readFileSync(join(ROOT, 'src', 'types', 'motionEditor.d.ts'), 'utf8');
const preloadSrc = readFileSync(join(ROOT, 'electron', 'preload.ts'), 'utf8');
const mainProcessSrc = readFileSync(join(ROOT, 'electron', 'main.ts'), 'utf8');

/** Pull one `export interface X { … }` out of a file and normalise it. */
function interfaceOf(src: string, name: string): string {
  const start = src.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end + 2)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the resume payloads stay identical on both sides of the IPC boundary', () => {
  it.each(['ResumableRenderJob', 'AdoptedRenderJob'])('declares %s in both places', (name) => {
    expect(mainSrc).toContain(`export interface ${name} {`);
    expect(rendererSrc).toContain(`export interface ${name} {`);
  });

  it.each(['ResumableRenderJob', 'AdoptedRenderJob'])('declares the SAME %s in both places', (name) => {
    expect(interfaceOf(rendererSrc, name)).toBe(interfaceOf(mainSrc, name));
  });

  it('still carries every field the restore path acts on', () => {
    // A floor, so two copies emptied by the same bad edit cannot pass the
    // comparison above by being equally broken.
    for (const field of ['jobId', 'spec', 'format', 'totalFrames', 'stagedFrames', 'createdAt']) {
      expect(interfaceOf(mainSrc, 'ResumableRenderJob')).toContain(`${field}:`);
    }
    // `nextFrame` is the one adoption adds, and the one a resume acts on: it is
    // the first MISSING frame, which is not the same as the count when a frame
    // went missing under us.
    for (const field of ['jobId', 'spec', 'nextFrame', 'stagedFrames', 'frameExt']) {
      expect(interfaceOf(mainSrc, 'AdoptedRenderJob')).toContain(`${field}:`);
    }
  });

  it('keeps `spec` opaque on both sides', () => {
    // Main round-trips the renderer's `RenderJobSpec` through JSON without ever
    // reading a field of it. The day one side types it as something concrete,
    // main starts making a promise about a shape it cannot keep across a
    // version change — and the renderer stops validating what it got back.
    for (const src of [mainSrc, rendererSrc]) {
      expect(interfaceOf(src, 'ResumableRenderJob')).toContain('spec: unknown;');
      expect(interfaceOf(src, 'AdoptedRenderJob')).toContain('spec: unknown;');
    }
  });
});

describe('the resume channels exist on every side of the bridge', () => {
  const channels = ['render:listResumableJobs', 'render:adoptJob', 'render:discardJob'];

  it.each(channels)('%s is handled in main', (channel) => {
    expect(mainProcessSrc).toContain(`handle('${channel}'`);
  });

  it.each(channels)('%s is forwarded by the preload', (channel) => {
    expect(preloadSrc).toContain(`'${channel}'`);
  });

  it.each(['listResumableJobs', 'adoptJob', 'discardJob'])(
    '%s is on the renderer-facing type',
    (method) => {
      expect(rendererSrc).toContain(`${method}?(`);
      expect(preloadSrc).toContain(`${method}:`);
    },
  );

  it('lets beginJob carry the manifest that makes a render resumable', () => {
    // The one existing channel whose SHAPE changed. A preload that kept
    // forwarding no arguments would leave every staging dir undescribed, and
    // the only symptom would be an empty resumable list after a crash.
    expect(preloadSrc).toContain("ipcRenderer.invoke('render:beginJob', info)");
    expect(rendererSrc).toContain('beginJob?(info?:');
  });
});
