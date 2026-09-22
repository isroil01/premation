#!/usr/bin/env node
/**
 * The benchmark ratchet (NATIVE_CORE_PLAN §4 T0).
 *
 *   node scripts/bench-check.mjs                 compare results vs baseline
 *   node scripts/bench-check.mjs --tolerance 25  looser gate (CI runners drift)
 *   node scripts/bench-check.mjs --baseline      rewrite bench/baseline.json
 *   node scripts/bench-check.mjs --reset         clear results.json (npm run bench does this first)
 *
 * Reads `.artifacts/bench/results.json` — the uniform records every
 * `*.bench.test.ts` appends through `src/core/perf/bench/benchRecord.ts` —
 * and the committed `bench/baseline.json`, and compares metric by metric.
 * Direction-aware: `ms` lower is better, `fps` higher is better, `count`
 * is reported but never gates. A metric present in only one of the two files
 * is reported (`new` / `n/a`) and never fails: a filtered run
 * (`npm run bench -- effectBake`) must still check what it ran.
 *
 * Two guards against gating on noise:
 *   --tolerance <pct>   relative slack, default 10 (the plan's number)
 *   --min-abs <ms>      an absolute floor, default 0.05: a metric that moved
 *                       by less than this never counts as a regression, so a
 *                       0.04 → 0.08 ms wobble on a sub-0.1 ms stage is not a 98 %.
 *
 * The baseline carries the machine that produced it. When the current run is
 * from a different CPU the table says so up front — numbers across machines
 * are a hint, not a gate, which is why the CI job starts non-blocking and its
 * baseline should be regenerated from a runner's own artifact before it is
 * flipped (see .github/workflows/ci.yml, job `bench`).
 *
 * Exit 1 on any regression, 0 otherwise.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(REPO, '.artifacts', 'bench', 'results.json');
const BASELINE = join(REPO, 'bench', 'baseline.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
};
const TOLERANCE = Number(opt('tolerance', '10'));
const MIN_ABS = Number(opt('min-abs', '0.05'));
if (!Number.isFinite(TOLERANCE) || TOLERANCE < 0) throw new Error(`bad --tolerance: ${opt('tolerance')}`);
if (!Number.isFinite(MIN_ABS) || MIN_ABS < 0) throw new Error(`bad --min-abs: ${opt('min-abs')}`);

const rel = (p) => relative(process.cwd(), p) || p;

function readJson(path, what) {
  if (!existsSync(path)) {
    console.error(`[bench-check] no ${what} at ${rel(path)}`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

const keyOf = (r) => `${r.name}::${r.metric}`;

/** Lower-is-better / higher-is-better / informational, by unit. */
function direction(unit) {
  if (unit === 'ms' || unit === 'us' || unit === 's') return 'lower';
  if (unit === 'fps' || unit === 'ops') return 'higher';
  return 'none';
}

const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3));
const pct = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((cell, i) => (columns[i].right ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join('  ');
  const out = [line(columns.map((c) => c.label)), line(widths.map((w) => '─'.repeat(w)))];
  for (const r of rows) out.push(line(columns.map((c) => c.get(r))));
  return out.join('\n');
}

// ── --reset ──────────────────────────────────────────────────────────────────
if (flag('reset')) {
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, '[]\n');
  console.log(`[bench-check] reset ${rel(RESULTS)}`);
  process.exit(0);
}

const results = readJson(RESULTS, 'results file (run `npm run bench` first)');
if (!results) process.exit(2);
if (!Array.isArray(results) || results.length === 0) {
  console.error('[bench-check] results.json holds no records — did the benches run?');
  process.exit(2);
}

// ── --baseline ───────────────────────────────────────────────────────────────
if (flag('baseline')) {
  const machine = results[0].machine;
  const doc = {
    // Provenance: the reader must know which machine's numbers these are.
    machine,
    commit: results[0].commit ?? null,
    timestamp: new Date().toISOString(),
    node: process.version,
    note: 'Written by `npm run bench:baseline` from .artifacts/bench/results.json. '
      + 'Compare only against the same machine class; regenerate after an intentional perf change.',
    records: [...results]
      .sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
      .map(({ name, metric, unit, value, samples }) => ({ name, metric, unit, value, samples })),
  };
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`[bench-check] wrote ${doc.records.length} metrics to ${rel(BASELINE)} (${machine.cpuModel}, ${machine.cores} cores, ${machine.platform}, node ${machine.node})`);
  process.exit(0);
}

