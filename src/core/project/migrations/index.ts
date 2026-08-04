/**
 * Document migrations — the upgrade path for `EditorDocument` across schema
 * changes.
 *
 * WHY THIS EXISTS. Until now a document's `version` was written ('1.1.0') and
 * faithfully preserved through `bundleCodec` as `manifest.documentVersion`, and
 * then read by nothing. Older bundles opened because every field added so far
 * was OPTIONAL — `readNodeMask` / `readNodeMatte` / `readNodeBlend` all tolerate
 * absent props and default cleanly. That works right up until a field needs to
 * CHANGE SHAPE rather than appear, at which point an old document either loads
 * wrong or loads half-way. This module is the mechanism that has to exist
 * before the first such change lands.
 *
 * WHERE IT RUNS. `restoreDocument` (cloudDocument.ts) — the single point where a
 * foreign document becomes live state, shared by the bundle path
 * (BundleRepository → decodeBundle), local version history (VersionStore), the
 * cloud API, and legacy single-file `.motion` reads. Migrating there covers all
 * four with one call, and it runs BEFORE any subsystem restore, so a document we
 * cannot understand fails without half-populating the scene graph.
 *
 * ADDING A MIGRATION. Append to `MIGRATIONS`, bump `CURRENT_DOCUMENT_VERSION`,
 * and commit a fixture of the OLD shape with a test that loads it. The chain is
 * walked in order, so each step only has to know how to get from its own `from`
 * to its own `to` — never from arbitrary history to now.
 *
 * The registry ships with ONE real step (1.0.0 → 1.1.0), not a synthetic
 * identity migration — a `1.1.0 → 1.1.0` entry would be a cycle hazard in the
 * walker and a lie in the registry. Multi-step walks are additionally covered by
 * tests that inject a synthetic chain.
 */

import type { EditorDocument } from '@core/api/cloudDocument';
// Type-only in the other direction, so this is not a runtime cycle.
import { v1_0_0_to_v1_1_0 } from './v1_0_0_to_v1_1_0';
import { v1_1_0_to_v1_2_0 } from './v1_1_0_to_v1_2_0';
import { v1_2_0_to_v1_3_0 } from './v1_2_0_to_v1_3_0';
import { v1_3_0_to_v1_4_0 } from './v1_3_0_to_v1_4_0';

/** The version this build writes and understands. Bump when adding a migration. */
export const CURRENT_DOCUMENT_VERSION = '1.4.0';

/**
 * The version assumed for a document that carries none. The oldest shape we
 * ever wrote — scene-only `ProjectFile`s and the first monolithic documents
 * predate the field.
 */
export const IMPLIED_LEGACY_VERSION = '1.0.0';

/** One step in the upgrade chain. Must be pure. */
export interface DocumentMigration {
  /** Version this step upgrades FROM. */
  from: string;
  /** Version this step produces. */
  to: string;
  /** A short note for the changelog / error messages. */
  description: string;
  migrate(doc: EditorDocument): EditorDocument;
}

/**
 * Thrown when a document cannot be brought to the current version.
 *
 * Distinct from a parse error: the file is valid, we just cannot honour it.
 * Callers should surface the message rather than fall back to an empty project,
 * because silently opening blank is how authored work looks like it was lost.
 */
export class DocumentVersionError extends Error {
  constructor(
    message: string,
    readonly documentVersion: string,
    readonly appVersion: string,
  ) {
    super(message);
    this.name = 'DocumentVersionError';
  }
}

/**
 * The ordered upgrade chain.
 *
 * The 1.0.0 → 1.1.0 step is not a synthetic placeholder: it is a real schema
 * change that already shipped (single `comp` → `comps` registry) and was until
 * now handled only by tolerance inside `restoreDocument`. Registering it is what
 * makes "older than us with no covering migration" a genuine error rather than
 * the normal case.
 */
export const MIGRATIONS: readonly DocumentMigration[] = [
  v1_0_0_to_v1_1_0,
  v1_1_0_to_v1_2_0,
  v1_2_0_to_v1_3_0,
  v1_3_0_to_v1_4_0,
];

/**
 * Compare two dotted numeric versions. Returns <0, 0, >0 like a comparator.
 * Missing segments read as 0, so '1.1' === '1.1.0'. Non-numeric segments read
 * as 0 rather than NaN-poisoning the comparison.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Bring a document to `target`, applying each migration in order.
 *
 * Returns the SAME object when already current — callers may rely on that to
 * skip a structuredClone on the common path.
 *
 * Throws `DocumentVersionError` when the document is newer than this build
 * understands, or when no migration covers some step of the gap. Both are
 * "fail loudly" cases: continuing would restore a document whose shape we are
 * guessing at.
 *
 * `migrations` and `target` are injectable so tests can exercise the walk
 * without the production registry having to contain anything.
 */
export function migrateDocument(
  doc: EditorDocument,
  migrations: readonly DocumentMigration[] = MIGRATIONS,
  target: string = CURRENT_DOCUMENT_VERSION,
): EditorDocument {
  const from = doc.version ?? IMPLIED_LEGACY_VERSION;

  const delta = compareVersions(from, target);
  if (delta > 0) {
    throw new DocumentVersionError(
      `This project was saved by a newer version of Premation (document ${from}; ` +
        `this build understands ${target}). Update the app to open it.`,
      from,
      target,
    );
  }
  if (delta === 0) return doc;

  let current = from;
  let working = doc;
  // Bounded by the chain length: a registry with a cycle would otherwise spin
  // here forever, and a corrupt `to` is a programming error worth surfacing.
  for (let step = 0; step <= migrations.length; step++) {
    if (compareVersions(current, target) === 0) {
      return working.version === target ? working : { ...working, version: target };
    }
    const next = migrations.find((m) => compareVersions(m.from, current) === 0);
    if (!next) {
      throw new DocumentVersionError(
        `No migration path from document version ${current} to ${target}. ` +
          `This project may have been saved by an unsupported build.`,
        from,
        target,
      );
    }
    working = next.migrate(working);
    current = next.to;
  }

  throw new DocumentVersionError(
    `Migration chain from ${from} to ${target} did not terminate — the registry ` +
      `is likely cyclic.`,
    from,
    target,
  );
}
