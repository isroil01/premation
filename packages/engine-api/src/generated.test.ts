/**
 * The generated TypeScript and C++ must match the schema. Editing a .eapi file
 * without running `npm run engine-api:gen` fails here (same pattern as the
 * doc-count guard in src/__tests__/docFeatureCounts.test.ts), so the two
 * engines can never be built from different versions of the contract.
 *
 * docs/ENGINE_API.md must also name every command, query and event, so the
 * reference cannot silently fall behind the schema.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMANDS, EVENTS, QUERIES } from './generated/meta';

const gen = require('../codegen/generate.cjs') as {
  loadSchema(): unknown;
  staleFiles(model: unknown): string[];
  parse(files: { name: string; src: string }[]): unknown;
  generateAll(model: unknown): Record<string, string>;
};

describe('engine-api generated files', () => {
  it('are up to date with packages/engine-api/schema (run `npm run engine-api:gen`)', () => {
    expect(gen.staleFiles(gen.loadSchema())).toEqual([]);
  });

  it('rejects schema mistakes instead of generating something wrong', () => {
    const bad = (src: string): (() => unknown) => () => gen.parse([{ name: 'x.eapi', src: `version 1.0; struct Empty {} ${src}` }]);
    expect(bad('struct A { a: u32 = 1; b: u32 = 1; }')).toThrow(/number 1/);
    expect(bad('struct A { a: Nope = 1; }')).toThrow(/unknown type/);
    expect(bad('enum E { a = 1; }')).toThrow(/= 0/);
    expect(bad('struct A { a?: u32[] = 1; }')).toThrow(/optional/);
    expect(bad('command a = 1 {} command b = 1 {}')).toThrow(/number 1/);
    expect(bad('command a = 1 [nope] {}')).toThrow(/attribute/);
    // A by-value cycle parses but has no C++ layout.
    expect(() => gen.generateAll(bad('struct A { b: B = 1; } struct B { a: A = 1; }')())).toThrow(/cycle/);
  });
});

describe('docs/ENGINE_API.md', () => {
  const doc = readFileSync(join(__dirname, '../../../docs/ENGINE_API.md'), 'utf8');
  const missing = (names: string[]): string[] => names.filter((n) => !new RegExp(`\\b${n}\\b`).test(doc));

  it('names every command', () => expect(missing(Object.keys(COMMANDS))).toEqual([]));
  it('names every query', () => expect(missing(Object.keys(QUERIES))).toEqual([]));
  it('names every event', () => expect(missing(Object.keys(EVENTS))).toEqual([]));
});
