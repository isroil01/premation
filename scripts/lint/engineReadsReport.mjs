#!/usr/bin/env node
// The B4 ratchet report: runs `engine-reads/no-direct-document-read`
// (eslint.engine-reads.config.mjs) over the UI through the ESLint Node API
// and counts the remaining direct engine reads per area.
//
//   node scripts/lint/engineReadsReport.mjs            table
//   node scripts/lint/engineReadsReport.mjs --check    table; exit 1 if an area is ABOVE
//                                                      src/__tests__/engineReadRatchet.json
//   node scripts/lint/engineReadsReport.mjs --json     machine-readable (the jest ratchet)
//   node scripts/lint/engineReadsReport.mjs --update   write today's counts to the JSON
//                                                      (only after migrating — never to hide an increase)
//   node scripts/lint/engineReadsReport.mjs --list <area>   every flagged site in one area
//   node scripts/lint/engineReadsReport.mjs --files <area>  per-file counts in one area

import { ESLint } from 'eslint';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, areaOf } from './engineWritesRule.mjs';
import { ENGINE_READ_SCOPES } from '../../eslint.engine-reads.config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASELINE = resolve(root, 'src/__tests__/engineReadRatchet.json');
const RULE = 'engine-reads/no-direct-document-read';

export async function collect() {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: resolve(root, 'eslint.engine-reads.config.mjs'),
    cache: false,
    errorOnUnmatchedPattern: false,
  });
  const results = await eslint.lintFiles(ENGINE_READ_SCOPES);
  const areas = Object.fromEntries(AREAS.map(([name]) => [name, 0]));
  const kinds = {};
  const sites = [];
  const fatal = [];
  for (const r of results) {
    const rel = relative(root, r.filePath).replace(/\\/g, '/');
    for (const m of r.messages) {
      if (m.fatal) { fatal.push(`${rel}:${m.line} ${m.message}`); continue; }
      if (m.ruleId !== RULE) continue;
      const area = areaOf(rel);
      areas[area] += 1;
      const kind = /\(([^:]+):/.exec(m.message)?.[1] ?? '?';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      const what = /\([^:]+: (.+)\) — /.exec(m.message)?.[1] ?? '';
      sites.push({ area, file: rel, line: m.line, kind, what });
    }
  }
  const total = Object.values(areas).reduce((a, b) => a + b, 0);
  return { total, areas, kinds, sites, files: results.length, fatal };
}

function readBaseline() {
  return JSON.parse(readFileSync(BASELINE, 'utf8'));
}

function table(report, baseline) {
  const lines = [];
  lines.push(`B4 ratchet — direct engine reads left in UI code (${report.files} files)`);
  for (const [name] of AREAS) {
    const now = report.areas[name];
    const was = baseline?.areas?.[name];
    const delta = was === undefined ? '' : now > was ? `  ▲ +${now - was} (over the ratchet)` : now < was ? `  ▼ ${now - was} (lower the ratchet)` : '';
    lines.push(`  ${name.padEnd(24)} ${String(now).padStart(5)}${was !== undefined ? ` / ${was}` : ''}${delta}`);
  }
  lines.push(`  ${'total'.padEnd(24)} ${String(report.total).padStart(5)}${baseline ? ` / ${baseline.total}` : ''}`);
  lines.push('  by kind: ' + Object.entries(report.kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const report = await collect();
  if (report.fatal.length) {
    console.error('Parse errors (the ratchet cannot count these files):\n  ' + report.fatal.join('\n  '));
    process.exitCode = 2;
  }
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ total: report.total, areas: report.areas, kinds: report.kinds, files: report.files, fatal: report.fatal }));
    return;
  }
  const listAt = args.indexOf('--list');
  if (listAt >= 0) {
    const area = args[listAt + 1];
    for (const s of report.sites.filter((x) => !area || x.area === area)) {
      console.log(`${s.file}:${s.line}\t${s.kind}\t${s.what}`);
    }
    return;
  }
  const filesAt = args.indexOf('--files');
  if (filesAt >= 0) {
    const area = args[filesAt + 1];
    const per = new Map();
    for (const s of report.sites.filter((x) => !area || x.area === area)) per.set(s.file, (per.get(s.file) ?? 0) + 1);
    for (const [f, n] of [...per].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)} ${f}`);
    return;
  }
  if (args.includes('--update')) {
    const out = { comment: 'B4 ratchet (docs/B4_MIRROR.md). Counts may only go DOWN; lower them with `node scripts/lint/engineReadsReport.mjs --update` after moving reads onto the document mirror.', total: report.total, areas: report.areas };
    writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
    console.log(table(report, out));
    return;
  }
  let baseline = null;
  try { baseline = readBaseline(); } catch { /* first run */ }
  console.log(table(report, baseline));
  if (args.includes('--check') && baseline) {
    const over = AREAS.map(([n]) => n).filter((n) => report.areas[n] > (baseline.areas[n] ?? 0));
    if (over.length) {
      console.error(`\nB4 ratchet: direct engine reads went UP in ${over.join(', ')}. UI code reads the document mirror (docs/B4_MIRROR.md).`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 2;
  });
}
