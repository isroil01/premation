/**
 * The gate every shipped translation passes through.
 *
 * Each `LOCALES` entry with a catalogue is loaded and checked against the
 * English source, `locales/en.json`: no unknown keys, no broken placeholders,
 * no empty strings. Missing keys are allowed — they fall back to English —
 * and the coverage is printed so a partial translation is visible in the log.
 */

import fs from 'fs';
import path from 'path';
import { LOCALES } from './locales';
import { validateCatalogue } from './validateCatalogue';

const source = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'locales/en.json'), 'utf8'),
) as Record<string, string>;

describe('validateCatalogue', () => {
  const src = { 'menu.file': 'File', 'menu.recall': 'Recall {n}', 'menu.save': 'Save' };

  it('accepts a partial, well-formed translation and reports coverage', () => {
    const r = validateCatalogue(src, { 'menu.file': '文件', 'menu.recall': '使用 {n}' });
    expect(r.errors).toEqual([]);
    expect(r.missing).toEqual(['menu.save']);
    expect(r.coverage).toBeCloseTo(2 / 3);
  });

  it('rejects unknown keys, broken placeholders and empty strings', () => {
    const r = validateCatalogue(src, {
      'menu.fiel': '文件',
      'menu.recall': '使用 {num}',
      'menu.save': ' ',
    });
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join('\n')).toMatch(/unknown key "menu\.fiel"/);
    expect(r.errors.join('\n')).toMatch(/placeholders \{num\} ≠ English \{n\}/);
    expect(r.errors.join('\n')).toMatch(/"menu\.save" is empty/);
  });
});

describe('shipped catalogues', () => {
  const translated = LOCALES.filter((l) => l.load);

  it('has an English source with no empty strings', () => {
    expect(Object.keys(source).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(source)) expect([k, v.trim()]).not.toEqual([k, '']);
  });

  // `test.each` needs at least one row; English-only builds have none yet.
  if (translated.length === 0) {
    it.skip('no translated catalogues ship yet', () => {});
    return;
  }

  it.each(translated.map((l) => [l.code, l] as const))('%s validates against en.json', async (code, l) => {
    const cat = await l.load!();
    const report = validateCatalogue(source, cat);
    expect(report.errors).toEqual([]);
    // Informational — a partial translation is allowed, but should be visible.
    console.info(`[i18n] ${code}: ${(report.coverage * 100).toFixed(0)}% of ${Object.keys(source).length} strings`);
  });
});
