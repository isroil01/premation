/**
 * G1 — every field folded into the content hash must have a reader in the
 * pixel path.
 *
 * WHY THIS EXISTS. `contentHash` is the VectorRasterizer's cache key: same
 * content ⇒ same texture. A field that is hashed but that nothing downstream
 * reads is strictly WORSE than a field that was never added — changing it
 * invalidates the cached texture and forces a re-rasterize that produces a
 * byte-identical image. The user flips a switch, the editor does visible work,
 * and nothing changes.
 *
 * That is exactly what per-layer `quality` (AE's Draft/Best sampling switch)
 * did: stored on `fx`, carried into the snapshot, folded into this hash, and
 * read by no rasterizer. Its own docstring asserted "the renderer reads it to
 * toggle `imageSmoothingEnabled`" — every such site in the repo hardcodes
 * `true`. The contract was written in a comment instead of enforced, so it
 * drifted and nobody noticed.
 *
 * This test is that enforcement. It parses `contentHash.ts` itself rather than
 * carrying its own copy of the field list, so a field added to the hash is
 * enrolled here automatically and cannot be forgotten.
 *
 * HOW A FIELD PASSES. Some source file in `PIXEL_PATH` must contain a dot-access
 * read of it (`.foo`). Dot-access is the discriminator that makes this useful:
 * an object-literal WRITE is `foo:` or shorthand `foo,` with no dot, so the
 * snapshot builder populating a field does not count as consuming it. Reads
 * inside `buildSnapshot` DO count — some fields (`assetId` feeding
 * `rigCoverageMask`) legitimately affect pixels there and nowhere later.
 *
 * IF THIS FAILS you have added a field to the content hash that nothing renders
 * from. Two honest fixes: implement the reader, or drop the field from
 * `contentOf`. Do not add it to an exception list — there isn't one, deliberately.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const CONTENT_HASH_SRC = resolve(__dirname, '../contentHash.ts');

/**
 * Where a RenderLayer legitimately turns into pixels. Kept explicit rather than
 * "everything under src/": a `.quality` read in the STORE that owns the setter
 * would satisfy a repo-wide search while proving nothing about rendering, which
 * is the precise mistake this test exists to catch.
 */
const PIXEL_PATH = [
  'src/core/rendering/raster',
  'src/core/rendering/snapshotToFrameScene.ts',
  'src/core/rendering/MotionRendererBackend.ts',
  'src/core/rendering/AppTextureProvider.ts',
  'src/core/rendering/buildSnapshot.ts',
  'packages/renderer/src',
];

/** Extract `layer.<field>` names referenced by contentHash's projection. */
function hashedFields(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\blayer\.([A-Za-z_$][\w$]*)/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
}

function collectSources(entry: string): string[] {
  const abs = join(REPO_ROOT, entry);
  let st;
  try {
    st = statSync(abs);
  } catch {
    // A path in PIXEL_PATH that no longer exists is itself a failure worth
    // surfacing — a silently-empty scope would make this test pass vacuously.
    throw new Error(`PIXEL_PATH entry does not exist: ${entry}`);
  }
  if (st.isFile()) return [abs];

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(p);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        files.push(p);
      }
    }
  };
  walk(abs);
  return files;
}

const FIELDS = hashedFields(readFileSync(CONTENT_HASH_SRC, 'utf8'));

const PIXEL_PATH_SOURCE = PIXEL_PATH.flatMap(collectSources)
  .filter((f) => f !== CONTENT_HASH_SRC)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

describe('content hash ⇄ renderer contract', () => {
  it('parses a plausible field list out of contentHash.ts', () => {
    // Guards the guard: if `contentOf` is refactored into a shape the regex no
    // longer matches, every row below would pass vacuously.
    expect(FIELDS.length).toBeGreaterThan(20);
    expect(FIELDS).toContain('width');
    expect(FIELDS).toContain('effects');
  });

  it.each(FIELDS)('`%s` is read somewhere in the pixel path', (field) => {
    expect(new RegExp(`\\.${field}\\b`).test(PIXEL_PATH_SOURCE)).toBe(true);
  });
});
