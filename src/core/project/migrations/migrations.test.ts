/**
 * M0 — the migration mechanism.
 *
 * The registry is empty in production, so the WALK is proven here with an
 * injected synthetic chain. That is deliberate: shipping a fake `1.1.0 → 1.1.0`
 * identity migration to make the loop look exercised would be a cycle hazard in
 * the walker and a lie in the registry.
 *
 * The fixture test is the one that matters long-term — it is the guard the
 * "never break existing saved projects" rule actually hangs off.
 */

import {
  CURRENT_DOCUMENT_VERSION,
  IMPLIED_LEGACY_VERSION,
  DocumentVersionError,
  MIGRATIONS,
  compareVersions,
  migrateDocument,
  type DocumentMigration,
} from './index';
import type { EditorDocument } from '@core/api/cloudDocument';

/**
 * A document in the shape this build writes TODAY, committed as a literal.
 *
 * When a future milestone changes the schema, this literal must NOT be updated
 * — it is the pre-change artifact. Copy it to a new `fixture_v1_1_0` constant
 * and assert the migration transforms it into the new shape.
 */
const FIXTURE_V1_1_0: EditorDocument = {
  version: '1.1.0',
  scene: {
    version: '1.0.0',
    nodes: [
      { id: 'n1', name: 'Rect', kind: 'shape', components: [] },
      { id: 'n2', name: 'Text', kind: 'text', components: [] },
    ],
  } as unknown as EditorDocument['scene'],
  animation: { tracks: {}, expressions: {} } as unknown as EditorDocument['animation'],
};

const doc = (version?: string): EditorDocument =>
  ({ ...structuredClone(FIXTURE_V1_1_0), ...(version === undefined ? {} : { version }) }) as EditorDocument;

describe('compareVersions', () => {
  it('orders by numeric segment, not lexically', () => {
    // '1.10.0' < '1.9.0' under string compare — the classic trap.
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
  });

  it('treats missing segments as zero', () => {
    expect(compareVersions('1.1', '1.1.0')).toBe(0);
    expect(compareVersions('2', '2.0.0')).toBe(0);
  });

  it('treats non-numeric segments as zero rather than NaN', () => {
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
  });
});

describe('migrateDocument — current documents', () => {
  it('returns the SAME object when already current (no needless clone)', () => {
    const d = doc(CURRENT_DOCUMENT_VERSION);
    expect(migrateDocument(d)).toBe(d);
  });

  it('leaves a current fixture structurally unchanged', () => {
    const before = structuredClone(FIXTURE_V1_1_0);
    const after = migrateDocument(doc());
    expect(after).toEqual(before);
  });

  it('ships a real registry chain reaching the current version', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.to).toBe(CURRENT_DOCUMENT_VERSION);
  });

  it('has a contiguous chain — every step feeds the next', () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i]!.from).toBe(MIGRATIONS[i - 1]!.to);
    }
  });
});

describe('migrateDocument — the real 1.0.0 → 1.1.0 step', () => {
  const legacyComp = {
    id: 'comp_root',
    name: 'Legacy',
    width: 640,
    height: 480,
    fps: 12,
    durationSeconds: 5,
    background: '#000000',
    transparent: false,
    startFrame: 0,
  };

  it('hoists the single active comp into the comps registry', () => {
    const out = migrateDocument({ ...doc('1.0.0'), comp: legacyComp } as EditorDocument);
    expect(out.version).toBe('1.1.0');
    expect(out.comps).toEqual({ comp_root: legacyComp });
  });

  it('PRESERVES `comp` so an older build can still read the migrated file', () => {
    // The rollback story: a migration that deletes the old field cannot be
    // undone by reverting the app.
    const out = migrateDocument({ ...doc('1.0.0'), comp: legacyComp } as EditorDocument);
    expect(out.comp).toEqual(legacyComp);
  });

  it('does not let a legacy comp clobber an existing comps registry', () => {
    const existing = { other: { ...legacyComp, id: 'other', name: 'Kept' } };
    const out = migrateDocument({
      ...doc('1.0.0'),
      comp: legacyComp,
      comps: existing,
    } as unknown as EditorDocument);
    expect(out.comps).toEqual(existing);
  });

  it('upgrades a v1.0.0 document that has no comp at all', () => {
    const out = migrateDocument(doc('1.0.0'));
    expect(out.version).toBe('1.1.0');
    expect(out.comps).toBeUndefined();
  });
});

