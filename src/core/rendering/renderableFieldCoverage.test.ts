/**
 * Every field of the render boundary must have a producer, or a recorded reason.
 *
 * Covers four types: `RenderLayer` (the snapshot's own layer, 73 fields),
 * `Renderable`, `SceneLight3D` and `FrameScene`.
 *
 * ── The class of bug this closes ────────────────────────────────────────────
 *
 * These types are the whole contract between the snapshot builder and the
 * renderer: if a field is not written, the passes that read it see `undefined`
 * forever and the feature behind it is inert. Nothing throws. This branch has
 * now hit that shape five times — `Command.isChecked`, `isPassthroughOnly`,
 * `SelectionPass`'s `selection: []`, the extrusion faces' `effects: undefined`,
 * and a preset export with no caller — and the only reason each was found was
 * somebody reading the right file on the right day.
 *
 * So the read side is checked mechanically here, derived from the interface,
 * and a new field that nothing produces fails this test instead of shipping
 * as a control with no effect.
 *
 * ── Why the write detector accepts three forms ──────────────────────────────
 *
 * A first version matched only `field:` and reported `depthExempt` as never
 * written. It is written by `enforceExtrusionPathAgreement`, as
 * `r.depthExempt = true`. Adding assignment still missed `hasEffects`, written
 * as bare ES6 shorthand. Each form was added only after the detector produced a
 * confident false report, and each false positive is pinned below so a narrower
 * version cannot come back.
 *
 * The same lesson applies to the producer LISTS, in both directions: too short
 * and the sweep invents dead fields (it claimed seven for `SceneLight3D`); too
 * long and it silences real ones while looking better-researched. Both
 * directions are asserted.
 *
 * ── Why `Renderable {` and not `Renderable` ─────────────────────────────────
 *
 * The same sweep first reported that `Renderable` had four fields. It has 30:
 * `indexOf('export interface Renderable')` matched `RenderableSdf`, which is
 * declared earlier in the file. A prefix match is silent — it returns a real
 * interface, with real fields, and every count derived from it is wrong. The
 * brace is what makes the anchor exact.
 *
 * IF THIS FAILS: produce the field, or add it to {@link NO_PRODUCER} with the
 * reason nothing writes it.
 */

import { readSource } from '@/__testHelpers__/readSource';

const SCENE = '../packages/renderer/src/scene/FrameScene.ts';

/**
 * Each boundary type, and every module that builds or mutates one.
 *
 * The producer list is per-type and was arrived at by measurement, not by
 * guessing. Sweeping `SceneLight3D` against the `Renderable` producers reported
 * SEVEN dead fields including `halfConeRad` and `coneFeatherRad` — both of
 * which demonstrably ship, and both of which `lightShaderParity.test.ts`
 * already guards. They are built in `lightShading.ts`, which simply was not in
 * the list. A producer list that is too short does not under-report; it invents
 * dead fields.
 */
const BOUNDARIES: ReadonlyArray<{ type: string; file: string; producers: string[] }> = [
  {
    type: 'Renderable',
    file: SCENE,
    producers: ['core/rendering/snapshotToFrameScene.ts'],
  },
  {
    type: 'SceneLight3D',
    file: SCENE,
    producers: ['core/scene/lightShading.ts'],
  },
  {
    type: 'FrameScene',
    file: SCENE,
    producers: ['core/rendering/snapshotToFrameScene.ts'],
  },
  {
    // The snapshot's own layer type — upstream of everything above, and the
    // widest of the four at 73 fields.
    type: 'RenderLayer',
    file: 'core/rendering/RenderBackend.ts',
    producers: ['core/rendering/buildSnapshot.ts'],
  },
];

/**
 * Fields no producer writes, and why that is correct.
 *
 * Both entries serve `MaskPass`, which is `enabled = false` with nothing to
 * turn it on — deliberate scaffolding, not an oversight. Its own docstring says
 * "enable + wire a masked material to activate", and `RenderGraph.ts` carries a
 * whole optimization built around the pass being permanently off (its target
 * had been allocating ~8 MB of VRAM per frame for a pass that cannot run).
 *
 * Masking itself is not broken by this: it is applied on the CPU through
 * `effectBake`, which reads `maskId` off the EFFECT, not off the renderable.
 * That distinction is the reason a repo-wide grep for `maskId` looks busy while
 * the renderable field stays unwritten.
 */
const NO_PRODUCER: ReadonlyMap<string, string> = new Map([
  ['maskId', 'Read only by MaskPass, which is `enabled = false` with nothing to enable it. Masking ships via effectBake, which reads maskId off the effect rather than the renderable.'],
  ['clip', 'Same: the other half of MaskPass\'s filter (`r.maskId || r.clip`), inert for as long as that pass is disabled.'],
]);

/** Field names of an interface, anchored by the opening brace. */
function interfaceFields(src: string, name: string): string[] {
  const at = src.indexOf(`export interface ${name} {`);
  if (at < 0) throw new Error(`renderableFieldCoverage: no \`export interface ${name} {\``);
  const open = src.indexOf('{', at);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error(`renderableFieldCoverage: unbalanced braces in \`${name}\``);
  const body = src.slice(open + 1, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  // Two-space indent only — deeper members belong to a nested object type.
  return [...body.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]!);
}

/**
 * The three ways a field gets written, all of which count as production.
 *
 * Each was added because the previous version reported a live field as dead:
 * `field:` alone missed `r.depthExempt = true`, and adding assignment still
 * missed `{ hasEffects }`, the ES6 shorthand — `snapshotToFrameScene` computes
 * it as a local `const` on one line and spreads it into the scene on another.
 *
 * Shorthand is the dangerous one. It looks like nothing: no colon, no dot, just
 * the name and a comma, so a detector reading for punctuation cannot see it at
 * all.
 */
