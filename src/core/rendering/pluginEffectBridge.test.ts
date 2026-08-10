/**
 * The two steps that stood between a registered plugin effect and a drawn one.
 *
 * Both halves of this conversation were tested before any of it worked: one
 * suite proved effects register and compose, another proved the composition
 * pass draws what the scene gives it. Neither could see that the shaders never
 * reached the renderer's registry and nothing ever called `compileEffect`, so
 * every plugin effect sat at `pending` — which the scene builder skips by
 * design — and the whole surface was inert with a green test run.
 *
 * So these tests are deliberately about the JOIN, not either side:
 *
 *  - the names registered are the names the scene will ASK for, character for
 *    character (the check that would have caught two naming rules disagreeing);
 *  - `pending` becomes `ready`, because nothing renders until it does;
 *  - a driver's refusal becomes `failed` with the driver's own words, rather
 *    than a pipeline error inside a frame with no plugin attached to it;
 *  - a plugin enabled AFTER the renderer is up is not left behind.
 */

import { attachPluginEffects, backendCompiler } from './pluginEffectBridge';
import {
  registerEffects,
  unregisterEffects,
  effectById,
  registeredEffects,
} from '@core/plugins/pluginEffects';
import type { EffectContribution } from '@core/plugins/effectSchema';

const PLUGIN = 'studio.test.bridge';

/** A registry that records what it was given, standing in for the renderer's. */
function fakeRegistry() {
  const names: string[] = [];
  const sources = new Map<string, { name: string; wgsl: string }>();
  return {
    names,
    sources,
    shaders: {
      register: (s: { name: string; wgsl: string }) => {
        names.push(s.name);
        sources.set(s.name, s);
      },
      has: (n: string) => sources.has(n),
    },
  };
}

/** A backend that accepts everything, and remembers what it was asked about. */
function cleanBackend() {
  const seen: string[] = [];
  return { seen, shaderDiagnostics: async (label: string) => { seen.push(label); return []; } };
}

const FRAGMENT = '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> '
  + '{ return textureSample(src, samp, uv) * params.amount; }';

const single = (): EffectContribution => ({
  id: 'tint',
  label: 'Tint',
  params: { amount: { type: 'number', label: 'Amount', default: 1, min: 0, max: 2 } },
  shader: FRAGMENT,
} as EffectContribution);

const chain = (): EffectContribution => ({
  id: 'blur',
  label: 'Blur',
  params: { amount: { type: 'number', label: 'Amount', default: 1, min: 0, max: 2 } },
  passes: [
    { name: 'horizontal', wgsl: FRAGMENT },
    { name: 'vertical', wgsl: FRAGMENT, reads: 'previous' },
  ],
} as EffectContribution);

afterEach(() => unregisterEffects(PLUGIN));

