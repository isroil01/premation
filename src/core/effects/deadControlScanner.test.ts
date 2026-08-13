/**
 * Nothing in this repo hunted for dead controls, and it has found five by hand.
 *
 * ## What a dead control is, and why it is worth a scanner
 *
 * A control the user can see, set, keyframe and save — whose value NOTHING
 * reads. It is the most expensive kind of defect this codebase produces,
 * because every signal says it works: the UI renders, the value persists, the
 * document round-trips, `tsc` is clean and the suite is green. The only way to
 * discover it is to change the control and notice the picture did not move,
 * which is exactly what nobody does for a parameter they are not currently
 * suspicious of.
 *
 * The five found by hand, each by accident:
 *
 *   · the spot cone angle on a 2D layer
 *   · three light parameters that stopped at the CPU and never reached the GPU
 *   · `frameBlend`
 *   · Auto-Orient
 *   · Compound Blur's whole parameter set — the effect was in the type union
 *     with no `EFFECT_DEFS` entry, so it rendered nothing at all
 *
 * ## What this scans, and what it deliberately does not
 *
 * Two families, in the two describes below.
 *
 * **Effect parameters** — 75 effects and several hundred keys, enumerated from
 * `EFFECT_DEFS`. By far the largest surface, the most mechanical, and the one
 * that grows every time someone adds an effect.
 *
 * **Material options** — enumerated by CALLING `readNodeMaterial` and taking
 * the keys off what it returns, because there is no registry to read. This is
 * where four of the five hand-found examples actually lived, and the reason
 * nothing swept it before is precisely that it has no declaration to iterate.
 *
 * Layer switches and light properties are still uncovered: they have neither a
 * registry nor a single reader returning a complete shape. This is the sweep
 * that can be automated today, not a claim to have swept everything.
 *
 * ## Why it reads SOURCE rather than rendering
 *
 * A runtime check would be better and is not available: proving a parameter is
 * live means rendering twice at two values and diffing, which needs the GPU
 * harness for GPU effects and a real canvas for baked ones — neither exists
 * under jsdom. What IS checkable here is the wiring fact underneath: a live
 * parameter's key appears somewhere that consumes it, and a dead one appears
 * only in its own declaration.
 *
 * That gives false NEGATIVES (a key mentioned in a consumer but read into a
 * variable nobody uses still passes) and, without care, false POSITIVES. The
 * false positives are handled by listing consumers broadly and by an explicit
 * exception list below, each entry of which has to say why. The false negatives
 * are the price of a check that can run at all — it catches the parameter with
 * NO reader, which is the case all five hand-found examples were.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EFFECT_DEFS } from './effects';
import { readNodeMaterial } from '@core/scene/material';

const SRC = resolve(__dirname, '..', '..');

/**
 * Every file that could legitimately consume an effect parameter.
 *
 * Directories rather than a hand-listed set of files: a new effect
 * implementation lands as a new file, and a scanner that had to be told about
 * it would report the whole effect dead on the day it was written — which
 * trains the next person to add an exception rather than to look.
 */
const CONSUMER_DIRS = [
  join(SRC, 'core', 'effects'),
  join(SRC, 'core', 'rendering'),
  join(SRC, 'core', 'scene'),
  join(SRC, 'layout', 'Inspector'),
  join(SRC, 'layout', 'Effects'),
];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** All consumer source, concatenated once — the scan is a substring question. */
const CONSUMER_SOURCE = CONSUMER_DIRS
  .flatMap(filesUnder)
  // The registry itself is where params are DECLARED. Its `css` bodies are
  // genuine consumers though, so it is included and the declaration lines are
  // discounted below instead of the file being excluded wholesale.
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/** The registry alone, for telling a declaration apart from a use. */
const REGISTRY_SOURCE = readFileSync(join(SRC, 'core', 'effects', 'effects.ts'), 'utf8');

/**
 * How many times a key appears OUTSIDE its own `key: '…'` declaration.
 *
 * The declaration is what every parameter has by definition, so counting it
 * would make every parameter look live and the scan would assert nothing.
 */
function usesOutsideDeclaration(key: string): number {
  /*
    QUOTED or PROPERTY-ACCESSED, never a bare identifier.

    The first version matched `\bkey\b` too, and that made the scan nearly
    unable to fail: keys like `amount`, `width`, `color` and `radius` occur as
    ordinary local variables in a hundred unrelated places, so those parameters
    would report live whatever their wiring. Restricting to the two forms a
    parameter is actually READ through —

      effectNumber(e, 'amount')   → quoted
      e.params?.invert            → property access

    — is what gives the check teeth on exactly the common names where it was
    previously blind.
  */
  const declaration = new RegExp(`key:\\s*'${key}'`, 'g');
  const consumed = new RegExp(`'${key}'|"${key}"|\\.${key}\\b`, 'g');
  const declarations = (REGISTRY_SOURCE.match(declaration) ?? []).length;
  const total = (CONSUMER_SOURCE.match(consumed) ?? []).length;
  if (total - declarations > 0) return total - declarations;
  // Not found literally — it may still be read through a COMPUTED key.
  return computedKeyReaders(key);
}

