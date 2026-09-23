/**
 * The B4 ratchet (NATIVE_CORE_PLAN §5 B4, docs/B4_MIRROR.md).
 *
 * Counts the places UI code still reads the TypeScript engine's internals —
 * scene graph, animation engine, timeline controller, document stores, the
 * legacy revision plumbing, helpers from @core modules that read those — per
 * area, with the `engine-reads/no-direct-document-read` rule
 * (eslint.engine-reads.config.mjs, run through the ESLint Node API by
 * scripts/lint/engineReadsReport.mjs in a child process).
 *
 * Fails when any area's count goes UP: new UI code reads the document mirror.
 * When a count goes DOWN it passes and says so — lower the committed number
 * (`node scripts/lint/engineReadsReport.mjs --update`) so it cannot creep
 * back. B4's exit: `inspector`, `text`, `effects` and `timeline` at 0.
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
const baseline = JSON.parse(readFileSync(join(__dirname, 'engineReadRatchet.json'), 'utf8')) as { total: number; areas: Record<string, number> };

function run(): Report {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'lint', 'engineReadsReport.mjs'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as Report;
}

test('direct engine reads in UI code never go up (per area)', () => {
  const report = run();
  expect(report.fatal).toEqual([]);
  expect(report.files).toBeGreaterThan(100);
  expect(Object.keys(report.areas).sort()).toEqual(Object.keys(baseline.areas).sort());

  const over = Object.entries(report.areas).filter(([area, n]) => n > (baseline.areas[area] ?? 0));
  const under = Object.entries(report.areas).filter(([area, n]) => n < (baseline.areas[area] ?? 0));
  if (under.length > 0) {
    console.info(
      `B4 ratchet: fewer direct reads in ${under.map(([a, n]) => `${a} (${baseline.areas[a]} → ${n})`).join(', ')}. ` +
      'Lower src/__tests__/engineReadRatchet.json: node scripts/lint/engineReadsReport.mjs --update',
    );
  }
  expect(
    over.map(([area, n]) => `${area}: ${n} > ${baseline.areas[area]} — read the document mirror instead (docs/B4_MIRROR.md); ` +
      `list them with: node scripts/lint/engineReadsReport.mjs --list ${area}`),
  ).toEqual([]);
}, 300_000);
