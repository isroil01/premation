/**
 * A retired claim must not come back in ANY `.md`.
 *
 * `EDITOR_REFERENCE.md` §5 is a ledger of claims this repo has corrected, and it
 * exists so a superseded statement is not rediscovered from git history and
 * believed a second time. It failed on its first test: §5 retired "lighting is a
 * flat per-quad multiplier" on 2026-08-10, and the sentence was live the next
 * day in `CAMERA_SYSTEM.md` §8.2 — because §5 is a ledger inside ONE document
 * and the claim had been copied into another.
 *
 * `docFeatureCounts.test.ts` already pins the §1 count TABLE, and it is scoped
 * to that one file — which is exactly why "58 effects" survived in `README.md`
 * and `ROADMAP.md` while the registry held 73. This test is the prose half, and
 * it is repo-wide on purpose.
 *
 * ## What this can and cannot do
 *
 * A retired claim is a STRING, and a string is testable. That makes this the one
 * part of documentation accuracy that can be pinned; prose in general still
 * rots, and no test fixes that. Keep the entries narrow and quotable — a pattern
 * loose enough to match honest new prose will be deleted by whoever it blocks,
 * and then it guards nothing.
 *
 * ## Adding a row
 *
 * Every new §5 row gets an entry here, in the same commit. That is the whole
 * maintenance contract.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO = join(__dirname, '../..');

/**
 * The ledger itself is exempt: §5 QUOTES each retired claim in order to retire
 * it, so matching there is correct behaviour, not drift. Everything else in the
 * repo's own documentation is in scope.
 */
const EXEMPT_FILES = ['docs/EDITOR_REFERENCE.md'];

/**
 * Vendored/third-party markdown. Not ours to police, and its vocabulary
 * ("curated", "cosmetic") collides with ours in unrelated senses.
 */
const EXEMPT_DIRS = ['node_modules', '.git', 'dist', 'dist-electron', '.agents', '.claude', '.gemini', 'coverage'];

interface RetiredClaim {
  /** What the repo used to assert. */
  readonly claim: string;
  /** Why it is wrong now, shown in the failure so the fix is obvious. */
  readonly reality: string;
  /** Narrow, quotable fragments. A hit on ANY of them fails. */
  readonly patterns: readonly RegExp[];
}

/**
 * One entry per retired §5 row.
 *
 * Deliberately NOT included: "no DOF code in `packages/renderer`". §5 lists it
 * under the 2026-08-10 pass as **"Still true. Retained, not corrected"** — it is
 * a verified claim that happens to sit in a corrections table, and guarding
 * against it would forbid documents from stating a fact.
 */
