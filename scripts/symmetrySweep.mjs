#!/usr/bin/env node
/**
 * Symmetry sweep — which mirror-class defects does `src/core/rig`'s suite see?
 *
 * F33 showed one sign error surviving 188 tests. A sign error is only one thing
 * a suite of symmetric assertions misses; a transposed rotation, a swapped axis
 * pair and an inverted winding are others in the same family. This applies each
 * as a mutation and reports which tests, if any, notice.
 *
 * Not a permanent gate — a one-shot instrument, kept in the tree because the
 * result is a claim about test coverage and someone should be able to re-run it.
 *
 * Usage: node scripts/symmetrySweep.mjs [--pattern src/core/rig]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const PATTERN = process.argv.includes('--pattern')
  ? process.argv[process.argv.indexOf('--pattern') + 1]
  : 'src/core/rig';

/**
 * Each mutation is a SEMANTIC mirror, not a syntax break: the code still
 * compiles and still produces a plausible deformation. That is the whole point —
 * an incoherent break proves nothing about coverage.
 */
const MUTATIONS = [
  {
    id: 'arap-local-theta-sign',
    file: 'src/core/rig/arap.ts',
    from: 'let theta = Math.atan2(s01 - s10, s00 + s11);',
    to: 'let theta = Math.atan2(s10 - s01, s00 + s11);',
    what: 'ARAP local step: mirror the fitted rotation (this is F33 itself)',
  },
  {
    id: 'arap-global-transpose',
    file: 'src/core/rig/arap.ts',
    from: '          rbx += w * 0.5 * (cs * ex - sn * ey);\n          rby += w * 0.5 * (sn * ex + cs * ey);',
    to: '          rbx += w * 0.5 * (cs * ex + sn * ey);\n          rby += w * 0.5 * (-sn * ex + cs * ey);',
    what: 'ARAP global step (Cholesky branch): transpose R — apply R^T instead of R',
  },
  {
    id: 'lbs-pin-rotation-sign',
    file: 'src/core/rig/puppet.ts',
    from: '      cosR[p] = Math.cos(rot * DEG_TO_RAD) * scl;\n      sinR[p] = Math.sin(rot * DEG_TO_RAD) * scl;',
    to: '      cosR[p] = Math.cos(rot * DEG_TO_RAD) * scl;\n      sinR[p] = -Math.sin(rot * DEG_TO_RAD) * scl;',
    what: 'deformLbs: mirror every pin rotation (advanced pins turn backwards)',
  },
  {
    id: 'lbs-axis-swap',
    file: 'src/core/rig/puppet.ts',
    from: '    deformedVertices[i * 4 + 0] = vx + dispX;\n    deformedVertices[i * 4 + 1] = vy + dispY;',
    to: '    deformedVertices[i * 4 + 0] = vx + dispY;\n    deformedVertices[i * 4 + 1] = vy + dispX;',
    what: 'deformLbs: swap the displacement axis pair (x displacement drives y)',
  },
  {
    id: 'uv-transpose',
    file: 'src/core/rig/puppet.ts',
    from: '    vertices[i * 4 + 2] = (v.x + halfW + pad) / (width + 2 * pad);\n    vertices[i * 4 + 3] = (v.y + halfH + pad) / (height + 2 * pad);',
    to: '    vertices[i * 4 + 2] = (v.y + halfH + pad) / (height + 2 * pad);\n    vertices[i * 4 + 3] = (v.x + halfW + pad) / (width + 2 * pad);',
    what: 'silhouette mesh: transpose UVs — texture mapped sideways onto the mesh',
  },
  {
    id: 'winding-reversed',
    file: 'src/core/rig/mesh.ts',
    from: '      tris.push([ia, ib, ic]);',
    to: '      tris.push([ic, ib, ia]);',
    what: 'earClip: reverse triangle winding (front faces become back faces)',
  },
  {
    id: 'overlap-depth-order',
    file: 'src/core/rig/puppet.ts',
    from: '  order.sort((a, b) => (key[a]! - key[b]!) || (a - b));',
    to: '  order.sort((a, b) => (key[b]! - key[a]!) || (a - b));',
    what: 'sortTrianglesByDepth: invert draw order — behind is painted in front',
  },
];