function isProduced(field: string, sources: readonly string[]): boolean {
  const literal = new RegExp(String.raw`(^|[{,\s])${field}\s*:`, 'm');
  const assign = new RegExp(String.raw`\.${field}\s*=[^=]`);
  // `  hasEffects,` on its own line — shorthand inside an object literal.
  const shorthand = new RegExp(String.raw`^\s*${field}\s*,\s*$`, 'm');
  return sources.some((s) => literal.test(s) || assign.test(s) || shorthand.test(s));
}

describe.each(BOUNDARIES)('$type field coverage', ({ type, file, producers }) => {
  const fields = interfaceFields(readSource(file), type);
  const sources = producers.map((p) => readSource(p));

  it('reads a plausible interface, so the table below is not empty', () => {
    // A parser that returns [] makes every `it.each` run zero times, which
    // reports as a pass. That is the failure mode this whole file exists to
    // catch, so it is checked on the checker.
    expect(fields.length).toBeGreaterThan(2);
  });

  it.each(fields)('`%s` is written by a producer, or is exempt with a reason', (field) => {
    if (NO_PRODUCER.has(field)) {
      expect(NO_PRODUCER.get(field)!.length).toBeGreaterThan(30);
      return;
    }
    expect([type, field, isProduced(field, sources)]).toEqual([type, field, true]);
  });
});

describe('the sweep’s own failure modes', () => {
  const fields = interfaceFields(readSource(SCENE), 'Renderable');
  const sources = BOUNDARIES[0]!.producers.map((p) => readSource(p));

  it('reads the real Renderable, not a prefix match', () => {
    // `RenderableSdf` is declared earlier and has 4 fields; an anchor without
    // the brace silently returns it, and every assertion below then measures
    // the wrong interface while passing.
    expect(fields).toContain('modelMatrix');
    expect(fields).toContain('kind');
    expect(fields.length).toBeGreaterThan(20);
  });

  it('counts an assignment as production, not just an object literal', () => {
    // The exact false positive the first version of this sweep produced:
    // `depthExempt` is set as `r.depthExempt = true` by
    // enforceExtrusionPathAgreement, and a literal-only detector calls it dead.
    expect(fields).toContain('depthExempt');
    expect(isProduced('depthExempt', sources)).toBe(true);
    expect(sources.some((s) => /\.depthExempt\s*=[^=]/.test(s))).toBe(true);
    // …and it is NOT written in literal form anywhere, which is what made the
    // narrower detector wrong rather than merely lucky.
    expect(sources.some((s) => /(^|[{,\s])depthExempt\s*:/m.test(s))).toBe(false);
  });

  it('counts ES6 shorthand as production', () => {
    // The third false positive, and the one a punctuation-reading detector
    // cannot see at all: `snapshotToFrameScene` computes `hasEffects` as a
    // local const and writes it into the scene as bare `hasEffects,`.
    const scene = readSource('core/rendering/snapshotToFrameScene.ts');
    expect(isProduced('hasEffects', [scene])).toBe(true);
    expect(/^\s*hasEffects\s*,\s*$/m.test(scene)).toBe(true);
    // Neither of the other two forms appears, so shorthand support is what
    // makes this pass rather than a coincidence.
    expect(/\.hasEffects\s*=[^=]/.test(scene)).toBe(false);
    expect(/(^|[{,\s])hasEffects\s*:/m.test(scene)).toBe(false);
  });

  it.each(BOUNDARIES)('every producer listed for $type earns its place', ({ type, file, producers }) => {
    // A producer list that is too SHORT invents dead fields (below). One that
    // is too long is quieter but worse: it silences real findings, and it looks
    // more thoroughly researched than it is.
    //
    // `paintStrokes.ts` was in this table for exactly one run. `strokes` did
    // look unproduced — until shorthand support landed and found it at
    // `buildSnapshot.ts:1927` as bare `strokes,`. The entry was covering for a
    // gap in the detector, not for a real second producer.
    const fields = interfaceFields(readSource(file), type);
    for (const p of producers) {
      const others = producers.filter((q) => q !== p).map((q) => readSource(q));
      const only = fields.filter((f) => !NO_PRODUCER.has(f) && !isProduced(f, others));
      expect([type, p, only.length > 0]).toEqual([type, p, true]);
    }
  });

  it('an incomplete producer list invents dead fields', () => {
    // Why BOUNDARIES carries a producer list PER TYPE. Swept against only the
    // Renderable producers, SceneLight3D reports seven dead fields — including
    // halfConeRad, which ships and has its own parity guard. It is built in
    // lightShading.ts. The failure is silent and reads as a discovery.
    const lightFields = interfaceFields(readSource(SCENE), 'SceneLight3D');
    const wrongScope = [readSource('core/rendering/buildSnapshot.ts')];
    expect(isProduced('halfConeRad', wrongScope)).toBe(false);
    const right = BOUNDARIES.find((b) => b.type === 'SceneLight3D')!.producers.map((p) => readSource(p));
    expect(lightFields).toContain('halfConeRad');
    expect(isProduced('halfConeRad', right)).toBe(true);
  });

  it('every exemption still names a real field, and MaskPass is still off', () => {
    for (const [field] of NO_PRODUCER) {
      expect([field, fields.includes(field)]).toEqual([field, true]);
    }
    // The exemptions are justified entirely by that pass being disabled. If it
    // is ever enabled, they stop being correct and must become producers.
    const pass = readSource('../packages/renderer/src/rendergraph/passes/MaskPass.ts');
    expect(pass).toMatch(/override\s+enabled\s*=\s*false/);
  });
});