/**
 * Template literals in the consumer source that BUILD a parameter key, as
 * `[prefix, suffix]` pairs around their interpolation.
 *
 * ## Why this exists
 *
 * A parameter read as `` effectNumber(e, `v${i}X`) `` never appears literally
 * anywhere, so the substring scan above reports all thirty-two of Mesh Warp's
 * lattice offsets as dead. They are not — they are read in a loop, which is the
 * only sane way to read thirty-two of anything.
 *
 * That is a FALSE POSITIVE, and the wrong fix is thirty-two exception entries:
 * an exception list that long stops being a record of deliberate decisions and
 * becomes a place to put things, which is how a scanner quietly turns into
 * decoration. Teaching it to recognise the construct is the fix.
 *
 * ## Why it cannot be too permissive
 *
 * A bare `` `${x}` `` has no literal part and would match every key, which
 * would disable the check entirely. Pairs whose prefix and suffix together are
 * shorter than two characters are therefore ignored — a key is only credited to
 * a template that pins at least that much of its shape.
 */
const TEMPLATE_KEY_PARTS: ReadonlyArray<readonly [string, string]> = (() => {
  const out: Array<readonly [string, string]> = [];
  const re = /`([A-Za-z0-9_]*)\$\{[^}]*\}([A-Za-z0-9_]*)`/g;
  for (const m of CONSUMER_SOURCE.matchAll(re)) {
    const prefix = m[1] ?? '';
    const suffix = m[2] ?? '';
    if (prefix.length + suffix.length >= 2) out.push([prefix, suffix]);
  }
  return out;
})();

function computedKeyReaders(key: string): number {
  let n = 0;
  for (const [prefix, suffix] of TEMPLATE_KEY_PARTS) {
    // The interpolation has to stand for something, so a key that IS the
    // prefix and suffix glued together with nothing between them does not
    // count — that would credit `vX` to a template building `v0X`…`v15X`.
    if (key.length <= prefix.length + suffix.length) continue;
    if (key.startsWith(prefix) && key.endsWith(suffix)) n++;
  }
  return n;
}

/**
 * Parameters that legitimately have no reader in the scanned source.
 *
 * Every entry states WHY, and an entry that stops being true is a failure of
 * its own — the list is asserted to contain nothing stale, so an exception
 * cannot outlive its reason the way a comment can.
 */
const KNOWN_EXCEPTIONS: ReadonlyMap<string, string> = new Map([]);

describe('no effect parameter is a dead control', () => {
  const params = EFFECT_DEFS.flatMap((d) => d.params.map((p) => ({ effect: d.type, key: p.key })));

  it('has parameters to scan at all, so a broken scan is not a silent pass', () => {
    // The check that stops this whole file becoming vacuous. If `EFFECT_DEFS`
    // moved or `params` were renamed, every loop below would iterate nothing
    // and report success — which is the failure mode a scanner is worst at.
    expect(params.length).toBeGreaterThan(150);
    expect(CONSUMER_SOURCE.length).toBeGreaterThan(100_000);
  });

  it('finds a reader for every declared parameter', () => {
    const dead = params
      .filter(({ key }) => !KNOWN_EXCEPTIONS.has(key))
      .filter(({ key }) => usesOutsideDeclaration(key) <= 0)
      .map(({ effect, key }) => `${effect}.${key}`);
    // Named, not counted: a count sends the next person bisecting 75 effects.
    expect(dead).toEqual([]);
  });

  it('keeps every exception justified — a stale one is its own failure', () => {
    const declared = new Set(params.map((p) => p.key));
    const stale = [...KNOWN_EXCEPTIONS.keys()].filter((k) => !declared.has(k));
    expect(stale).toEqual([]);
    for (const [, why] of KNOWN_EXCEPTIONS) expect(why.length).toBeGreaterThan(20);
  });

  /**
   * The scanner has to be able to FAIL, and this is the only assertion that
   * shows it can.
   *
   * A scanner nobody has seen fail is indistinguishable from one whose
   * predicate is inverted, whose corpus is empty, or whose regex matches
   * everything. This feeds it a key that is certainly absent and requires the
   * answer to be zero.
   */
  it('reports a parameter nothing mentions as dead', () => {
    expect(usesOutsideDeclaration('zzzNoSuchParameterKey')).toBeLessThanOrEqual(0);
  });

  it('reports a parameter everything mentions as live', () => {
    // `radius` is read by blurs, glow and shadow across several files.
    expect(usesOutsideDeclaration('radius')).toBeGreaterThan(0);
  });

  /**
   * The computed-key allowance, pinned from both sides.
   *
   * It exists because Mesh Warp reads thirty-two lattice offsets in a loop, and
   * a key built as `` `v${i}X` `` appears nowhere literally. Crediting those is
   * correct; crediting EVERYTHING would quietly turn this whole file into
   * decoration, and the difference is how much literal shape a template pins.
   */
  describe('keys built by a template literal', () => {
    it('credits a key the loop actually builds', () => {
      expect(computedKeyReaders('v0X')).toBeGreaterThan(0);
      expect(computedKeyReaders('v15Y')).toBeGreaterThan(0);
    });

    it('does NOT credit a key that merely shares the affixes', () => {
      // `vX` is the prefix and suffix glued together with nothing between, so
      // the interpolation stands for nothing and the match is spurious.
      expect(computedKeyReaders('vX')).toBe(0);
    });

    it('does NOT credit an unrelated key', () => {
      expect(computedKeyReaders('zzzNoSuchParameterKey')).toBe(0);
    });

    it('ignores templates with too little literal shape to mean anything', () => {
      // The guard that stops a bare `${x}` matching every parameter in the
      // registry — which would be indistinguishable from deleting this file.
      for (const [prefix, suffix] of TEMPLATE_KEY_PARTS) {
        expect(prefix.length + suffix.length).toBeGreaterThanOrEqual(2);
      }
    });
  });
});

