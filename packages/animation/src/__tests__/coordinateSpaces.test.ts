/**
 * The coordinate-space functions, HOST side.
 *
 * The geometry is not tested here — it lives in the app, over the same matrices
 * the renderer uses, and is covered by `src/core/scene/layerSpace.test.ts`. What
 * this file owns is everything between the expression text and that provider:
 * which layer a call is addressed to, how a point argument is read, what a
 * missing provider does, and whether the three ways AE lets you spell these
 * actually reach the same place.
 *
 * The split is deliberate. Duplicating the matrix maths here would mean a
 * second implementation of "where does this point land", which is the §2·0
 * shape the provider contract exists to avoid.
 */

import { compileExpression, EXPRESSION_API, type ExprContext, type LayerSpace } from '../expressions';

/** A provider whose conversions are trivially identifiable, per layer. */
function spaceFor(name: string | null): LayerSpace {
  // Deliberately NOT a real transform: a distinct, invertible marker per layer,
  // so a test can tell WHICH layer answered. `self` doubles x, `Other` adds 1000.
  const k = name === null ? 2 : 1;
  const off = name === null ? 0 : 1000;
  return {
    toComp: (p) => [p[0] * k + off, p[1] * k + off],
    fromComp: (p) => [(p[0] - off) / k, (p[1] - off) / k],
    toWorld: (p) => [p[0] * k + off, p[1] * k + off, 7],
    fromWorld: (p) => [(p[0] - off) / k, (p[1] - off) / k],
  };
}

const ctx = (over: Partial<ExprContext> = {}): ExprContext => ({
  time: 0,
  value: 0,
  layerInfo: { name: 'Self', width: 100, height: 100 },
  spaceAt: (name) => spaceFor(name),
  ...over,
});

function run(src: string, over: Partial<ExprContext> = {}): { value: unknown; error: string | null } {
  const c = compileExpression(src);
  expect(c.compileError).toBeNull();
  const r = c.run(ctx(over));
  return { value: r.value, error: r.error };
}

describe('the four functions reach the provider', () => {
  it('toComp and fromComp are inverses through the provider', () => {
    expect(run('toComp([3, 4])').value).toEqual([6, 8]);
    expect(run('fromComp([6, 8])').value).toEqual([3, 4]);
  });

  it('toWorld returns a 3-vector; fromWorld accepts one', () => {
    expect(run('toWorld([3, 4])').value).toEqual([6, 8, 7]);
    expect(run('fromWorld([6, 8, 7])').value).toEqual([3, 4]);
  });

  it('a [x, y] world point is accepted with z = 0, as AE does', () => {
    expect(run('fromWorld([6, 8])').value).toEqual([3, 4]);
  });
});

describe('which layer a call is addressed to', () => {
  /**
   * The whole point of the layer form. `thisComp.layer('Other').toComp` must
   * convert in OTHER's space — a binding that quietly used the current layer's
   * would return plausible numbers for every call and be wrong for all of them.
   */
  it('thisComp.layer(name) converts in THAT layer’s space, not this one’s', () => {
    expect(run("thisComp.layer('Other').toComp([3, 4])").value).toEqual([1003, 1004]);
    expect(run('thisLayer.toComp([3, 4])').value).toEqual([6, 8]);
    expect(run('toComp([3, 4])').value).toEqual([6, 8]);
  });

  it('the bare and thisLayer spellings are the same call', () => {
    expect(run('toComp([3, 4])').value).toEqual(run('thisLayer.toComp([3, 4])').value);
    expect(run('fromWorld([6, 8, 0])').value).toEqual(run('thisLayer.fromWorld([6, 8, 0])').value);
  });

  it('passes the layer NAME through, so the provider can resolve it', () => {
    const seen: Array<string | null> = [];
    run("thisComp.layer('Target').toComp([0, 0])", {
      spaceAt: (name) => { seen.push(name); return spaceFor(name); },
    });
    expect(seen).toEqual(['Target']);
  });

  it('passes null for the current layer', () => {
    const seen: Array<string | null> = [];
    run('toComp([0, 0])', { spaceAt: (name) => { seen.push(name); return spaceFor(name); } });
    expect(seen).toEqual([null]);
  });
});

describe('the time argument', () => {
  it('defaults to the current time and is forwarded when given', () => {
    const seen: number[] = [];
    const probe = { spaceAt: (n: string | null, t: number) => { seen.push(t); return spaceFor(n); } };
    run('toComp([0, 0])', { time: 1.5, ...probe });
    run('toComp([0, 0], 4)', { time: 1.5, ...probe });
    expect(seen).toEqual([1.5, 4]);
  });
});

describe('failures are STATED, never silent', () => {
  /**
   * The failure mode this guards is specific: a conversion that returns its
   * input. That is correct-looking for a layer at the origin and wrong for
   * every other one, so it survives casual testing and ships.
   */
  it('no provider is an error, not an identity conversion', () => {
    const r = run('toComp([3, 4])', { spaceAt: undefined });
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/cannot see this layer/i);
    // Emphatically NOT the input handed back.
    expect(r.value).not.toEqual([3, 4]);
  });

  it('an unknown layer names itself in the error', () => {
    const r = run("thisComp.layer('Nope').toComp([0, 0])", { spaceAt: () => undefined });
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/Nope/);
  });

  it('a non-point argument says what a point looks like', () => {
    const r = run('toComp(5)');
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/needs a point/i);
    expect(r.error).toMatch(/toComp\(\[0, 0\]\)/);
  });

  it('each function names ITSELF in its error, not a shared label', () => {
    // A caller reading "toComp() needs a point" while their expression says
    // fromWorld has to go looking for a call they did not make.
    for (const fn of ['toComp', 'toWorld', 'fromComp', 'fromWorld']) {
      expect(run(`${fn}('nope')`).error).toMatch(new RegExp(`^${fn}\\(\\)`));
    }
  });
});

describe('discoverability', () => {
  /**
   * A function bound in `scope` but missing from the autocomplete table works
   * perfectly and is invisible. `expressionApi.test.ts` already asserts the two
   * lists agree in general; this pins the four by name, so removing one from
   * the table fails here rather than silently shrinking what users can find.
   */
  it('all four are in the autocomplete + docs table', () => {
    const labels = EXPRESSION_API.map((a) => a.label);
    for (const fn of ['toComp()', 'toWorld()', 'fromComp()', 'fromWorld()']) {
      expect(labels).toContain(fn);
    }
  });

  it('each hint names the DIRECTION, which is the only thing people get wrong', () => {
    const byLabel = new Map(EXPRESSION_API.map((a) => [a.label, a.hint]));
    expect(byLabel.get('toComp()')).toMatch(/→ composition/);
    expect(byLabel.get('fromComp()')).toMatch(/composition point →/);
    expect(byLabel.get('toWorld()')).toMatch(/→ world/);
    expect(byLabel.get('fromWorld()')).toMatch(/world point →/);
  });

  it('the snippets are runnable as inserted', () => {
    for (const fn of ['toComp()', 'toWorld()', 'fromComp()', 'fromWorld()']) {
      const insert = EXPRESSION_API.find((a) => a.label === fn)!.insert;
      const r = run(insert);
      expect(r.error).toBeNull();
      expect(Array.isArray(r.value)).toBe(true);
    }
  });
});