function runSuite() {
  // stdout AND stderr, always: jest prints the run summary to STDERR, so a
  // stdout-only capture parses to null on a PASSING run and reports every
  // mutation as "not caught". Exactly the failure this script exists to find,
  // in the script itself.
  // jest's JS entry via node, NOT `npx jest`: execFileSync cannot launch a
  // .cmd shim on Windows without a shell, and the failure mode is silent —
  // status null, empty stdout, empty stderr — which parses to "0 failed" and
  // reports every mutation as NOT CAUGHT. A dead instrument that agrees with
  // the hypothesis it was built to test.
  // spawnSync, not execFileSync: on SUCCESS execFileSync returns stdout only,
  // and jest writes its run summary to STDERR — so a passing run yielded zero
  // bytes, parsed to null, and every mutation came back "NOT CAUGHT". The
  // instrument agreed with the hypothesis it was built to test, for a reason
  // that had nothing to do with the hypothesis. spawnSync surfaces both streams
  // whatever the exit status.
  const r = spawnSync(
    process.execPath,
    ['node_modules/jest/bin/jest.js', PATTERN, '--silent'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return parse(String(r.stdout ?? '') + String(r.stderr ?? ''));
}

/** Match the file's own line endings — these sources are CRLF on Windows. */
function toFileEol(text, sample) {
  return sample.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

function parse(out) {
  const m = /Tests:\s+(?:(\d+) failed,\s+)?(?:(\d+) skipped,\s+)?(\d+) passed,\s+(\d+) total/.exec(out);
  const names = [...out.matchAll(/●\s+(.+?)\s*\n/g)].map((x) => x[1].trim())
    .filter((n) => !/Console|Deprecation/.test(n));
  const suiteErr = /Test suite failed to run/.test(out);
  if (!m) return { failed: null, passed: null, total: null, names, suiteErr, raw: out.slice(-800) };
  return {
    failed: Number(m[1] ?? 0), passed: Number(m[3]), total: Number(m[4]),
    names: [...new Set(names)], suiteErr,
  };
}

const baseline = runSuite();
console.log(`BASELINE  ${PATTERN}: ${baseline.passed}/${baseline.total} passed, ${baseline.failed} failed\n`);
// Refuse to report anything if the baseline did not parse. "NOT CAUGHT" from an
// instrument that cannot read its own output is not a measurement.
if (baseline.total === null || baseline.total === 0) {
  console.error('ABORT: baseline did not parse or ran no tests. Raw tail:\n' + (baseline.raw ?? ''));
  process.exit(2);
}

const results = [];
for (const mut of MUTATIONS) {
  const original = readFileSync(mut.file, 'utf8');
  const from = toFileEol(mut.from, original);
  const to = toFileEol(mut.to, original);
  if (!original.includes(from)) {
    console.log(`SKIP  ${mut.id} — anchor not found in ${mut.file}`);
    results.push({ ...mut, status: 'anchor-missing' });
    continue;
  }
  writeFileSync(mut.file, original.replace(from, to), 'utf8');
  let r;
  try {
    r = runSuite();
  } finally {
    writeFileSync(mut.file, original, 'utf8');
  }
  const caught = r.total === null ? 'UNPARSED (instrument dead)' : r.suiteErr ? 'COMPILE-ERROR (incoherent)' : r.failed > 0 ? `CAUGHT by ${r.failed}` : 'NOT CAUGHT';
  console.log(`${caught.padEnd(24)} ${mut.id}`);
  console.log(`    ${mut.what}`);
  if (r.failed > 0) for (const n of r.names.slice(0, 6)) console.log(`      - ${n}`);
  console.log(`    counts: ${r.passed}/${r.total} passed, ${r.failed} failed` +
              (r.total !== baseline.total ? `  ** TOTAL CHANGED from ${baseline.total} **` : ''));
  console.log();
  results.push({ ...mut, failed: r.failed, total: r.total, names: r.names });
}

const blind = results.filter((r) => r.failed === 0 && r.status !== 'anchor-missing');
console.log('─'.repeat(72));
console.log(`${blind.length} of ${results.length} mirror-class mutations pass the suite unnoticed:`);
for (const b of blind) console.log(`  · ${b.id} — ${b.what}`);
