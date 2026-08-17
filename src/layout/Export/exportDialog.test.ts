/**
 * Export composition dialog: a two-column panel, not a stacked form.
 *
 * Pins the missing range control (work area vs entire comp), format cards
 * instead of a hint-stuffed <select>, and the lg modal so the preview has room.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = __dirname;
const DIALOG = readFileSync(join(DIR, 'ExportDialog.tsx'), 'utf8');
const MANAGER = readFileSync(join(__dirname, '..', '..', 'core', 'export', 'exportManager.ts'), 'utf8');

describe('Export composition dialog', () => {
  it('opens at lg so preview and settings sit side by side', () => {
    expect(DIALOG).toMatch(/size: 'lg'/);
    expect(DIALOG).toMatch(/className=\{styles\.layout\}/);
    expect(DIALOG).toMatch(/className=\{styles\.previewCol\}/);
    expect(DIALOG).toMatch(/className=\{styles\.settingsCol\}/);
  });

  it('offers formats as a radiogroup of cards, not a select dumping hints into options', () => {
    expect(DIALOG).toMatch(/role="radiogroup"/);
    expect(DIALOG).toMatch(/styles\.formatCard/);
    expect(DIALOG).not.toMatch(/<select[\s\S]*Export format/);
  });

  it('lets the user choose entire composition vs work area', () => {
    expect(DIALOG).toMatch(/Entire composition/);
    expect(DIALOG).toMatch(/Work area/);
    expect(DIALOG).toMatch(/useWorkArea/);
    expect(MANAGER).toMatch(/useWorkArea\?: boolean/);
    expect(MANAGER).toMatch(/opts\.useWorkArea === false/);
  });

  it('pins the filename and Export action in a footer', () => {
    expect(DIALOG).toMatch(/styles\.footer/);
    expect(DIALOG).toMatch(/styles\.fileName/);
    expect(DIALOG).toMatch(/: 'Export'/);
  });

  it('surfaces alpha even when the format cannot carry it', () => {
    expect(DIALOG).toMatch(/Transparent background/);
    expect(DIALOG).toMatch(/has no alpha channel/);
  });
});
