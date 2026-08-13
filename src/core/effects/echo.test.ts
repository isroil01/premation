import { readEchoConfig } from './echo';
import type { Effect } from './effects';

const echo = (params: Record<string, number>, enabled = true): Effect => ({
  id: 'fx_echo', type: 'echo', enabled, params,
});

describe('readEchoConfig', () => {
  test('null when there is no echo effect', () => {
    expect(readEchoConfig([])).toBeNull();
    expect(readEchoConfig([{ id: 'a', type: 'blur', params: { amount: 5 } }])).toBeNull();
  });

  test('null when the echo effect is disabled', () => {
    expect(readEchoConfig([echo({ numEchoes: 5 }, false)])).toBeNull();
  });

  test('reads params, converting intensity/decay to 0..1', () => {
    const c = readEchoConfig([echo({ echoTime: -0.1, numEchoes: 8, startIntensity: 80, decay: 70 })]);
    expect(c).toEqual({
      time: -0.1, count: 8, startIntensity: 0.8, decay: 0.7,
      // Echo Operator defaults to Add, as in AE.
      operator: 'add', echoesInFront: false,
    });
  });

  test('count is rounded and clamped to [0,64]', () => {
    expect(readEchoConfig([echo({ numEchoes: 3.6 })])!.count).toBe(4);
    expect(readEchoConfig([echo({ numEchoes: -5 })])!.count).toBe(0);
    expect(readEchoConfig([echo({ numEchoes: 1000 })])!.count).toBe(64);
  });

  test('falls back to registry defaults for omitted params', () => {
    const c = readEchoConfig([echo({})])!;
    // defaults: echoTime -0.05, numEchoes 6, startIntensity 80%, decay 70%
    expect(c.time).toBeCloseTo(-0.05, 5);
    expect(c.count).toBe(6);
    expect(c.startIntensity).toBeCloseTo(0.8, 5);
    expect(c.decay).toBeCloseTo(0.7, 5);
    expect(c.operator).toBe('add');
  });
});

/**
 * AE's Echo Operator, which this effect shipped without — the parameter is
 * visible in AE's own Effect Controls and our Echo had four params where AE has
 * five. It is the first `'enum'` param in the registry, so this also pins that
 * a named choice stored as a NUMBER reads back correctly.
 */
describe('echo operator', () => {
  const opOf = (v: number): { operator: string; echoesInFront: boolean } => {
    const c = readEchoConfig([echo({ numEchoes: 4, echoOperator: v })])!;
    return { operator: c.operator, echoesInFront: c.echoesInFront };
  };

  test('maps each menu index to the blend the ghosts composite with', () => {
    expect(opOf(0)).toEqual({ operator: 'add', echoesInFront: false });
    expect(opOf(1)).toEqual({ operator: 'lighten', echoesInFront: false });   // Maximum
    expect(opOf(2)).toEqual({ operator: 'darken', echoesInFront: false });    // Minimum
    expect(opOf(3)).toEqual({ operator: 'screen', echoesInFront: false });
  });

  test('Composite In Back and In Front differ ONLY in z-order', () => {
    // Both are `normal`; the operator that separates them is which side of the
    // layer the ghosts are emitted on. If these ever stop sharing a blend the
    // buildSnapshot deferral has become the wrong mechanism.
    expect(opOf(4)).toEqual({ operator: 'normal', echoesInFront: false });
    expect(opOf(5)).toEqual({ operator: 'normal', echoesInFront: true });
  });

  test('an unknown operator falls back to Add, not to whatever is at index 0 after a reorder', () => {
    // A project written by a build with more operators must not silently become
    // a DIFFERENT mode.
    expect(opOf(99)).toEqual({ operator: 'add', echoesInFront: false });
    expect(opOf(-1)).toEqual({ operator: 'add', echoesInFront: false });
  });
});
