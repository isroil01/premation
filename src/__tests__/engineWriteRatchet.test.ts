/**
 * The B3 ratchet (NATIVE_CORE_PLAN §5 B3, docs/B3_PATTERNS.md).
 *
 * Counts the direct document writes left in UI code — scene graph mutators,
 * animation mutators, timeline controller edits, store writes, the pre-API
 * history helpers, write helpers imported from @core — per area, with the
 * `engine-writes/no-direct-document-write` rule (eslint.engine-writes.config.mjs,
 * run through the ESLint Node API by scripts/lint/engineWritesReport.mjs in a
 * child process: ESLint loads its flat config with a native `import()`, which
 * jest's module VM does not provide).
 *
 * Fails when any area's count goes UP: new UI code sends engine commands.
 * When a count goes DOWN it passes and says so — lower the committed number
 * (`node scripts/lint/engineWritesReport.mjs --update`) so it cannot creep
 * back. B3 is done when every area is 0 and the rule becomes an error.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Report {
  total: number;
  areas: Record<string, number>;
  kinds: Record<string, number>;
  files: number;
  fatal: string[];
}

const root = join(__dirname, '..', '..');
const baseline = JSON.parse(readFileSync(join(__dirname, 'engineWriteRatchet.json'), 'utf8')) as { total: number; areas: Record<string, number> };

function run(): Report {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'lint', 'engineWritesReport.mjs'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as Report;
}

test('direct document writes in UI code never go up (per area)', () => {
  const report = run();
  // A file the parser could not read would silently count as zero.
  expect(report.fatal).toEqual([]);
  expect(report.files).toBeGreaterThan(100);
  expect(Object.keys(report.areas).sort()).toEqual(Object.keys(baseline.areas).sort());

  const over = Object.entries(report.areas).filter(([area, n]) => n > (baseline.areas[area] ?? 0));
  const under = Object.entries(report.areas).filter(([area, n]) => n < (baseline.areas[area] ?? 0));
  if (under.length > 0) {
    console.info(
      `B3 ratchet: fewer direct writes in ${under.map(([a, n]) => `${a} (${baseline.areas[a]} → ${n})`).join(', ')}. ` +
      'Lower src/__tests__/engineWriteRatchet.json: node scripts/lint/engineWritesReport.mjs --update',
    );
  }
  expect(
    over.map(([area, n]) => `${area}: ${n} > ${baseline.areas[area]} — send engine commands instead (docs/B3_PATTERNS.md); ` +
      `list them with: node scripts/lint/engineWritesReport.mjs --list ${area}`),
  ).toEqual([]);
}, 300_000);
