/**
 * `locales/en.json` — the translator source file — kept in step with the code.
 *
 * It lists every translatable string with its current English:
 *   1. the menu bar, in menu order (keys from `layout/Menu/menuI18n.ts`);
 *   2. every literal `t('key', 'English')` call under `src/`, sorted by key.
 *
 * This suite fails when the file drifts — a string added, reworded or removed —
 * so a translator never works from a stale list, and a reworded string shows
 * up as a reviewable diff instead of silently falling back to English.
 * Regenerate with:
 *
 *   UPDATE_I18N_SOURCE=1 npx jest src/core/i18n/sourceCatalogue.test.ts
 */

import fs from 'fs';
import path from 'path';
import { APP_MENU, type MenuGroupModel } from '@layout/Menu/menuModel';
import { buildPluginsMenuGroup } from '@layout/Menu/pluginMenu';
import { collectMenuKeys } from '@layout/Menu/menuI18n';
import { extractTCalls } from './extractT';

const SRC = path.resolve(__dirname, '../..');
const EN_JSON = path.resolve(__dirname, 'locales/en.json');
/** This module's own docs are full of example calls; tests use made-up keys. */
const SKIP_DIR = path.resolve(__dirname);

/** The groups as the app assembles them: Plugins before Help (see useAppMenuGroups). */
function menuGroups(): MenuGroupModel[] {
  const help = APP_MENU.findIndex((g) => g.id === 'help');
  return [...APP_MENU.slice(0, help), buildPluginsMenuGroup(), ...APP_MENU.slice(help)];
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (p !== SKIP_DIR && e.name !== 'node_modules' && e.name !== '__testHelpers__') sourceFiles(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
  return out;
}

interface Entry { key: string; english: string; where: string }

function collect(): { catalogue: Record<string, string>; clashes: string[] } {
  const entries: Entry[] = collectMenuKeys(menuGroups()).map((e) => ({ ...e, where: `menu ${e.path}` }));
  const calls: Entry[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    for (const c of extractTCalls(fs.readFileSync(file, 'utf8'))) calls.push({ ...c, where: rel });
  }
  calls.sort((a, b) => a.key.localeCompare(b.key));
  entries.push(...calls);

  const catalogue: Record<string, string> = {};
  const origin: Record<string, string> = {};
  const clashes: string[] = [];
  for (const e of entries) {
    const prev = catalogue[e.key];
    if (prev === undefined) {
      catalogue[e.key] = e.english;
      origin[e.key] = e.where;
    } else if (prev !== e.english) {
      clashes.push(`${e.key}: "${prev}" (${origin[e.key]}) vs "${e.english}" (${e.where})`);
    }
  }
  return { catalogue, clashes };
}

describe('locales/en.json', () => {
  const { catalogue, clashes } = collect();

  it('never uses one key for two different English strings', () => {
    // One key, two texts: a translator can only write one translation.
    expect(clashes).toEqual([]);
  });

  it('matches the menu model and every t() call', () => {
    const serialized = `${JSON.stringify(catalogue, null, 2)}\n`;
    if (process.env.UPDATE_I18N_SOURCE) fs.writeFileSync(EN_JSON, serialized, 'utf8');
    const onDisk = fs.existsSync(EN_JSON) ? fs.readFileSync(EN_JSON, 'utf8').replace(/\r\n/g, '\n') : '';
    // On failure: a translatable string changed. Regenerate (see the header)
    // and commit the diff — it is the list translators need to revisit.
    expect(onDisk).toBe(serialized);
  });
});
