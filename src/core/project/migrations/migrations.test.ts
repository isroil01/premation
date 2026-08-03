/**
 * The migration mechanism (M0) and every registered step.
 *
 * Multi-step walking is additionally proven with an INJECTED synthetic chain, so
 * the walker stays covered independently of how many real migrations exist —
 * shipping a fake `x → x` identity migration to exercise the loop would be a
 * cycle hazard in the walker and a lie in the registry.
 *
 * The per-step FIXTURE tests are the ones that matter long-term: each holds a
 * document literal in a shape nothing writes any more, which is the only thing
 * that actually guards "never break existing saved projects". Do not update a
 * fixture when the schema changes — add a new one and migrate the old.
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

  it('leaves an already-current document structurally unchanged', () => {
    const current = doc(CURRENT_DOCUMENT_VERSION);
    const before = structuredClone(current);
    expect(migrateDocument(current)).toEqual(before);
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
    // Walks the whole chain now, not just this step — assert the end version.
    const out = migrateDocument({ ...doc('1.0.0'), comp: legacyComp } as EditorDocument);
    expect(out.version).toBe(CURRENT_DOCUMENT_VERSION);
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
    expect(out.version).toBe(CURRENT_DOCUMENT_VERSION);
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

describe('migrateDocument — the real 1.1.0 → 1.2.0 step (matte reshape)', () => {
  /**
   * A v1.1.0 document, committed as a literal. Do NOT update this when the
   * schema next changes — it is the pre-change artifact, and its whole value is
   * that nothing writes this shape any more.
   */
  const fixtureV1_1_0 = (): EditorDocument => ({
    version: '1.1.0',
    scene: {
      version: '1.0.0',
      nodes: [
        { id: 'a', components: [{ type: 'fx', props: { matte: 'alpha-inv' } }] },
        { id: 'b', components: [{ type: 'fx', props: { matte: { mode: 'luma-inv', sourceId: 'a' } } }] },
        {
          id: 'group',
          components: [],
          children: [{ id: 'nested', components: [{ type: 'fx', props: { matte: 'luma' } }] }],
        },
        { id: 'plain', components: [{ type: 'fx', props: { blendMode: 'screen' } }] },
      ],
    } as unknown as EditorDocument['scene'],
    animation: { tracks: {}, expressions: {} } as unknown as EditorDocument['animation'],
  });

  const fxOf = (d: EditorDocument, id: string): Record<string, unknown> => {
    const walk = (ns: Array<Record<string, any>>): Record<string, any> | undefined => {
      for (const n of ns) {
        if (n.id === id) return n;
        const hit = n.children ? walk(n.children) : undefined;
        if (hit) return hit;
      }
      return undefined;
    };
    return walk((d.scene as unknown as { nodes: Array<Record<string, any>> }).nodes)!.components[0].props;
  };

  it('rewrites the legacy string form', () => {
    const out = migrateDocument(fixtureV1_1_0());
    expect(out.version).toBe(CURRENT_DOCUMENT_VERSION);
    expect(fxOf(out, 'a').matte).toEqual({ mode: 'alpha', inverted: true });
  });

  it('rewrites the legacy OBJECT form and PRESERVES sourceId', () => {
    // Losing sourceId re-points the matte at whatever layer sits above: still
    // matted, still looks fine, cut to the wrong shape. Worst failure available.
    expect(fxOf(migrateDocument(fixtureV1_1_0()), 'b').matte)
      .toEqual({ mode: 'luma', inverted: true, sourceId: 'a' });
  });

  it('reaches nested children, not just top-level nodes', () => {
    expect(fxOf(migrateDocument(fixtureV1_1_0()), 'nested').matte)
      .toEqual({ mode: 'luma', inverted: false });
  });

  it('leaves unrelated fx props alone', () => {
    const props = fxOf(migrateDocument(fixtureV1_1_0()), 'plain');
    expect(props.blendMode).toBe('screen');
    expect(props.matte).toBeUndefined();
  });

  it('does not mutate the input document', () => {
    const input = fixtureV1_1_0();
    const before = structuredClone(input);
    migrateDocument(input);
    expect(input).toEqual(before);
  });

  it('is idempotent — re-running over already-migrated data changes nothing', () => {
    const once = migrateDocument(fixtureV1_1_0());
    const twice = migrateDocument({ ...structuredClone(once), version: '1.1.0' });
    expect(fxOf(twice, 'b').matte).toEqual({ mode: 'luma', inverted: true, sourceId: 'a' });
  });

  it('migrates a v1.0.0 document through BOTH steps', () => {
    // The multi-step walk exercised on the real registry, not an injected chain.
    const legacy = { ...fixtureV1_1_0(), version: '1.0.0' } as EditorDocument;
    const out = migrateDocument(legacy);
    expect(out.version).toBe(CURRENT_DOCUMENT_VERSION);
    expect(fxOf(out, 'a').matte).toEqual({ mode: 'alpha', inverted: true });
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
    // The SYNTHETIC chain's own target, deliberately NOT CURRENT_DOCUMENT_VERSION:
    // these two exercise the walker rather than the real registry, and pinning
    // them to the live version would couple a walker test to every schema bump.
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
