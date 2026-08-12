/**
 * Every field of `Renderable` must have a producer, or a recorded reason.
 *
 * ── The class of bug this closes ────────────────────────────────────────────
 *
 * `Renderable` is the whole contract between the snapshot builder and the
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
 * ── Why the write detector accepts two forms ────────────────────────────────
 *
 * A first version of this sweep matched only `field:` (object-literal form) and
 * reported `depthExempt` as never written. It is written — by
 * `enforceExtrusionPathAgreement`, as `r.depthExempt = true`, an assignment on
 * an already-built object. The detector was measuring literal syntax and
 * calling it production. Both forms count here, and the false positive is
 * pinned below so the narrower version cannot come back.
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
/** Every module that builds or mutates a `Renderable`. */
const PRODUCERS = [
  'core/rendering/snapshotToFrameScene.ts',
  'core/rendering/buildSnapshot.ts',
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

/** Object-literal (`field:`) or assignment (`.field =`) — both are production. */
function isProduced(field: string, sources: readonly string[]): boolean {
  const literal = new RegExp(String.raw`(^|[{,\s])${field}\s*:`, 'm');
  const assign = new RegExp(String.raw`\.${field}\s*=[^=]`);
  return sources.some((s) => literal.test(s) || assign.test(s));
}

describe('Renderable field coverage', () => {
  const scene = readSource(SCENE);
  const fields = interfaceFields(scene, 'Renderable');
  const sources = PRODUCERS.map((p) => readSource(p));

  it('reads the real Renderable, not a prefix match', () => {
    // `RenderableSdf` is declared earlier and has 4 fields; an anchor without
    // the brace silently returns it, and every assertion below then measures
    // the wrong interface while passing.
    expect(fields).toContain('modelMatrix');
    expect(fields).toContain('kind');
    expect(fields.length).toBeGreaterThan(20);
  });

  it.each(interfaceFields(readSource(SCENE), 'Renderable'))(
    '`%s` is written by a producer, or is exempt with a reason',
    (field) => {
      if (NO_PRODUCER.has(field)) {
        expect(NO_PRODUCER.get(field)!.length).toBeGreaterThan(30);
        return;
      }
      expect([field, isProduced(field, sources)]).toEqual([field, true]);
    },
  );

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
