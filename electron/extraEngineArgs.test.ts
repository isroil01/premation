/**
 * PREMATION_ENGINE_ARGS (docs/PLUGIN_SDK.md "Debugging a plugin"): a plugin author's debugging
 * flags reach the engine — only the ones meant for it, with a valid value.
 */

import { extraEngineArgs } from './engineHost';

describe('extraEngineArgs', () => {
  it('passes --plugin-watchdog and --log-level with their values', () => {
    expect(extraEngineArgs({ PREMATION_ENGINE_ARGS: '--plugin-watchdog 0  --log-level debug' })).toEqual([
      '--plugin-watchdog', '0', '--log-level', 'debug',
    ]);
  });

  it('ignores anything else, and a flag without a valid value', () => {
    expect(extraEngineArgs({ PREMATION_ENGINE_ARGS: '--plugins C:\\evil --plugin-watchdog soon --log-level loud --no-gpu' })).toEqual([]);
    expect(extraEngineArgs({})).toEqual([]);
  });
});
