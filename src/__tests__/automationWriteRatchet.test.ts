/**
 * The B5 ratchet (NATIVE_CORE_PLAN §5 B5, docs/ENGINE_API.md §12 / §15.6).
 *
 * "AI tools, scripts and plugins call the same API." Counts the document
 * writes the automation clients still make AROUND the engine — the AI tool
 * layer (src/core/ai, packages/ai-tools), the plugin host (src/core/plugins),
 * the script host and command-log / CLI tooling — with the B3 rule
 * `engine-writes/no-direct-document-write` (eslint.automation-writes.config.mjs,
 * run by scripts/lint/automationWritesReport.mjs in a child process: ESLint
 * loads its flat config with a native `import()`, which jest's VM lacks).
 * Such a write is not in the command log, so a recorded session that reaches
 * it does not replay exactly (commandLog's `writesAroundEngine`).
 *
 * Fails when any area's count goes UP: new automation code sends engine
 * commands. When a count goes DOWN it passes and says so — lower the committed
 * number (`node scripts/lint/automationWritesReport.mjs --update`).
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
const baseline = JSON.parse(readFileSync(join(__dirname, 'automationWriteRatchet.json'), 'utf8')) as { total: number; areas: Record<string, number> };

function run(): Report {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'lint', 'automationWritesReport.mjs'), '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as Report;
}

test('document writes around the engine in AI / plugin / script code never go up (per area)', () => {
  const report = run();
  // A file the parser could not read would silently count as zero.
  expect(report.fatal).toEqual([]);
  expect(report.files).toBeGreaterThan(50);
  expect(Object.keys(report.areas).sort()).toEqual(Object.keys(baseline.areas).sort());

  const over = Object.entries(report.areas).filter(([area, n]) => n > (baseline.areas[area] ?? 0));
  const under = Object.entries(report.areas).filter(([area, n]) => n < (baseline.areas[area] ?? 0));
  if (under.length > 0) {
    console.info(
      `B5 ratchet: fewer writes around the engine in ${under.map(([a, n]) => `${a} (${baseline.areas[a]} → ${n})`).join(', ')}. ` +
      'Lower src/__tests__/automationWriteRatchet.json: node scripts/lint/automationWritesReport.mjs --update',
    );
  }
  expect(
    over.map(([area, n]) => `${area}: ${n} > ${baseline.areas[area]} — send engine commands instead (docs/ENGINE_API.md §12); ` +
      `list them with: node scripts/lint/automationWritesReport.mjs --list ${area}`),
  ).toEqual([]);
}, 300_000);
