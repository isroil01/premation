/**
 * A reopened project still has its footage.
 *
 * A saved project names its files by PATH only. The engine used to load them
 * back as placeholders — `missing`, no size, no probed facts, no playable
 * source — even when the file was still exactly where it had been, so every
 * reopened (or recovered) project showed its whole Project panel as offline:
 * no thumbnails, no sizes, nothing to open in the Footage viewer. The layers
 * kept drawing (they carry their own source), which is what hid it.
 *
 * The load now reads those files again where they still are
 * (native docio `relink_missing_footage`); only a file that is really gone
 * stays a placeholder and is reported in `missingItems`.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { setupAppEngine, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { documentMirror } from '@stores/documentMirror';

let h: Harness;
let dir: string;

beforeEach(async () => {
  h = await setupAppEngine();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'premation-reopen-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A real file on disk for the engine's importer (the repo's own icon). */
function footageCopy(name: string): string {
  const to = path.join(dir, name).replace(/\\/g, '/');
  fs.copyFileSync(path.resolve(__dirname, '../../../build/icon.png'), to);
  return to;
}

it('relinks footage that is still at its saved path when the project is opened again', async () => {
  const file = footageCopy('still-here.png');
  const imported = await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] });
  const id = imported.items[0]!;
  await documentMirror().whenIdle();
  expect(documentMirror().item(id)?.missing).toBe(false);

  const project = path.join(dir, 'reopen.motion').replace(/\\/g, '/');
  await h.run({ type: 'saveProject', path: project, copy: false });
  await h.run({ type: 'newProject' });
  const opened = await h.run({ type: 'openProject', path: project });
  await documentMirror().whenIdle();

  expect(opened.missingItems).toEqual([]);
  const item = documentMirror().item(id);
  expect(item?.missing).toBe(false);
  expect(item?.mediaUrl ?? '').not.toBe('');
  expect(item?.path).toBe(file);
});

it('keeps a placeholder, and says so, for a file that is really gone', async () => {
  const file = footageCopy('goes-away.png');
  const imported = await h.run({ type: 'importFiles', files: [{ path: file, asSequence: false, createComposition: false }] });
  const id = imported.items[0]!;
  const project = path.join(dir, 'gone.motion').replace(/\\/g, '/');
  await h.run({ type: 'saveProject', path: project, copy: false });
  await h.run({ type: 'newProject' });
  fs.rmSync(file);

  const opened = await h.run({ type: 'openProject', path: project });
  await documentMirror().whenIdle();

  expect(opened.missingItems).toEqual([id]);
  expect(documentMirror().item(id)?.missing).toBe(true);
  // What the document says about it survives, so it can be relinked.
  expect(documentMirror().item(id)?.name).toBe('goes-away.png');
});
