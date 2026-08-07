/**
 * Compiling plugin effects, and surviving the ones that kill the GPU.
 *
 * The assertions worth reading are the attribution ones. Everything else here
 * is bookkeeping; attribution is the difference between a user who is told
 * "this effect from this plugin was drawing when your graphics device reset"
 * and a user whose viewport dies every few seconds with nothing to act on.
 *
 * Both directions matter, and the second is easy to get wrong:
 *
 *   • A device loss WHILE a plugin effect is drawing implicates it.
 *   • A device loss with no plugin effect drawing implicates NOBODY. Drivers
 *     update, other applications hang the GPU, machines wake from sleep — and
 *     blaming a plugin for that is worse than silence, because the user
 *     disables something innocent and still has the problem.
 */

import {
  registerEffects,
  unregisterEffects,
  compileEffect,
  beginEffectDraw,
  endEffectDraw,
  noteDeviceLoss,
  reenableEffect,
  registeredEffects,
  effectById,
  resetEffectsForTests,
  currentlyDrawing,
  COMPILE_TIMEOUT_MS,
  type EffectCompiler,
} from './pluginEffects';
import type { EffectContribution } from './effectSchema';
import { useUIStore } from '@stores/uiStore';

const PLUGIN = 'studio.acme.glow';
const PLUGIN_NAME = 'Acme Glow';

const contribution = (id = 'glow'): EffectContribution => ({
  id,
  label: 'Glow',
  shader: '@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
  params: { amount: { type: 'number', default: 1 } },
});

const ok: EffectCompiler = { compile: () => Promise.resolve() };
const broken: EffectCompiler = { compile: () => Promise.reject(new Error('unknown identifier `foo`')) };
const never: EffectCompiler = { compile: () => new Promise<void>(() => { /* never settles */ }) };

const ID = `${PLUGIN}.glow`;

beforeEach(() => {
  resetEffectsForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => '');
});
afterEach(() => jest.restoreAllMocks());

describe('registration', () => {
  it('registers on ENABLE, without running any plugin code', () => {
    // The same rule layer kinds follow: an effect must be addable to a layer
    // before the plugin's worker boots, or every plugin declaring one would
    // have to start at launch — which is what lazy activation exists to avoid.
    registerEffects(PLUGIN, PLUGIN_NAME, [contribution()]);

    expect(registeredEffects()).toHaveLength(1);
    expect(effectById(ID)).toMatchObject({ state: 'pending', pluginName: PLUGIN_NAME });
  });

  it('namespaces by plugin id, so two plugins can both ship a "glow"', () => {
    registerEffects(PLUGIN, PLUGIN_NAME, [contribution()]);
    registerEffects('studio.other.fx', 'Other FX', [contribution()]);

    expect(registeredEffects().map((e) => e.id).sort())
      .toEqual([`${PLUGIN}.glow`, 'studio.other.fx.glow']);
  });

  it('drops them on disable', () => {
    registerEffects(PLUGIN, PLUGIN_NAME, [contribution(), contribution('bloom')]);
    unregisterEffects(PLUGIN);
    expect(registeredEffects()).toEqual([]);
  });

  it('notifies subscribers when the set changes', () => {
    const fn = jest.fn();
    const { subscribeToEffects } = require('./pluginEffects') as typeof import('./pluginEffects');
    subscribeToEffects(fn);

    registerEffects(PLUGIN, PLUGIN_NAME, [contribution()]);
    expect(fn).toHaveBeenCalled();
  });
});

describe('compiling', () => {
  beforeEach(() => registerEffects(PLUGIN, PLUGIN_NAME, [contribution()]));

  it('becomes ready when the driver accepts it', async () => {
    expect(await compileEffect(ID, ok)).toBe('ready');
    expect(effectById(ID)!.reason).toBe('');
  });

  it('★ becomes FAILED rather than throwing', async () => {
    /*
      The caller is a render setup path. An exception there is a frame that does
      not happen — so a shader the driver rejects has to end as a state, and
      that state renders passthrough.
    */
    expect(await compileEffect(ID, broken)).toBe('failed');
    expect(effectById(ID)!.reason).toMatch(/unknown identifier/);
  });

  it('keeps the driver s complaint, attributed to the plugin', async () => {
    // A driver error message on its own is unattributable. This is the one
    // place the mapping from shader to plugin is known.
    await compileEffect(ID, broken);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PLUGIN_NAME));
  });

  it('★ gives up on a driver that never answers', async () => {
    /*
      Not a performance guard — a cold pipeline compile on a slow integrated GPU
      is genuinely slow, and a tight limit would disable working effects on
      exactly the machines least able to spare them. This is for the driver that
      never answers at all, which otherwise hangs the load.
    */
    jest.useFakeTimers();
    const pending = compileEffect(ID, never);
    jest.advanceTimersByTime(COMPILE_TIMEOUT_MS + 1);
    const state = await pending;
    jest.useRealTimers();

    expect(state).toBe('failed');
    expect(effectById(ID)!.reason).toMatch(/longer than/);
  });

  it('answers failed for an effect nobody registered', async () => {
    expect(await compileEffect('nope.nope', ok)).toBe('failed');
  });
});

