/**
 * The uniform benchmark record — what `scripts/bench-check.mjs` ratchets.
 *
 * Every `*.bench.test.ts` keeps writing its own detailed JSON under
 * `.artifacts/bench/<suite>.latest.json` (per-scenario p50/p95, effect tables,
 * whatever that suite finds useful). In ADDITION it hands the headline numbers
 * to `recordBench`, which merges them into `.artifacts/bench/results.json`,
 * one record per metric, in one shape:
 *
 *   { name, metric, unit, value, samples, machine, commit, timestamp }
 *
 * `bench-check` compares that file against the committed `bench/baseline.json`
 * (same shape, plus the machine that produced it) and fails on a regression —
 * direction-aware by unit: `ms` lower is better, `fps` higher is better.
 *
 * Merge, not overwrite: `npm run bench` runs the suites in band, each calling
 * this from its `afterAll`, and a filtered run (`npm run bench -- effectBake`)
 * must not wipe the other suites' rows. `npm run bench` resets the file before
 * the first suite (`bench-check --reset`) so a deleted metric cannot linger.
 *
 * Node-only (fs, os, child_process): benches run under jest, never in the app.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { cpus, platform } from 'os';
import { execSync } from 'child_process';

export interface BenchMachine {
  platform: string;
  cpuModel: string;
  cores: number;
  node: string;
}

export interface BenchRecord {
  /** Suite + scenario, e.g. `buildSnapshot/flat-shapes-2000`. */
  name: string;
  /** What was measured within the scenario, e.g. `buildSnapshot.mean`. */
  metric: string;
  /** `ms` (lower is better), `fps` (higher is better), `count` (informational). */
  unit: 'ms' | 'fps' | 'count';
  value: number;
  /** Timed samples the value was taken over (0 when it is a single count). */
  samples: number;
  machine: BenchMachine;
  commit: string | null;
  timestamp: string;
}

export type BenchMetricInput = Pick<BenchRecord, 'name' | 'metric' | 'unit' | 'value' | 'samples'>;

export const BENCH_DIR = join(process.cwd(), '.artifacts', 'bench');
export const RESULTS_FILE = join(BENCH_DIR, 'results.json');

export function benchMachine(): BenchMachine {
  const list = cpus();
  return {
    platform: platform(),
    cpuModel: (list[0]?.model ?? 'unknown').replace(/\s+/g, ' ').trim(),
    cores: list.length,
    node: process.version,
  };
}

export function gitCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function readResults(): BenchRecord[] {
  if (!existsSync(RESULTS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as BenchRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Merge `metrics` into `results.json`, keyed on `name` + `metric` — a re-run
 * of one suite replaces its own rows and leaves every other suite's alone.
 * Returns the full records written, for the caller's own console table.
 */
export function recordBench(metrics: BenchMetricInput[]): BenchRecord[] {
  const machine = benchMachine();
  const commit = gitCommit();
  const timestamp = new Date().toISOString();
  const fresh: BenchRecord[] = metrics.map((m) => ({
    ...m,
    value: Number.isFinite(m.value) ? +m.value.toFixed(4) : m.value,
    machine,
    commit,
    timestamp,
  }));
  const keyOf = (r: BenchRecord): string => `${r.name}::${r.metric}`;
  const merged = new Map<string, BenchRecord>();
  for (const r of readResults()) merged.set(keyOf(r), r);
  for (const r of fresh) merged.set(keyOf(r), r);
  const out = [...merged.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  mkdirSync(BENCH_DIR, { recursive: true });
  writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
  return fresh;
}
