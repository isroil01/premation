#!/usr/bin/env node
/**
 * Compare AI eval artifacts (src/core/ai/author/eval/authorEval.native.test.ts).
 *
 *   node scripts/ai-eval/compare.mjs <dir>              author vs library within one run
 *   node scripts/ai-eval/compare.mjs <dirA> <dirB>      the same mode, run A vs run B (before / after)
 *   … --mode author                                     with two dirs: which mode (default author)
 *   … --json                                            machine-readable instead of a table
 *
 * Reads every `<case>.<mode>.json`, pairs them by case, and prints a markdown
 * table of the judges' means (craft, fit), tool calls and path failures, with
 * the mean of each column and how many cases each side won on judge score.
 * Exit code 0 always: this is a report, not a gate.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function load(dir) {
  const out = new Map();
  for (const f of readdirSync(dir)) {
    const m = /^(.+)\.(author|library)\.json$/.exec(f);
    if (!m) continue;
    try {
      out.set(`${m[1]}.${m[2]}`, JSON.parse(readFileSync(join(dir, f), 'utf8')));
    } catch {
      // A half-written artifact is skipped, not fatal.
    }
  }
  return out;
}

const judge = (a, id) => {
  const v = a?.judges?.find((j) => j.judge === id)?.mean;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const fmt = (v) => (v === null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(2));
const mean = (xs) => {
  const ys = xs.filter((x) => x !== null);
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
};

/** Pair artifacts into rows: { case, a, b }. */
export function pairs(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const modeIdx = argv.indexOf('--mode');
  const mode = modeIdx >= 0 ? argv[modeIdx + 1] : 'author';
  const rows = [];
  if (args.length === 1) {
    const all = load(args[0]);
    const cases = new Set([...all.keys()].map((k) => k.replace(/\.(author|library)$/, '')));
    for (const c of [...cases].sort()) rows.push({ case: c, a: all.get(`${c}.author`), b: all.get(`${c}.library`) });
    return { rows, labels: ['author', 'library'] };
  }
  const A = load(args[0]);
  const B = load(args[1]);
  const cases = new Set([...A.keys(), ...B.keys()].filter((k) => k.endsWith(`.${mode}`)).map((k) => k.replace(/\.(author|library)$/, '')));
  for (const c of [...cases].sort()) rows.push({ case: c, a: A.get(`${c}.${mode}`), b: B.get(`${c}.${mode}`) });
  return { rows, labels: [`A (${mode})`, `B (${mode})`] };
}

export function summarize(rows) {
  const out = rows.map((r) => {
    const aScore = mean([judge(r.a, 'craft'), judge(r.a, 'fit')]);
    const bScore = mean([judge(r.b, 'craft'), judge(r.b, 'fit')]);
    return {
      case: r.case,
      aCraft: judge(r.a, 'craft'), bCraft: judge(r.b, 'craft'),
      aFit: judge(r.a, 'fit'), bFit: judge(r.b, 'fit'),
      aCalls: num(r.a?.toolCalls), bCalls: num(r.b?.toolCalls),
      aFailures: r.a ? (r.a.pathFailures ?? []).length : null, bFailures: r.b ? (r.b.pathFailures ?? []).length : null,
      winner: aScore === null || bScore === null ? null : aScore > bScore ? 'a' : bScore > aScore ? 'b' : 'tie',
    };
  });
  const col = (k) => mean(out.map((r) => r[k]));
  return {
    rows: out,
    means: Object.fromEntries(['aCraft', 'bCraft', 'aFit', 'bFit', 'aCalls', 'bCalls', 'aFailures', 'bFailures'].map((k) => [k, col(k)])),
    wins: { a: out.filter((r) => r.winner === 'a').length, b: out.filter((r) => r.winner === 'b').length, tie: out.filter((r) => r.winner === 'tie').length },
  };
}

function table(s, [la, lb]) {
  const lines = [
    `| case | craft ${la} | craft ${lb} | fit ${la} | fit ${lb} | calls ${la} | calls ${lb} | failures ${la} | failures ${lb} |`,
    '|---|---|---|---|---|---|---|---|---|',
    ...s.rows.map((r) => `| ${r.case} | ${fmt(r.aCraft)} | ${fmt(r.bCraft)} | ${fmt(r.aFit)} | ${fmt(r.bFit)} | ${fmt(r.aCalls)} | ${fmt(r.bCalls)} | ${fmt(r.aFailures)} | ${fmt(r.bFailures)} |`),
    `| **mean** | ${fmt(s.means.aCraft)} | ${fmt(s.means.bCraft)} | ${fmt(s.means.aFit)} | ${fmt(s.means.bFit)} | ${fmt(s.means.aCalls)} | ${fmt(s.means.bCalls)} | ${fmt(s.means.aFailures)} | ${fmt(s.means.bFailures)} |`,
    '',
    `Wins on mean judge score: ${la} ${s.wins.a}, ${lb} ${s.wins.b}, ties ${s.wins.tie}.`,
  ];
  return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  if (!argv.filter((a) => !a.startsWith('--')).length) {
    console.error('usage: node scripts/ai-eval/compare.mjs <dir> [dirB] [--mode author|library] [--json]');
    process.exit(0);
  }
  const { rows, labels } = pairs(argv);
  const s = summarize(rows);
  console.log(argv.includes('--json') ? JSON.stringify(s, null, 2) : table(s, labels));
}