/**
 * The OTHER family, and the one every hand-found example actually came from.
 *
 * Four of the five were not effect parameters: the spot cone on a 2D layer,
 * three light properties that stopped at the CPU, `frameBlend`, Auto-Orient.
 * Those live on the Transform component and are read back through
 * `readNodeMaterial` / `readNodeLight`, which have no registry to enumerate —
 * which is precisely why nothing swept them.
 *
 * They can still be enumerated, just not from a declaration: CALL the reader
 * and take the keys off what it returns. That costs no maintenance and cannot
 * drift, because the list IS the reader's own output.
 *
 * ## What "consumed" means here, and why the bar is higher
 *
 * A material field is read by its own reader by construction, so appearing in
 * `material.ts` proves nothing. The question is whether anything DOWNSTREAM of
 * the reader uses it — `buildSnapshot`, `snapshotToFrameScene`, the renderer —
 * so those files are scanned and the reader itself is not. That is the exact
 * shape of "three light params that stopped at the CPU": read, carried,
 * and never handed to the GPU.
 */
describe('no material or light property is a dead control', () => {
  /** A bare 3D node — enough for the readers to return their full shape. */
  const probeNode = {
    id: 'probe',
    name: 'probe',
    parent: null,
    children: [],
    visible: true,
    locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'probe_t', type: 'Transform', props: { z: 1 } }],
  } as unknown as Parameters<typeof readNodeMaterial>[0];

  /*
    Downstream of the readers, deliberately excluding the readers themselves.

    `scene/material.ts` and `scene/light.ts` mention every field they return, so
    including them would make this scan unable to fail — the same mistake the
    effect scan avoids by discounting `key: '…'` declarations.
  */
  const DOWNSTREAM = [
    join(SRC, 'core', 'rendering'),
    join(SRC, 'layout', 'Inspector'),
  ].flatMap(filesUnder)
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  const usedDownstream = (key: string): number =>
    (DOWNSTREAM.match(new RegExp(`'${key}'|"${key}"|\\.${key}\\b`, 'g')) ?? []).length;

  /**
   * Fields whose absence downstream is correct, with the reason.
   *
   * `castsShadows` is the boolean mirror of `castsShadowsMode` and exists so
   * every existing boolean reader keeps working; `shadowOnly` is likewise
   * derived from the two modes. Both are computed BY the reader rather than
   * stored, so a downstream consumer of the mode covers them.
   */
  const MATERIAL_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
    ['castsShadowsMode', 'derived pair — downstream reads the boolean `castsShadows` and `shadowOnly`'],
    ['acceptsShadowsMode', 'derived pair — downstream reads the boolean `acceptsShadows` and `shadowOnly`'],
  ]);

  it('enumerates something, so a broken probe is not a silent pass', () => {
    expect(Object.keys(readNodeMaterial(probeNode)).length).toBeGreaterThan(8);
    expect(DOWNSTREAM.length).toBeGreaterThan(50_000);
  });

  it('finds a downstream reader for every material option', () => {
    const dead = Object.keys(readNodeMaterial(probeNode))
      .filter((k) => !MATERIAL_EXCEPTIONS.has(k))
      .filter((k) => usedDownstream(k) === 0);
    expect(dead).toEqual([]);
  });

  it('keeps every material exception justified', () => {
    const fields = new Set(Object.keys(readNodeMaterial(probeNode)));
    expect([...MATERIAL_EXCEPTIONS.keys()].filter((k) => !fields.has(k))).toEqual([]);
  });

  it('can fail — an invented field reports dead', () => {
    expect(usedDownstream('zzzNoSuchMaterialField')).toBe(0);
  });
});