export const RETIRED_CLAIMS: readonly RetiredClaim[] = [
  {
    claim: 'Lighting is a flat per-quad multiplier with no gradient across a layer',
    reality:
      'Per-fragment Lambert + Blinn-Phong ship on the depth-tested path (builtin.ts `fn shade3d`); per-quad `quadGain` (FrameScene.ts) is the FALLBACK. Extrusion is shaded per face.',
    patterns: [
      /per-quad flat multiplier/i,
      /flat per-quad multiplier/i,
      /lighting is (a )?per-quad/i,
      /no gradient across (a |the )?large layer/i,
    ],
  },
  {
    claim: 'Templates support data binding',
    reality:
      'Does not exist: zero hits repo-wide for dataBinding / dataSource / csvBind. Describing it as PLANNED is fine; describing it as shipped is not.',
    // Narrow on purpose. `TEMPLATE_DATA_BINDING_SCOPE.md` — a doc headed
    // "Nothing here is built" — legitimately writes "Data binding is therefore
    // not a new mechanism", and `COMPOSITING_PLAN.md` legitimately schedules it.
    // Only an assertion that it already EXISTS is retired.
    patterns: [
      /templates?[^.]{0,60}(includes?|supports?)[^.]{0,40}data binding/i,
      /data binding[^.]{0,40}(complete and tested|already (ships|exists)|is shipped)/i,
    ],
  },
  {
    claim: 'There is no 3D gizmo snapping — the switch is wired to nothing',
    reality: 'Already deleted, and kept deleted by deadLayoutState.test.ts.',
    patterns: [/no 3D gizmo snapping/i, /gizmo snapping[^.]{0,40}wired to nothing/i],
  },
  {
    claim: 'The SQLite local index exists and is tested',
    reality:
      'Half true, and the load-bearing half was wrong: the version store is real, `LocalIndex` is an interface with no implementation. better-sqlite3 is not a dependency, so `index:available` is permanently false.',
    patterns: [/SQLite local index and version store both exist/i, /LocalIndex[^.]{0,40}(implemented|exists and is tested)/i],
  },
  {
    claim: 'Expressions are a small curated API of ~18 functions',
    reality: '~50 identifiers, including velocityAtTime, key(n) and numKeys, so the AE bounce/inertia idiom ports as-is.',
    patterns: [/~?18 functions/i, /curated (expression|API)[^.]{0,30}18/i],
  },
  {
    claim: 'There is an easing-preset registry',
    reality: 'There is none. Bezier handles + Easy Ease assistants; BOUNCE_EASE is one cubic-bezier and cannot express a decaying bounce.',
    patterns: [/easing[- ]preset registry/i],
  },
  {
    claim: 'The transparency checkerboard is missing',
    reality: 'It existed as a full-bleed `.stageTransparent`, now clipped to the comp rect.',
    patterns: [/checkerboard[^.]{0,30}(is |was )?(missing|not built|unbuilt|does not exist)/i],
  },
  {
    claim: 'Layer label colours are unbuilt',
    reality: 'They ship: a 12-entry palette on `custom.labelColor`, persisted through sceneProjectIO, read by Scene rows, timeline headers and clip bars.',
    patterns: [/label colou?rs? (are|is) (unbuilt|not built|missing)/i],
  },
  {
    claim: 'SelectionPass draws the selection chrome',
    reality:
      'DELETED 2026-08-12. It drew `scene.selection`, which `snapshotToFrameScene` set to `[]` unconditionally, so it could never draw. The outline and handles are — and always were — 2D-canvas overlay chrome in useWorkspace.ts. The `selection` field is gone from FrameScene too.',
    patterns: [/SelectionPass draws/i, /SelectionPass[^.]{0,40}renders the (selection|outline)/i],
  },
  {
    claim: 'The camera orbit/pan/dolly tools are missing or keyboard-only',
    reality:
      'They ship as a visible toolbar cluster (SceneControls.tsx CAMERA_TOOLS) plus the C-key cycle, and are keyframe-aware through applyNodePropsKeyframed.',
    patterns: [/camera tools[^.]{0,40}(missing|do not exist|keyboard-only)/i, /no camera (orbit|navigation) tools/i],
  },
];

/** Every `.md` in the repo that is ours to police. */
function ourMarkdown(dir = REPO, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXEMPT_DIRS.includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) ourMarkdown(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

const rel = (f: string): string => relative(REPO, f).split(sep).join('/');

describe('retired documentation claims', () => {
  const files = ourMarkdown().filter((f) => !EXEMPT_FILES.includes(rel(f)));

  it('finds markdown to check (a silent zero would pass forever)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('exempts the ledger itself, which necessarily quotes what it retires', () => {
    expect(files.map(rel)).not.toContain('docs/EDITOR_REFERENCE.md');
  });

  for (const entry of RETIRED_CLAIMS) {
    it(`is not restated: "${entry.claim}"`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of entry.patterns) {
          const hit = text.match(pattern);
          if (!hit) continue;
          const line = text.slice(0, hit.index ?? 0).split('\n').length;
          offenders.push(`${rel(file)}:${line} — "${hit[0]}"`);
        }
      }
      // Thrown rather than passed as a second `expect` argument: that form is
      // Vitest's, and Jest rejects it with "Expect takes at most one argument"
      // — which would fail every row for the wrong reason and read as drift.
      if (offenders.length > 0) {
        throw new Error(
          `Retired claim restated: "${entry.claim}"\n` +
            `  Reality: ${entry.reality}\n` +
            `  Found at:\n    ${offenders.join('\n    ')}\n` +
            `  Fix the document. If the claim has become TRUE again, delete its row here ` +
            `and correct EDITOR_REFERENCE.md §5 in the same commit.`,
        );
      }
      expect(offenders).toEqual([]);
    });
  }
});
