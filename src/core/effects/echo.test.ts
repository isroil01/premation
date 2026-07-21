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
    expect(c).toEqual({ time: -0.1, count: 8, startIntensity: 0.8, decay: 0.7 });
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
  });
});