// ── compare ──────────────────────────────────────────────────────────────────
const baseline = readJson(BASELINE, 'baseline (run `npm run bench:baseline` to create one)');
if (!baseline) process.exit(2);

const base = new Map(baseline.records.map((r) => [keyOf(r), r]));
const cur = new Map(results.map((r) => [keyOf(r), r]));
const machine = results[0].machine;
const sameMachine = machine && baseline.machine
  && machine.cpuModel === baseline.machine.cpuModel && machine.platform === baseline.machine.platform;

const rows = [];
let regressions = 0;
let improvements = 0;
for (const [key, b] of base) {
  const c = cur.get(key);
  if (!c) {
    rows.push({ name: b.name, metric: b.metric, unit: b.unit, base: fmt(b.value), value: '', delta: '', status: 'n/a' });
    continue;
  }
  const dir = direction(b.unit);
  const delta = c.value - b.value;
  const rel = b.value !== 0 ? (delta / b.value) * 100 : (delta === 0 ? 0 : Infinity);
  let status = 'ok';
  if (dir !== 'none' && Math.abs(delta) >= MIN_ABS) {
    const worse = dir === 'lower' ? rel > TOLERANCE : rel < -TOLERANCE;
    const better = dir === 'lower' ? rel < -TOLERANCE : rel > TOLERANCE;
    if (worse) { status = 'REGRESSION'; regressions += 1; }
    else if (better) { status = 'faster'; improvements += 1; }
  } else if (dir === 'none') {
    status = delta === 0 ? 'same' : 'changed';
  }
  rows.push({ name: b.name, metric: b.metric, unit: b.unit, base: fmt(b.value), value: fmt(c.value), delta: pct(rel), status });
}
for (const [key, c] of cur) {
  if (!base.has(key)) rows.push({ name: c.name, metric: c.metric, unit: c.unit, base: '', value: fmt(c.value), delta: '', status: 'new' });
}
rows.sort((a, b) => `${a.name}::${a.metric}`.localeCompare(`${b.name}::${b.metric}`));

console.log(`bench-check — tolerance ${TOLERANCE}% (min-abs ${MIN_ABS}), ${rows.length} metrics`);
console.log(`  baseline: ${baseline.machine?.cpuModel ?? '?'} · ${baseline.machine?.cores ?? '?'} cores · ${baseline.machine?.platform ?? '?'} · node ${baseline.machine?.node ?? '?'} · commit ${baseline.commit ?? '?'} · ${baseline.timestamp ?? '?'}`);
console.log(`  current:  ${machine?.cpuModel ?? '?'} · ${machine?.cores ?? '?'} cores · ${machine?.platform ?? '?'} · node ${machine?.node ?? '?'} · commit ${results[0].commit ?? '?'}`);
if (!sameMachine) {
  console.log('  WARNING: baseline and current run are from DIFFERENT machines — deltas are a hint, not a measurement.');
}
console.log();
console.log(table(rows, [
  { label: 'metric', get: (r) => `${r.name} ${r.metric}` },
  { label: 'unit', get: (r) => r.unit },
  { label: 'baseline', get: (r) => r.base, right: true },
  { label: 'current', get: (r) => r.value, right: true },
  { label: 'delta', get: (r) => r.delta, right: true },
  { label: 'status', get: (r) => r.status },
]));
console.log();
console.log(`${regressions} regression(s), ${improvements} faster, ${rows.filter((r) => r.status === 'new').length} new, ${rows.filter((r) => r.status === 'n/a').length} not run`);
if (regressions > 0) {
  console.log(`\nFAIL: ${regressions} metric(s) regressed by more than ${TOLERANCE}%. If the change is intentional, run \`npm run bench:baseline\` and commit bench/baseline.json.`);
  process.exit(1);
}
