/**
 * The three module-resolution lists must agree.
 *
 * `@motion/*` workspace packages are resolved by path mapping in THREE separate
 * places — `tsconfig.json` `paths`, the Jest `moduleNameMapper`, and the Vite
 * `resolve.alias`. Nothing keeps them in step.
 *
 * That asymmetry has a specific failure mode, and it happened: four new packages
 * were added to tsconfig and Jest but not to Vite. `tsc --noEmit` was clean, 4,498
 * tests passed, and the dev server threw `Failed to resolve import
 * "@motion/design-system"` on the first HMR reload. Every verification that
 * *could* catch it was the verification that didn't run.
 *
 * So this reads all three configs as text and compares the sets. It is a
 * deliberately dumb test: parsing the real config modules would mean importing
 * Vite's ESM config into Jest, and the thing being checked is textual anyway.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

const ROOT = join(__dirname, '..', '..', '..');

/** Every `@motion/x` name mentioned in a file. */
function aliasesIn(relPath: string): Set<string> {
  const src = readFileSync(join(ROOT, relPath), 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/@motion\/([a-z-]+)/g)) out.add(m[1]!);
  return out;
}

describe('@motion/* alias lists', () => {
  const tsconfig = aliasesIn('tsconfig.json');
  const jest = aliasesIn('jest.config.cjs');
  const vite = aliasesIn('vite.config.ts');

  it('finds the lists at all (guards the regex)', () => {
    // Vacuous agreement between three empty sets would pass everything below.
    expect(tsconfig.size).toBeGreaterThanOrEqual(6);
    expect(jest.size).toBeGreaterThanOrEqual(6);
    expect(vite.size).toBeGreaterThanOrEqual(6);
  });

  it('Vite resolves every package tsconfig does', () => {
    // This is the direction that broke. tsc and Jest were both complete; only
    // the bundler was missing entries, so nothing in CI noticed.
    const missing = [...tsconfig].filter((p) => !vite.has(p)).sort();
    expect(missing).toEqual([]);
  });

  it('Jest resolves every package tsconfig does', () => {
    const missing = [...tsconfig].filter((p) => !jest.has(p)).sort();
    expect(missing).toEqual([]);
  });

  it('tsconfig resolves every package the other two do', () => {
    const union = new Set([...jest, ...vite]);
    const missing = [...union].filter((p) => !tsconfig.has(p)).sort();
    expect(missing).toEqual([]);
  });

  it('every aliased package actually has the entry point the alias points at', () => {
    // An alias to a path that does not exist fails the same way a missing alias
    // does, just later and with a worse message.
    for (const pkg of tsconfig) {
      const entry = join(ROOT, 'packages', pkg, 'src', 'index.ts');
      expect(`${pkg}: ${statSync(entry, { throwIfNoEntry: false }) ? 'present' : 'MISSING'}`)
        .toBe(`${pkg}: present`);
    }
  });

  it('every package with an index.ts is aliased, or is deliberately not', () => {
    // The other direction: a package nobody can import is either a mistake or a
    // test-only harness. `render-tests` is the latter — it is a suite, not a
    // library, and nothing imports it by name.
    const NOT_A_LIBRARY = new Set(['render-tests']);
    const dirs = readdirSync(join(ROOT, 'packages')).filter((d) =>
      statSync(join(ROOT, 'packages', d), { throwIfNoEntry: false })?.isDirectory(),
    );
    const unaliased = dirs
      .filter((d) => !NOT_A_LIBRARY.has(d) && !tsconfig.has(d))
      .filter((d) => statSync(join(ROOT, 'packages', d, 'src', 'index.ts'), { throwIfNoEntry: false }));
    expect(unaliased).toEqual([]);
  });
});
