#!/usr/bin/env node
/**
 * Break sweep for rig controllers.
 *
 * Rule 2c: aborts if the baseline does not parse, and refuses to report success
 * if NOTHING is caught — a sweep that catches nothing is a broken instrument
 * until proven otherwise.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PATTERN = 'src/core/rig';
const BREAKS = [
  {
    id: 'ignore-offset',
    file: 'src/core/rig/controllers.ts',
    from: '  return { x: base.x + (controller.offsetX ?? 0), y: base.y + (controller.offsetY ?? 0) };',
    to: '  return { x: base.x, y: base.y }; // BREAK',
    what: 'controllerPosition drops the offset — the handle sits on the joint',
  },
  {
    id: 'swap-link-kinds',
    file: 'src/core/rig/controllers.ts',
    from: "    controller.link.kind === 'ikTarget'",
    to: "    controller.link.kind === 'bone' // BREAK",
    what: 'an IK controller reads the bone matrix and vice versa',
  },
  {
    id: 'dangling-draws-at-origin',
    file: 'src/core/rig/controllers.ts',
    from: '  if (!base) return null;',
    to: '  if (!base) return { x: 0, y: 0 }; // BREAK',
    what: 'a dangling link places at the origin instead of nowhere',
  },
  {
    id: 'bone-delete-orphans-controllers',
    file: 'src/core/rig/skeletonCommands.ts',
    from: '    ...(skel.controllers\n      ? { controllers: skel.controllers.filter((c) => c.link.boneId !== boneId) }\n      : {}),',
    to: '    // BREAK: controllers survive their bone',
    what: 'deleting a bone leaves controllers driving a bone that is gone',
  },
  {
    id: 'normalise-writes-zero-offset',
    file: 'src/core/rig/controllers.ts',
    from: '    ...(Number.isFinite(c.offsetX) && c.offsetX !== 0 ? { offsetX: c.offsetX as number } : {}),',
    to: '    offsetX: Number.isFinite(c.offsetX) ? (c.offsetX as number) : 0, // BREAK',
    what: 'a zero offset is stored rather than omitted',
  },
  {
    id: 'record-pose-uses-after-as-before',
    file: 'src/core/rig/skeletonCommands.ts',
    from: '    .push(new SkeletonEditCommand(nodeId, before, after, label));',
    to: '    .push(new SkeletonEditCommand(nodeId, after, after, label)); // BREAK',
    what: 'a posed gesture undoes to itself — undo does nothing',
  },
];

function parse(out) {
  const m = /Tests:\s+(?:(\d+) failed,\s+)?(?:(\d+) skipped,\s+)?(\d+) passed,\s+(\d+) total/.exec(out);
  const names = [...out.matchAll(/●\s+(.+?)\s*\n/g)].map((x) => x[1].trim()).filter((n) => !/Console|Deprecation/.test(n));
  if (!m) return { failed: null, passed: null, total: null, names, raw: out.slice(-600) };
  return { failed: Number(m[1] ?? 0), passed: Number(m[3]), total: Number(m[4]), names: [...new Set(names)] };
}
const run = () => {
  const r = spawnSync(process.execPath, ['node_modules/jest/bin/jest.js', PATTERN, '--silent'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return parse(String(r.stdout ?? '') + String(r.stderr ?? ''));
};

const base = run();
console.log(`BASELINE: ${base.passed}/${base.total} passed, ${base.failed} failed\n`);
if (!base.total) { console.error('ABORT: baseline did not parse.\n' + (base.raw ?? '')); process.exit(2); }

let caught = 0;
for (const b of BREAKS) {
  const original = readFileSync(b.file, 'utf8');
  const eol = original.includes('\r\n') ? (t) => t.replace(/\n/g, '\r\n') : (t) => t;
  const from = eol(b.from);
  if (!original.includes(from)) { console.log(`SKIP  ${b.id} — anchor not found\n`); continue; }
  writeFileSync(b.file, original.replace(from, eol(b.to)), 'utf8');
  let r;
  try { r = run(); } finally { writeFileSync(b.file, original, 'utf8'); }
  const verdict = r.total === null ? 'UNPARSED' : r.failed > 0 ? `CAUGHT by ${r.failed}` : 'NOT CAUGHT';
  if (r.failed > 0) caught++;
  console.log(`${verdict.padEnd(16)} ${b.id} — ${b.what}`);
  for (const n of r.names.slice(0, 6)) console.log(`    - ${n}`);
  console.log(`    counts: ${r.passed}/${r.total}` + (r.total !== base.total ? `  ** TOTAL CHANGED from ${base.total} **` : ''));
  console.log();
}
console.log('─'.repeat(70));
console.log(`${caught}/${BREAKS.length} caught.`);
if (caught === 0) { console.error('POSITIVE CONTROL FAILED: nothing caught — suspect the instrument.'); process.exit(3); }