describe('migrateDocument — failing loudly', () => {
  it('rejects a document newer than this build, before any restore work', () => {
    expect(() => migrateDocument(doc('99.0.0'))).toThrow(DocumentVersionError);
    expect(() => migrateDocument(doc('99.0.0'))).toThrow(/newer version/i);
  });

  it('carries both versions on the error for the UI to surface', () => {
    try {
      migrateDocument(doc('2.0.0'));
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as DocumentVersionError;
      expect(err.name).toBe('DocumentVersionError');
      expect(err.documentVersion).toBe('2.0.0');
      expect(err.appVersion).toBe(CURRENT_DOCUMENT_VERSION);
    }
  });

  it('rejects an older document with no migration covering the gap', () => {
    // 0.9.0 predates the chain's first step, so the gap is unbridgeable. Must
    // throw rather than optimistically restoring a shape we are guessing at.
    expect(() => migrateDocument(doc('0.9.0'))).toThrow(/No migration path/i);
  });

  it('treats a version-less document as the implied legacy version', () => {
    // IMPLIED_LEGACY_VERSION is 1.0.0, which the chain DOES cover — so a
    // version-less document upgrades rather than failing.
    const legacy = doc();
    delete (legacy as { version?: string }).version;
    expect(compareVersions(IMPLIED_LEGACY_VERSION, '1.0.0')).toBe(0);
    expect(migrateDocument(legacy).version).toBe(CURRENT_DOCUMENT_VERSION);
  });
});

describe('migrateDocument — the walk (injected chain)', () => {
  const chain: DocumentMigration[] = [
    {
      from: '1.0.0',
      to: '1.1.0',
      description: 'test: tag step one',
      migrate: (d) => ({ ...d, comp: { ...(d.comp ?? {}), stepOne: true } as never }),
    },
    {
      from: '1.1.0',
      to: '1.2.0',
      description: 'test: tag step two',
      migrate: (d) => ({ ...d, comp: { ...(d.comp ?? {}), stepTwo: true } as never }),
    },
  ];

  it('applies every step in order across a multi-step gap', () => {
    const out = migrateDocument(doc('1.0.0'), chain, '1.2.0');
    expect(out.version).toBe('1.2.0');
    expect(out.comp).toMatchObject({ stepOne: true, stepTwo: true });
  });

  it('applies only the steps needed, starting mid-chain', () => {
    const out = migrateDocument(doc('1.1.0'), chain, '1.2.0');
    expect(out.version).toBe('1.2.0');
    expect(out.comp).toMatchObject({ stepTwo: true });
    expect((out.comp as unknown as Record<string, unknown>).stepOne).toBeUndefined();
  });

  it('does not mutate the input document', () => {
    const input = doc('1.0.0');
    const snapshot = structuredClone(input);
    migrateDocument(input, chain, '1.2.0');
    expect(input).toEqual(snapshot);
  });

  it('stamps the target version even when the last step under-reports it', () => {
    const short: DocumentMigration[] = [
      { from: '1.0.0', to: '1.1.0', description: 'test', migrate: (d) => d },
    ];
    expect(migrateDocument(doc('1.0.0'), short, '1.1.0').version).toBe('1.1.0');
  });

  it('terminates on a cyclic registry instead of spinning', () => {
    const cyclic: DocumentMigration[] = [
      { from: '1.0.0', to: '1.0.5', description: 'test', migrate: (d) => d },
      { from: '1.0.5', to: '1.0.0', description: 'test', migrate: (d) => d },
    ];
    expect(() => migrateDocument(doc('1.0.0'), cyclic, '9.9.9')).toThrow(DocumentVersionError);
  });
});
