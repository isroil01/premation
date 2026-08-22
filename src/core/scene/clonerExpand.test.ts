/**
 * Cloner expansion: the plan becoming actual renderables.
 *
 * `cloner.test.ts` proves the arithmetic. This proves the list surgery, which
 * fails in ways the arithmetic cannot catch — a clone that keeps the original's
 * id and collides with it, a group whose children are dropped so it renders as
 * an empty box, an offset written onto every descendant so it applies once per
 * level, or two nested cloners multiplying into hundreds of renderables from
 * two innocuous-looking counts.
 */

import { expandCloners, readNodeCloner, cloneOffsetOf, CLONER_PROP } from './clonerExpand';
import { DEFAULT_CLONER, type ClonerConfig } from './cloner';
import type { SceneNode } from '@core/types';
import { readSource } from '@/__testHelpers__/readSource';

const node = (id: string, parent: string | null, props: Record<string, unknown> = {}): SceneNode =>
  ({
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_fx`, type: 'fx', props }],
  }) as unknown as SceneNode;

const cloner = (patch: Partial<ClonerConfig> = {}): Record<string, unknown> => ({
  [CLONER_PROP]: { ...DEFAULT_CLONER, enabled: true, ...patch },
});

describe('reading the config', () => {
  it('is null without a cloner', () => {
    expect(readNodeCloner(node('a', null))).toBeNull();
  });

  it('is null when present but disabled', () => {
    expect(readNodeCloner(node('a', null, { [CLONER_PROP]: { ...DEFAULT_CLONER, enabled: false } }))).toBeNull();
  });

  it('fills in fields a stored config predates', () => {
    // A config saved before `falloff` existed would otherwise arrive with the
    // nested objects undefined and every read of them would be NaN.
    const cfg = readNodeCloner(node('a', null, { [CLONER_PROP]: { enabled: true, count: 3 } }))!;
    expect(cfg.step).toEqual(DEFAULT_CLONER.step);
    expect(cfg.random).toEqual(DEFAULT_CLONER.random);
    expect(cfg.falloff).toEqual(DEFAULT_CLONER.falloff);
    expect(cfg.count).toBe(3);
  });
});

describe('expansion', () => {
  it('returns the SAME array when nothing clones', () => {
    const nodes = [node('root', null), node('a', 'root')];
    expect(expandCloners(nodes)).toBe(nodes);
  });

  it('replaces the source with N clones', () => {
    // Not N+1: keeping the original would leave an unselectable duplicate
    // sitting exactly under clone 0.
    const nodes = [node('root', null), node('a', 'root', cloner({ count: 3, mode: 'linear' }))];
    const out = expandCloners(nodes);
    expect(out.filter((n) => n.id === 'a')).toHaveLength(0);
    expect(out.filter((n) => cloneOffsetOf(n))).toHaveLength(3);
  });

  it('gives every clone a distinct id', () => {
    const nodes = [node('root', null), node('a', 'root', cloner({ count: 4 }))];
    const ids = expandCloners(nodes).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps each clone parented where the source was', () => {
    const nodes = [node('root', null), node('a', 'root', cloner({ count: 2 }))];
    for (const n of expandCloners(nodes).filter((x) => cloneOffsetOf(x))) {
      expect(n.parent).toBe('root');
    }
  });

  it('routes animation reads to the ORIGINAL via __instanceSource', () => {
    // Without this only the clone whose id happened to match would animate.
    const nodes = [node('root', null), node('a', 'root', cloner({ count: 3 }))];
    for (const n of expandCloners(nodes).filter((x) => cloneOffsetOf(x))) {
      expect((n as unknown as { __instanceSource: string }).__instanceSource).toBe('a');
    }
  });

  it('leaves untouched layers alone', () => {
    const nodes = [node('root', null), node('a', 'root', cloner({ count: 2 })), node('b', 'root')];
    const out = expandCloners(nodes);
    expect(out.find((n) => n.id === 'b')).toBeTruthy();
    expect(out.find((n) => n.id === 'root')).toBeTruthy();
  });
});

describe('subtrees', () => {
  it('clones descendants too, so a cloned group is not an empty box', () => {
    const nodes = [
      node('root', null),
      node('g', 'root', cloner({ count: 2 })),
      node('child', 'g'),
    ];
    const out = expandCloners(nodes);
    // 2 clones × (group + child)
    expect(out.filter((n) => n.id !== 'root')).toHaveLength(4);
  });

  it('re-parents a cloned child onto its OWN clone root', () => {
    // Pointing every copy of `child` at the original `g` would stack them all
    // on clone 0 and the other clones would render empty.
    const nodes = [node('root', null), node('g', 'root', cloner({ count: 2 })), node('child', 'g')];
    const out = expandCloners(nodes);
    const roots = out.filter((n) => cloneOffsetOf(n));
    const children = out.filter((n) => n.id.includes('child'));
    expect(children).toHaveLength(2);
    expect(new Set(children.map((c) => c.parent))).toEqual(new Set(roots.map((r) => r.id)));
  });

  it('puts the offset ONLY on the clone root', () => {
    // On a descendant too, it would be applied once per level of nesting.
    const nodes = [node('root', null), node('g', 'root', cloner({ count: 2 })), node('child', 'g')];
    const out = expandCloners(nodes);
    for (const c of out.filter((n) => n.id.includes('child'))) {
      expect(cloneOffsetOf(c)).toBeNull();
    }
  });

  it('clones grandchildren, not just direct children', () => {
    const nodes = [
      node('root', null),
      node('g', 'root', cloner({ count: 2 })),
      node('child', 'g'),
      node('grand', 'child'),
    ];
    expect(expandCloners(nodes).filter((n) => n.id.includes('grand'))).toHaveLength(2);
  });
});

describe('nested cloners', () => {
  it('does NOT multiply counts together', () => {
    // Two counts of 20 would otherwise be 400 renderables from two controls
    // that each look modest. The inner cloner's layers are already being
    // multiplied by the outer one.
    const nodes = [
      node('root', null),
      node('outer', 'root', cloner({ count: 3 })),
      node('inner', 'outer', cloner({ count: 4 })),
    ];
    const out = expandCloners(nodes);
    expect(out.filter((n) => n.id !== 'root')).toHaveLength(6); // 3 × (outer + inner)
  });
});

describe('the offsets themselves', () => {
  it('carry the planned transform onto each clone root', () => {
    const nodes = [node('root', null), node('a', 'root', cloner({ mode: 'linear', count: 3, offsetX: 100, offsetY: 0 }))];
    const offs = expandCloners(nodes).map(cloneOffsetOf).filter(Boolean);
    expect(offs.map((o) => o!.x)).toEqual([-100, 0, 100]);
  });

  it('are indexed in order', () => {
    const nodes = [node('root', null), node('a', 'root', cloner({ count: 4 }))];
    const offs = expandCloners(nodes).map(cloneOffsetOf).filter(Boolean);
    expect(offs.map((o) => o!.index)).toEqual([0, 1, 2, 3]);
  });

  it('a zero count removes the layer entirely rather than leaving it once', () => {
    // `enabled` with count 0 is a legitimate transient state while typing in
    // the field; it must not silently fall back to rendering the source.
    const nodes = [node('root', null), node('a', 'root', cloner({ count: 0 }))];
    const out = expandCloners(nodes);
    expect(out.filter((n) => n.id !== 'root')).toHaveLength(0);
  });
});

describe('the control is reachable', () => {
  // An engine with no way to switch it on is the "composed but unexecuted"
  // failure this repo keeps finding: tests green, feature absent.

  it('the expansion runs inside buildSnapshot', () => {
    const src = readSource('core/rendering/buildSnapshot.ts');
    expect(src).toMatch(/expandCloners\(expandCompInstances\(/);
    // …and the offset is applied to the RESOLVED transform, not patched into
    // components where a keyframed x would outvote it.
    expect(src).toMatch(/cloneOffsetOf\(node\)/);
    expect(src).toMatch(/px \+= cloneOff\.x/);
  });

  it('ClonerSection is mounted in the inspector, for every layer kind', () => {
    const ui = readSource('layout/EditorLayout/DemoPanels.tsx');
    expect(ui).toMatch(/import \{ ClonerSection \}/);
    expect(ui).toMatch(/<ClonerSection nodeId=\{nodeId\} \/>/);
    // Pushed unconditionally — NOT inside a `kind === …` branch. A group is the
    // obvious thing to clone, and gating it to shapes would hide it there.
    const mount = ui.slice(ui.indexOf("id: 'cloner'"));
    expect(mount.slice(0, 200)).not.toMatch(/kind ===/);
  });
});
