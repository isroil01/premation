#!/usr/bin/env node
/**
 * Break sweep for stroke dash offset — one-shot, same shape as symmetrySweep.
 *
 * Rule 2c applies to this too: it aborts if the baseline does not parse, and its
 * positive control is that every break below is expected to be CAUGHT — a run
 * where nothing is caught means the instrument is broken, not the guards.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PATTERN = 'src/core/paint|src/core/rendering|src/layout/Inspector';

const BREAKS = [
  {
    id: 'no-canvas-write',
    file: 'src/core/rendering/raster/vectorDraw.ts',
    from: '  ctx.lineDashOffset = stroke.dashOffset ?? 0;',
    to: '  void stroke.dashOffset; // BREAK',
    what: 'applyStrokeStyle never writes the offset to the canvas',
  },
  {
    id: 'no-snapshot-fold',
    file: 'src/core/rendering/buildSnapshot.ts',
    from: "    if (baseStroke && a?.has('strokeDashOffset')) {\n      finalStroke = { ...baseStroke, dashOffset: a.get('strokeDashOffset') ?? 0 };\n    }",
    to: '    // BREAK: animated offset never folded in',
    what: 'the animated track is sampled by nothing — static offset still works',
  },
  {
    id: 'default-offset-zero',
    file: 'src/core/paint/stroke.ts',
    from: "    ...(Number.isFinite(s.dashOffset) ? { dashOffset: s.dashOffset as number } : {}),",
    to: '    dashOffset: Number.isFinite(s.dashOffset) ? (s.dashOffset as number) : 0, // BREAK',
    what: 'normalise writes dashOffset:0 always, changing every existing cache key',
  },
  {
    id: 'colour-fold-clobbers',
    file: 'src/core/rendering/buildSnapshot.ts',
    from: '      finalStroke = { ...finalStroke, color: Color.toHex({ r, g, b, a: alpha }) };',
    to: '      finalStroke = { ...baseStroke, color: Color.toHex({ r, g, b, a: alpha }) }; // BREAK',
    what: 'the colour fold rebuilds from baseStroke, dropping an animated offset',
  },
  {
    id: 'row-always-shown',
    file: 'src/layout/Inspector/AppearanceSection.tsx',
    from: '                {(stroke?.dash ?? []).length > 0 && (',
    to: '                {true && (',
    what: 'the offset row renders on a solid stroke, where it does nothing',
  },
  {
    id: 'row-writes-wrong-track',
    file: 'src/layout/Inspector/AppearanceSection.tsx',
    from: '                    prop="strokeDashOffset"',
    to: '                    prop={\'fillAngle\' as never}',
    what: 'the row writes a track the renderer does not read for strokes (F34 shape)',
  },
];

function parse(out) {
  const m = /Tests:\s+(?:(\d+) failed,\s+)?(?:(\d+) skipped,\s+)?(\d+) passed,\s+(\d+) total/.exec(out);
  const names = [...out.matchAll(/●\s+(.+?)\s*\n/g)].map((x) => x[1].trim())
    .filter((n) => !/Console|Deprecation/.test(n));
  if (!m) return { failed: null, passed: null, total: null, names, raw: out.slice(-600) };
  return { failed: Number(m[1] ?? 0), passed: Number(m[3]), total: Number(m[4]), names: [...new Set(names)] };
}

function run() {
  const r = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', PATTERN, '--silent'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return parse(String(r.stdout ?? '') + String(r.stderr ?? ''));
}

const base = run();
console.log(`BASELINE: ${base.passed}/${base.total} passed, ${base.failed} failed\n`);
if (base.total === null || base.total === 0) {
  console.error('ABORT: baseline did not parse.\n' + (base.raw ?? ''));
  process.exit(2);
}

let caughtCount = 0;
for (const b of BREAKS) {
  const original = readFileSync(b.file, 'utf8');
  const eol = original.includes('\r\n') ? (t) => t.replace(/\n/g, '\r\n') : (t) => t;
  const from = eol(b.from);
  if (!original.includes(from)) { console.log(`SKIP  ${b.id} — anchor not found\n`); continue; }
  writeFileSync(b.file, original.replace(from, eol(b.to)), 'utf8');
  let r;
  try { r = run(); } finally { writeFileSync(b.file, original, 'utf8'); }
  const verdict = r.total === null ? 'UNPARSED' : r.failed > 0 ? `CAUGHT by ${r.failed}` : 'NOT CAUGHT';
  if (r.failed > 0) caughtCount++;
  console.log(`${verdict.padEnd(16)} ${b.id} — ${b.what}`);
  for (const n of r.names.slice(0, 8)) console.log(`    - ${n}`);
  console.log(`    counts: ${r.passed}/${r.total}` + (r.total !== base.total ? `  ** TOTAL CHANGED from ${base.total} **` : ''));
  console.log();
}
console.log('─'.repeat(70));
console.log(`${caughtCount}/${BREAKS.length} breaks caught.`);
if (caughtCount === 0) {
  console.error('POSITIVE CONTROL FAILED: nothing was caught at all — suspect the instrument.');
  process.exit(3);
}
