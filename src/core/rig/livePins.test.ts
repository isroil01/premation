/**
 * `resolveLivePins` — the one reader that turns stored pins into solver pins.
 *
 * The interesting assertions are about what it does NOT do: it must not sample a
 * bend pin's position track, and it must not drop `kind` on the way through.
 */

import { resolveLivePins, pinPropPath, type PinSampler } from './livePins';
import type { PuppetPin } from './puppet';

/** Records every path asked for, so "did not sample" is observable. */
function recorder(values: Record<string, unknown> = {}): PinSampler & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    sample(_n, path) { asked.push(path); return values[path]; },
    sampleData(_n, path) { asked.push(path); return values[path]; },
  };
}

const advanced: PuppetPin = { id: 'a', name: 'a', x: 10, y: 20 };
const bend: PuppetPin = { id: 'b', name: 'b', x: 30, y: 40, kind: 'bend' };

describe('resolveLivePins', () => {
  it('carries `kind` through to the solver pin', () => {
    const [, b] = resolveLivePins([advanced, bend], 'n', 0, recorder());
    expect(b!.kind).toBe('bend');
  });

  it('leaves `kind` absent on an advanced pin rather than writing it out', () => {
    // Absent, not 'advanced'. Every rig in every existing file has no `kind`,
    // and stamping one on during a read would make a no-op edit dirty the
    // document and change what autosave writes back.
    const [a] = resolveLivePins([advanced], 'n', 0, recorder());
    expect('kind' in a!).toBe(false);
  });

  it('samples an advanced pin\'s position track', () => {
    const r = recorder();
    resolveLivePins([advanced], 'n', 0, r);
    expect(r.asked).toContain(pinPropPath('a', 'position'));
  });

  it('does NOT sample a bend pin\'s position track', () => {
    // A bend pin has no position to animate — the solve derives one. Reading a
    // track here would hand `deform` a target it then ignores.
    const r = recorder();
    resolveLivePins([bend], 'n', 0, r);
    expect(r.asked).not.toContain(pinPropPath('b', 'position'));
  });

  it('still samples a bend pin\'s rotation, scale and stiffness', () => {
    const r = recorder();
    resolveLivePins([bend], 'n', 0, r);
    for (const prop of ['rotation', 'scale', 'stiffness']) {
      expect(r.asked).toContain(pinPropPath('b', prop));
    }
  });

  it('a bend pin keeps its stored rest anchor as x/y', () => {
    const [b] = resolveLivePins([bend], 'n', 0, recorder());
    expect(b!.x).toBe(30);
    expect(b!.y).toBe(40);
  });

  it('a sampled track wins over the stored static value', () => {
    const r = recorder({ [pinPropPath('a', 'rotation')]: 77 });
    const [a] = resolveLivePins([{ ...advanced, rotation: 5 }], 'n', 0, r);
    expect(a!.rotation).toBe(77);
  });

  it('falls back to the stored value when a track returns a non-number', () => {
    const r = recorder({ [pinPropPath('a', 'rotation')]: undefined });
    const [a] = resolveLivePins([{ ...advanced, rotation: 5 }], 'n', 0, r);
    expect(a!.rotation).toBe(5);
  });

  it('an animated position replaces the stored anchor on an advanced pin', () => {
    const r = recorder({ [pinPropPath('a', 'position')]: [{ x: -1, y: -2 }] });
    const [a] = resolveLivePins([advanced], 'n', 0, r);
    expect(a!.x).toBe(-1);
    expect(a!.y).toBe(-2);
  });
});