describe('★ attributing a device loss', () => {
  beforeEach(() => registerEffects(PLUGIN, PLUGIN_NAME, [contribution()]));

  it('disables the effect that was drawing, and names its plugin', () => {
    /*
      The assertion this module exists for. Without it a user sees a viewport
      that dies every few seconds and their only recourse is uninstalling
      plugins one at a time until it stops.
    */
    const notify = jest.spyOn(useUIStore.getState(), 'notify').mockImplementation(() => '');

    beginEffectDraw(ID);
    const blamed = noteDeviceLoss('device lost: destroyed');

    expect(blamed?.id).toBe(ID);
    expect(effectById(ID)!.state).toBe('disabled');
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining(PLUGIN_NAME) }),
    );
  });

  it('★ blames NOBODY when no plugin effect was drawing', () => {
    /*
      Drivers update, other applications hang the GPU, machines wake from sleep.
      Blaming a plugin for one of those is worse than saying nothing: the user
      disables something innocent and still has the problem.
    */
    const notify = jest.spyOn(useUIStore.getState(), 'notify').mockImplementation(() => '');

    expect(noteDeviceLoss('driver reset')).toBeNull();
    expect(effectById(ID)!.state).toBe('pending');
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not blame an effect that finished drawing', () => {
    // The marker is cleared when the draw ends, so a loss arriving later is
    // not pinned on whatever happened to run last.
    beginEffectDraw(ID);
    endEffectDraw();

    expect(noteDeviceLoss('device lost')).toBeNull();
    expect(effectById(ID)!.state).toBe('pending');
  });

  it('clears the marker, so one loss cannot blame the same effect twice', () => {
    beginEffectDraw(ID);
    noteDeviceLoss('first');

    expect(currentlyDrawing()).toBeNull();
    expect(noteDeviceLoss('second')).toBeNull();
  });

  it('★ phrases it as a suspicion, and says how to undo it', () => {
    /*
      Attribution is a suspicion. The effect that was drawing is the best
      available evidence, not proof — so the message has to leave the user a
      way to disagree, or the innocent case has no recovery.
    */
    jest.spyOn(useUIStore.getState(), 'notify').mockImplementation(() => '');
    beginEffectDraw(ID);
    const blamed = noteDeviceLoss('device lost');

    expect(blamed!.reason).toMatch(/turn it back on/i);
  });
});

describe('re-enabling', () => {
  beforeEach(async () => {
    registerEffects(PLUGIN, PLUGIN_NAME, [contribution()]);
    jest.spyOn(useUIStore.getState(), 'notify').mockImplementation(() => '');
    beginEffectDraw(ID);
    noteDeviceLoss('device lost');
  });

  it('★ returns it to PENDING, not to ready', async () => {
    /*
      Re-enabling is a retry, not an exemption. It recompiles and goes through
      every gate again — a disabled effect that came straight back as `ready`
      would be trusting a shader precisely because it had already misbehaved.
    */
    reenableEffect(ID);
    expect(effectById(ID)!.state).toBe('pending');
    expect(effectById(ID)!.reason).toBe('');
  });

  it('★ is not undone quietly by a recompile', async () => {
    // `compileEffect` must not resurrect a disabled effect on its own. That
    // would undo the user's protection without asking.
    expect(await compileEffect(ID, ok)).toBe('disabled');
    expect(effectById(ID)!.state).toBe('disabled');
  });

  it('ignores a re-enable for an effect that is not disabled', () => {
    reenableEffect(ID);
    reenableEffect(ID);
    expect(effectById(ID)!.state).toBe('pending');
  });
});

describe('★ the host lifecycle drives registration', () => {
  /*
    Reads the source rather than booting the host, for the same reason
    `deviceLossWiring.test.ts` does: the defect being guarded against is the
    ABSENCE of a call. Every other test in this file would pass with these two
    lines deleted, and a plugin's effects would simply never appear.
  */
  const host = require('node:fs')
    .readFileSync(require('node:path').join(__dirname, 'PluginHost.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('registers effects when a plugin is enabled', () => {
    // On ENABLE, beside layer kinds — not on start. An effect is a compiled
    // shader and a parameter block; none of it needs the worker.
    expect(host).toMatch(/registerEffects\s*\(/);
  });

  it('unregisters them when it is disabled or uninstalled', () => {
    /*
      A disabled plugin whose effect stayed registered would keep drawing —
      including one the user disabled BECAUSE it was implicated in a device
      loss, which is the case where it matters most.
    */
    expect(host).toMatch(/unregisterEffects\s*\(/);
  });

  it('★ registers them from registerContributions, NOT from start', () => {
    /*
      Stated as a call site rather than as a position in the file. `private
      start` happens to appear EARLIER than `registerContributions`, so
      comparing offsets asserts file layout and passes or fails for reasons that
      have nothing to do with behaviour — which is what the first version of
      this test did.

      Registering from `start` would mean an effect only exists once the worker
      has booted, which defeats lazy activation: every plugin declaring one
      would have to start at launch for its effect to appear, and a document
      using one would render nothing until it did.
    */
    const bodyOf = (name: string): string => {
      const at = host.indexOf(`private ${name}(`);
      expect(at).toBeGreaterThan(-1);
      let depth = 0;
      let i = host.indexOf('{', at);
      const from = i;
      for (; i < host.length; i++) {
        if (host[i] === '{') depth++;
        else if (host[i] === '}' && --depth === 0) break;
      }
      return host.slice(from, i);
    };

    expect(bodyOf('registerContributions')).toMatch(/registerEffects\s*\(/);
    expect(bodyOf('start')).not.toMatch(/registerEffects\s*\(/);
    expect(bodyOf('unregisterContributions')).toMatch(/unregisterEffects\s*\(/);
  });
});