describe('attaching plugin effects to a renderer', () => {
  test('★ registers every pass under the name the scene will ask for', async () => {
    /*
      The heart of it. `snapshotToFrameScene` emits `pass.shaderId` as the
      material's shader name, and the renderer resolves that against the
      registry — so these two lists have to be equal, and a test that checked
      either one alone would pass while they disagreed.

      They DID disagree: the registry name came from `passShaderName` (every
      pass of a chain suffixed) and the scene name was computed separately
      (pass 0 left bare). Nothing compared them because nothing connected them.
    */
    registerEffects(PLUGIN, 'Bridge', [chain()]);
    const reg = fakeRegistry();
    const detach = attachPluginEffects(reg, cleanBackend());
    await flush();
    detach();

    const asked = effectById(`${PLUGIN}.blur`)!.passes.map((p) => p.shaderId);
    // Registry CONTENTS, not the call log: a sync re-registers unconditionally
    // (see the note in the bridge), so the same name legitimately arrives more
    // than once and only the resulting set is meaningful.
    expect([...reg.sources.keys()]).toEqual(asked);
    // And spelled out, so a change to BOTH sides at once still has to be meant.
    expect(asked).toEqual([`${PLUGIN}.blur#horizontal`, `${PLUGIN}.blur#vertical`]);
  });

  test('a single-pass effect keeps its bare name', async () => {
    // The compatibility case: an effect published before chains existed must
    // resolve to exactly the key it always did.
    registerEffects(PLUGIN, 'Bridge', [single()]);
    const reg = fakeRegistry();
    const detach = attachPluginEffects(reg, cleanBackend());
    await flush();
    detach();

    expect([...reg.sources.keys()]).toEqual([`${PLUGIN}.tint`]);
  });

  test('moves an effect from pending to ready', async () => {
    registerEffects(PLUGIN, 'Bridge', [single()]);
    expect(effectById(`${PLUGIN}.tint`)!.state).toBe('pending');

    const detach = attachPluginEffects(fakeRegistry(), cleanBackend());
    await flush();
    detach();

    // `snapshotToFrameScene` emits only `ready` effects, so this IS the
    // difference between the effect drawing and doing nothing.
    expect(effectById(`${PLUGIN}.tint`)!.state).toBe('ready');
  });

  test("records the driver's complaint against the plugin, as failed", async () => {
    registerEffects(PLUGIN, 'Bridge', [single()]);
    const backend = {
      shaderDiagnostics: async () => ['line 7: unresolved call target \'nope\''],
    };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const detach = attachPluginEffects(fakeRegistry(), backend);
    await flush();
    detach();
    warn.mockRestore();

    const effect = effectById(`${PLUGIN}.tint`)!;
    expect(effect.state).toBe('failed');
    // The driver's own words, kept — a compile error paraphrased into "the
    // shader could not be compiled" is unactionable for the author.
    expect(effect.reason).toContain('unresolved call target');
  });

  test('a backend that cannot check is not a failure', async () => {
    // WebGL2 has no diagnostics to give. A plugin effect is inert there, but
    // inert is not broken, and treating "cannot check" as "failed" would take
    // the layer down with it.
    registerEffects(PLUGIN, 'Bridge', [single()]);
    const detach = attachPluginEffects(fakeRegistry(), {});
    await flush();
    detach();

    expect(effectById(`${PLUGIN}.tint`)!.state).toBe('ready');
  });

  test('picks up a plugin enabled AFTER the renderer came up', async () => {
    const reg = fakeRegistry();
    const detach = attachPluginEffects(reg, cleanBackend());
    await flush();
    expect(reg.names).toEqual([]);

    // The ordinary case in a running session: the renderer is long since up
    // and the user installs something.
    registerEffects(PLUGIN, 'Bridge', [single()]);
    await flush();
    detach();

    expect(reg.names).toContain(`${PLUGIN}.tint`);
    expect(effectById(`${PLUGIN}.tint`)!.state).toBe('ready');
  });

  test('stops listening once detached', async () => {
    const reg = fakeRegistry();
    attachPluginEffects(reg, cleanBackend())();

    registerEffects(PLUGIN, 'Bridge', [single()]);
    await flush();

    // A live subscription after teardown compiles into a registry whose device
    // is gone, once per plugin enable, for the rest of the session.
    expect(reg.names).toEqual([]);
    expect(effectById(`${PLUGIN}.tint`)!.state).toBe('pending');
  });

  test('re-registers on update rather than keeping the old source', async () => {
    registerEffects(PLUGIN, 'Bridge', [single()]);
    const reg = fakeRegistry();
    const detach = attachPluginEffects(reg, cleanBackend());
    await flush();

    // What a plugin update looks like from here: same id, new WGSL.
    const updated = { ...single(), shader: FRAGMENT.replace('params.amount', '2.0') };
    registerEffects(PLUGIN, 'Bridge', [updated as EffectContribution]);
    await flush();
    detach();

    // Skipping a name already present would leave the previous version
    // drawing — a bug that reads as the plugin caching its own shader.
    expect(reg.sources.get(`${PLUGIN}.tint`)!.wgsl).toContain('2.0');
  });
});

describe('backendCompiler', () => {
  test('rejects with every error joined, not just the first', async () => {
    const compiler = backendCompiler({ shaderDiagnostics: async () => ['a', 'b'] });
    await expect(compiler.compile('x', 'wgsl')).rejects.toThrow('a; b');
  });

  test('resolves when the backend reports nothing wrong', async () => {
    const compiler = backendCompiler({ shaderDiagnostics: async () => [] });
    await expect(compiler.compile('x', 'wgsl')).resolves.toBeUndefined();
  });
});

describe('the registry the bridge writes into', () => {
  test('gets a GLSL fallback too, so WebGL2 draws passthrough not nothing', async () => {
    registerEffects(PLUGIN, 'Bridge', [single()]);
    const reg = fakeRegistry();
    const detach = attachPluginEffects(reg, cleanBackend());
    await flush();
    detach();

    const source = reg.sources.get(`${PLUGIN}.tint`) as unknown as {
      glsl?: { vertex: string; fragment: string };
    };
    expect(source.glsl?.fragment).toBeTruthy();
  });

  test('leaves nothing registered when no plugin declares an effect', async () => {
    const reg = fakeRegistry();
    const detach = attachPluginEffects(reg, cleanBackend());
    await flush();
    detach();
    expect(registeredEffects().filter((e) => e.pluginId === PLUGIN)).toEqual([]);
    expect(reg.names).toEqual([]);
  });
});

/** Let the compile promises settle. `compileEffect` is async by contract. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
