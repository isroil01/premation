/**
 * The route C spike must never switch on in a shipped build: only in dev, and
 * only when the flag names an absolute engine path.
 */

jest.mock('electron', () => ({ app: {}, sharedTexture: {} }));

import { routeCSpikeEngine } from './routeCSpike';

describe('routeCSpikeEngine', () => {
  const exe = process.platform === 'win32' ? 'C:\\engine\\premation-engine.exe' : '/engine/premation-engine';

  it('is off outside development, whatever the environment says', () => {
    expect(routeCSpikeEngine(false, { PREMATION_ROUTE_C_SPIKE: exe })).toBeNull();
  });

  it('is off in development without the flag, or with a relative path', () => {
    expect(routeCSpikeEngine(true, {})).toBeNull();
    expect(routeCSpikeEngine(true, { PREMATION_ROUTE_C_SPIKE: '1' })).toBeNull();
  });

  it('returns the engine path in development with the flag', () => {
    expect(routeCSpikeEngine(true, { PREMATION_ROUTE_C_SPIKE: exe })).toBe(exe);
  });
});
