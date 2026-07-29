/**
 * F2 regression, in two halves:
 *
 *  1. the purge actually removes what earlier builds wrote, and
 *  2. **nothing in the tree writes a credential to `localStorage` again.**
 *
 * (2) is the part that matters long-term. The spec asked for an ESLint rule, but
 * this repo has no ESLint config and no `eslint` dependency — `npm run lint` is
 * a dead script, so a rule added there would never run. A source-scanning test
 * does run, on every `npm test`, which is the point of the guard.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { purgeLegacyLocalAiKeys } from './purgeLocalKeys';

describe('purgeLegacyLocalAiKeys', () => {
  beforeEach(() => localStorage.clear());

  it('removes the exact legacy mirror keys', () => {
    localStorage.setItem('motion_editor_local_ai_key_anthropic', 'sk-ant-real-secret');
    localStorage.setItem('motion_editor_local_ai_key_openai', 'sk-real-secret');

    const { removed } = purgeLegacyLocalAiKeys();

    expect(removed).toHaveLength(2);
    expect(localStorage.getItem('motion_editor_local_ai_key_anthropic')).toBeNull();
    expect(localStorage.getItem('motion_editor_local_ai_key_openai')).toBeNull();
  });

  it('also removes differently-named secrets — a plugin key, a stale token', () => {
    localStorage.setItem('some_plugin_api_key', 'x');
    localStorage.setItem('refresh_token', 'y');
    localStorage.setItem('vendor_secret', 'z');

    purgeLegacyLocalAiKeys();

    expect(localStorage.getItem('some_plugin_api_key')).toBeNull();
    expect(localStorage.getItem('refresh_token')).toBeNull();
    expect(localStorage.getItem('vendor_secret')).toBeNull();
  });

  it('leaves ordinary preferences alone — this must not wipe the workspace', () => {
    localStorage.setItem('motion_editor_theme', 'dark');
    localStorage.setItem('motion_editor_panel_layout', '{"a":1}');
    localStorage.setItem('motion_editor_keyframe_snap', 'true');

    purgeLegacyLocalAiKeys();

    expect(localStorage.getItem('motion_editor_theme')).toBe('dark');
    expect(localStorage.getItem('motion_editor_panel_layout')).toBe('{"a":1}');
    expect(localStorage.getItem('motion_editor_keyframe_snap')).toBe('true');
  });

  it('is idempotent and never removes values it did not match', () => {
    localStorage.setItem('motion_editor_theme', 'dark');
    expect(purgeLegacyLocalAiKeys().removed).toEqual([]);
    expect(purgeLegacyLocalAiKeys().removed).toEqual([]);
    expect(localStorage.length).toBe(1);
  });
});

// ── The standing guard ────────────────────────────────────────────────────────

/** `localStorage.setItem('…key…', …)` / `sessionStorage`, in one statement. */
const SECRET_WRITE =
  /(?:local|session)Storage\s*\.\s*setItem\s*\(\s*[`'"][^`'"]*(?:api[_-]?key|apikey|_key_|secret|token|password)[^`'"]*[`'"]/i;
/** The template-literal form the old bug actually used. */
const SECRET_WRITE_TEMPLATE =
  /(?:local|session)Storage\s*\.\s*setItem\s*\(\s*`[^`]*(?:api[_-]?key|apikey|_key_|secret|token|password)/i;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-electron') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe('no plaintext credentials in web storage (F2 guard)', () => {
  it('no source file writes a secret-shaped key to localStorage/sessionStorage', () => {
    const root = join(__dirname, '..', '..');
    const offenders: string[] = [];

    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, 'utf8');
      // Fast reject — most files never touch web storage at all.
      if (!src.includes('Storage.setItem') && !src.includes('Storage .setItem')) continue;
      for (const [i, line] of src.split('\n').entries()) {
        // Comments describing the old bug are not the old bug. Only real code
        // counts, or this file's own docstring trips its own guard.
        if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) continue;
        if (SECRET_WRITE.test(line) || SECRET_WRITE_TEMPLATE.test(line)) {
          offenders.push(`${file.replace(root, 'src')}:${i + 1}  ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
