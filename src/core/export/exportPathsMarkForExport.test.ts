/**
 * Every export path must mark its frames for export.
 *
 * ## Why this is a SOURCE test and not a behavioural one
 *
 * `guideLayers.test.ts` proves the rule: `buildSnapshot` drops guide layers
 * when the comp says the frame is for delivery. Every assertion in that file
 * passes with `exportComp` deleted from all four export call sites, because it
 * builds the flag itself. The rule and the wiring are different claims, and the
 * wiring is the one that fails silently — in the delivered file, which nobody
 * looks at until a client does.
 *
 * A behavioural test of the wiring would need to run an actual export: a real
 * canvas, a real backend, an encoder. That exists (`offlineRenderer.test.ts`)
 * and is a browser test — it cannot run here, and standing up a second copy of
 * it for one boolean would be a lot of machinery for a claim that is, in the
 * end, syntactic. So this reads the source.
 *
 * ## The subject set is DERIVED, which is the whole point
 *
 * It would have been easier to assert against a list of the four known call
 * sites. That is the F25 defect exactly — a guard that enumerates its own
 * subjects only ever checks the subjects someone remembered, and stops covering
 * anything added later while still reporting success. So the file list comes
 * from the directory and the call list comes from the source. A fifth export
 * path is in scope the moment it is written, whether or not anyone updates
 * this file.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { exportComp } from './offlineRenderer';

const EXPORT_DIR = path.join(__dirname);

/** Non-test sources in the export directory — read, never listed by hand. */
function exportSources(): string[] {
  return readdirSync(EXPORT_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
}

/**
 * The argument text of every `buildSnapshot(...)` call in `src`.
 *
 * Balanced-paren scan rather than a regex: the call spans lines and contains
 * nested calls (`exportView(...)`, object literals), so `\(([^)]*)\)` would
 * stop at the first inner `)` and silently read a fragment — a matcher that
 * examines the wrong text is worse than none, because it still goes green.
 */
function buildSnapshotCalls(src: string): string[] {
  const out: string[] = [];
  const needle = 'buildSnapshot(';
  let i = src.indexOf(needle);
  while (i !== -1) {
    // Skip the definition/import, which are not calls.
    const before = src.slice(Math.max(0, i - 20), i);
    if (!/function\s+$/.test(before)) {
      let depth = 0;
      let j = i + needle.length - 1;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') { depth--; if (depth === 0) break; }
      }
      out.push(src.slice(i + needle.length, j));
    }
    i = src.indexOf(needle, i + needle.length);
  }
  return out;
}

describe('export paths mark their frames for export', () => {
  const files = exportSources();

  it('finds the export sources at all', () => {
    // Guards the guard: an empty directory listing would make every assertion
    // below vacuously true, which is the classic way a source test dies.
    expect(files.length).toBeGreaterThan(3);
    expect(files).toContain('offlineRenderer.ts');
    expect(files).toContain('exportManager.ts');
    expect(files).toContain('exportPreview.ts');
  });

  it('finds buildSnapshot calls to check', () => {
    const total = files.reduce(
      (n, f) => n + buildSnapshotCalls(readFileSync(path.join(EXPORT_DIR, f), 'utf8')).length,
      0,
    );
    // Four today. Asserted as a minimum, not an equality — a fifth path should
    // make this file check MORE, not fail for existing.
    expect(total).toBeGreaterThanOrEqual(4);
  });

  it('every buildSnapshot call in the export directory passes exportComp', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(EXPORT_DIR, f), 'utf8');
      buildSnapshotCalls(src).forEach((args, n) => {
        if (!args.includes('exportComp(')) offenders.push(`${f} call #${n + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /**
   * And the paired geometry helper, for the same reason: an export path that
   * forgot `exportView` renders the comp inset by 8% (the backend's preview
   * fallback fit), which is a border on every delivered frame. The two belong
   * together and the failure modes are equally quiet.
   */
  it('every buildSnapshot call in the export directory passes exportView', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(EXPORT_DIR, f), 'utf8');
      buildSnapshotCalls(src).forEach((args, n) => {
        if (!args.includes('exportView(')) offenders.push(`${f} call #${n + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('the scanner itself', () => {
  /** A regex would stop at the first inner `)`; this must not. */
  it('reads a whole call across nested parens and lines', () => {
    const src = 'const s = buildSnapshot(\n  g,\n  a,\n  exportView(w, h, c),\n  exportComp(c),\n);';
    const calls = buildSnapshotCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('exportComp(');
    expect(calls[0]).toContain('exportView(');
  });

  it('does not count the function definition as a call', () => {
    expect(buildSnapshotCalls('export function buildSnapshot(graph: SceneGraph) {}')).toHaveLength(0);
  });

  it('finds several calls in one file', () => {
    expect(buildSnapshotCalls('buildSnapshot(a); buildSnapshot(b(c));')).toHaveLength(2);
  });
});

/**
 * What `exportComp` RETURNS, which the source scan above cannot see.
 *
 * The scan asserts the four call sites mention `exportComp`. It says nothing
 * about what the helper does — and that gap was real: changing its body to
 * `forExport: false` broke NOTHING, because the source test only reads the
 * call and `guideLayers.test.ts` builds its own comp rather than going through
 * the helper. Two guards, both green, neither watching the one line that
 * decides whether guide layers reach a delivered file.
 */
describe('exportComp', () => {
  it('marks the comp for export', () => {
    expect(exportComp({ width: 10, height: 10, background: '#000' }).forExport).toBe(true);
  });

  it('preserves the caller’s comp settings', () => {
    const c = exportComp({ width: 1080, height: 1920, background: '#ffcc00', transparent: true });
    expect(c.width).toBe(1080);
    expect(c.height).toBe(1920);
    expect(c.background).toBe('#ffcc00');
    expect(c.transparent).toBe(true);
  });

  /**
   * The boundary the clean fixture cannot reach: `comp` is optional on every
   * export path. Passing `undefined` through to `buildSnapshot` would have let
   * it substitute its own defaults — and silently kept guide layers, since a
   * comp that was never built cannot carry the flag.
   */
  it('still marks the frame when no comp is supplied', () => {
    const c = exportComp(undefined);
    expect(c.forExport).toBe(true);
    // And it substitutes the same defaults buildSnapshot would have.
    expect(c.width).toBe(1920);
    expect(c.height).toBe(1080);
  });

  /** The caller must not be mutated — these comps are reused across frames. */
  it('does not mutate its argument', () => {
    const input = { width: 10, height: 10, background: '#000' };
    exportComp(input);
    expect('forExport' in input).toBe(false);
  });
});
