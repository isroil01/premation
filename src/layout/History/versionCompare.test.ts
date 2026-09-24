/**
 * Version compare: a saved version against the live composition under a wipe.
 *
 * The frame maths is pinned as a pure function; the wiring (a Compare button
 * per version row, the wipe as a clip on the version's frame, a restore that
 * is one undo step) is pinned by reading the sources, the way the export
 * dialog's shape is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('@core/export/offlineRenderer', () => ({ renderStillFrame: jest.fn() }));
jest.mock('@core/api/client', () => ({ api: {} }));

import { frameAt } from './VersionCompareDialog';

const read = (rel: string): string => readFileSync(join(__dirname, rel), 'utf8');

describe('frameAt', () => {
  it('rounds the playhead to the nearest frame', () => {
    expect(frameAt(1, 30, 10)).toBe(30);
    expect(frameAt(1.02, 30, 10)).toBe(31);
  });

  it('clamps into the composition', () => {
    expect(frameAt(-3, 30, 10)).toBe(0);
    expect(frameAt(99, 30, 10)).toBe(299);
    expect(frameAt(0, 30, 0)).toBe(0);
  });
});

describe('version compare wiring', () => {
  it('every version row offers Compare, which opens the compare dialog', () => {
    const panel = read('VersionHistoryPanel.tsx');
    expect(panel).toContain('openVersionCompare(v)');
    expect(panel).toContain('Compare');
  });

  it('the wipe is a clip on the version frame, driven by a range input', () => {
    const dialog = read('VersionCompareDialog.tsx');
    expect(dialog).toContain('clipPath');
    expect(dialog).toContain('type="range"');
    // The slider owns Enter — dragging it must not fire the restore.
    expect(dialog).toContain('data-enter-safe');
  });

  it('restoring from the compare is one undo step', () => {
    const dialog = read('VersionCompareDialog.tsx');
    const restore = read('versionRestore.ts');
    expect(dialog).toContain('restoreVersionAsOneEdit(version.id)');
    // The engine's undoable whole-document restore (B3z), labelled for Edit ▸ Undo.
    expect(restore).toContain("type: 'restoreDocument'");
    expect(restore).toContain("'Restore version'");
  });
});
