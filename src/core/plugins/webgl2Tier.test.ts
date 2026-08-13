/**
 * A plugin effect on the WebGL2 tier is inert, and now says so.
 *
 * ── The failure ─────────────────────────────────────────────────────────────
 *
 * A plugin effect is WGSL. On the WebGL2 tier there is no pipeline to compile
 * or bind it, so the effect renders its input unchanged. Not slower, not
 * lower-quality — unchanged. The plugin is not degraded, it is inert.
 *
 * Nothing said so. The effect appeared in the browser, added to the stack,
 * showed its parameters, and changed no pixels. Every part of that reads as a
 * working feature except the only part the user can see, and the conclusion a
 * person reaches is "this plugin is broken" — so they uninstall something that
 * is fine, on the one machine where nothing they do will help.
 *
 * ── Why it is surfaced four ways rather than one ────────────────────────────
 *
 * Because the user meets it at four different moments, and a message they have
 * already dismissed is not there when they need it:
 *
 *   • **Install** is refused outright when the manifest REQUIRES `webgpu` —
 *     there is nothing to install that would do anything.
 *   • **The effects browser** tags the row, before the click.
 *   • **`effects.add`** returns a flag, so the plugin can say it in its own
 *     words to a user who is inside its UI rather than ours.
 *   • **The plugin's row** carries it permanently, for the person who comes
 *     back a day later wondering why nothing happens.
 *
 * And one toast, once per session — not per effect, because a generative plugin
 * adding forty would produce forty, and a user buried in them learns to dismiss
 * the notice without reading it.
 */

import pluginHost from './PluginHost';
import { usePluginStore } from '@stores/pluginStore';
import { useUIStore } from '@stores/uiStore';
import { useFakeWorkers, testPackage, bootPlugin, FakeWorker } from './fakeWorker.testkit';
import { resetEffectsForTests } from './pluginEffects';
import { resetLayerKindsForTests } from './layerKindRegistry';
import { setWebgpuAvailable, checkCapabilities } from './capabilities';
import { pluginEffectsCanRender } from '@core/effects/pluginEffectDefs';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

const PLUGIN = 'studio.acme.tint';

const EFFECT = {
  id: 'tint',
  label: 'Tint',
  shader: `
    @fragment fn fs(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      let c = textureSample(src, samp, uv);
      return vec4<f32>(c.rgb * params.amount, c.a);
    }
  `,
  params: { amount: { type: 'number', default: 1, min: 0, max: 4 } },
};

const pkg = (extra: Record<string, unknown> = {}) =>
  testPackage(['scene:read', 'scene:write'], PLUGIN, {
    apiVersion: 5,
    name: 'Tint',
    contributes: { effects: [EFFECT] },
    activationEvents: ['onStartup'],
    ...extra,
  });

beforeAll(async () => {
  useFakeWorkers();
  await usePluginStore.getState().hydrate();
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  pluginHost.configure({ getSelection: () => [] });
});
afterAll(() => { pluginHost.setWorkerFactory(null); });

beforeEach(() => {
  for (const p of [...usePluginStore.getState().plugins]) pluginHost.uninstall(p.manifest.id);
  resetEffectsForTests();
  resetLayerKindsForTests();
  setWebgpuAvailable(true);
  defaultSceneGraph.clear();
  seedDefaultScene();
  FakeWorker.last = null;
  useUIStore.setState({ notifications: [] });
});
afterEach(() => setWebgpuAvailable(true));

/** Boot the plugin and create a layer to hang an effect on. */
function boot(): { worker: FakeWorker; layerId: string } {
  const worker = bootPlugin(pkg(), { granted: ['scene:read', 'scene:write'] });
  const layerId = (worker.callAndWait('scene.createLayer', {
    kind: 'shape', name: 'Target',
  }) as { value: string }).value;
  return { worker, layerId };
}

describe('the tier is reported honestly', () => {
  it('says effects can render on WebGPU', () => {
    expect(pluginEffectsCanRender()).toBe(true);
  });

  it('says they cannot on WebGL2', () => {
    setWebgpuAvailable(false);
    expect(pluginEffectsCanRender()).toBe(false);
  });
});

describe('a plugin that REQUIRES webgpu', () => {
  it('is refused at install, with the machine named', () => {
    /*
      Refused rather than installed-and-inert. There is nothing for it to do
      here, and a plugin sitting in the list looking healthy while doing nothing
      is the exact confusion this whole item exists to remove.
    */
    setWebgpuAvailable(false);
    const err = pluginHost.install(
      pkg({ requires: ['webgpu'] }),
      ['scene:read', 'scene:write'],
      { source: 'registry' },
    );
    expect(err).toMatch(/WebGL2 fallback/i);
    expect(usePluginStore.getState().get(PLUGIN)).toBeUndefined();
  });

  it('installs normally on WebGPU', () => {
    expect(pluginHost.install(
      pkg({ requires: ['webgpu'] }),
      ['scene:read', 'scene:write'],
      { source: 'registry' },
    )).toBeNull();
  });
});

describe('a plugin that merely CONTRIBUTES effects', () => {
  it('still installs on WebGL2', () => {
    /*
      The common case, and it must not be refused. A plugin that adds a command,
      a panel AND an effect is useful here minus the effect — refusing the whole
      thing would take away the parts that work. `requires: ['webgpu']` is how
      an author says otherwise, and it is theirs to decide.
    */
    setWebgpuAvailable(false);
    expect(pluginHost.install(pkg({ apiVersion: 5 }), ['scene:read', 'scene:write'], { source: 'registry' }))
      .toBeNull();
  });
});

describe('effects.add on the WebGL2 tier', () => {
  it('SUCCEEDS, and returns a flag saying it will not draw', () => {
    /*
      Not a failure, deliberately. The effect is in the document, it is saved
      with it, and it renders the moment the file is opened on a WebGPU machine.
      Refusing would make a plugin that works everywhere look broken here — and
      would tempt an author to strip the effect out of the document to "fix" it,
      which loses the user's work on every other machine.
    */
    setWebgpuAvailable(false);
    const { worker, layerId } = boot();

    const reply = worker.callAndWait('effects.add', layerId, `${PLUGIN}.tint`);
    expect(reply.ok).toBe(true);
    expect(reply.ok && reply.value).toMatchObject({ active: false, reason: 'webgpu-unavailable' });
  });

  it('puts the effect in the document regardless', () => {
    setWebgpuAvailable(false);
    const { worker, layerId } = boot();
    worker.callAndWait('effects.add', layerId, `${PLUGIN}.tint`);

    const node = defaultSceneGraph.getNode(layerId)!;
    const fx = node.components.find((c) => c.type === 'fx');
    expect(JSON.stringify(fx?.props)).toContain(`${PLUGIN}.tint`);
  });

  it('returns a bare id on WebGPU, exactly as before', () => {
    // The unchanged path. A plugin written before any of this reads the return
    // value as an id, and must keep being able to.
    const { worker, layerId } = boot();
    const reply = worker.callAndWait('effects.add', layerId, `${PLUGIN}.tint`);
    expect(typeof (reply.ok && reply.value)).toBe('string');
  });

  it('returns a bare id for a BUILT-IN effect on WebGL2', () => {
    // Built-ins render fine on WebGL2. Flagging them would be a false alarm on
    // every effect in the app.
    setWebgpuAvailable(false);
    const { worker, layerId } = boot();
    const reply = worker.callAndWait('effects.add', layerId, 'blur');
    expect(typeof (reply.ok && reply.value)).toBe('string');
  });
});

describe('the toast', () => {
  it('fires once, however many effects are added', () => {
    /*
      Per session, not per effect. A generative plugin adding forty effects
      would otherwise produce forty identical toasts, and a user buried in them
      learns to dismiss the notice without reading — which is the same outcome
      as never showing it, at more cost.
    */
    setWebgpuAvailable(false);
    const { worker, layerId } = boot();
    for (let i = 0; i < 5; i++) worker.callAndWait('effects.add', layerId, `${PLUGIN}.tint`);

    const about = useUIStore.getState().notifications.filter((n) => /WebGPU/i.test(n.message));
    expect(about).toHaveLength(1);
    expect(about[0]!.message).toMatch(/saved with your project/i);
  });

  it('does not fire at all on WebGPU', () => {
    const { worker, layerId } = boot();
    worker.callAndWait('effects.add', layerId, `${PLUGIN}.tint`);
    expect(useUIStore.getState().notifications.filter((n) => /WebGPU/i.test(n.message))).toHaveLength(0);
  });
});

describe('the capability behind all of it', () => {
  it('is absent from the host set on WebGL2', () => {
    setWebgpuAvailable(false);
    expect(checkCapabilities(5, ['webgpu']).unavailable).toEqual(['webgpu']);
  });

  it('distinguishes a missing backend from a nonsense capability', () => {
    // Different problems, different answers. "Your manifest has a typo" is
    // wrong and insulting when the plugin is fine and the laptop has no WebGPU.
    setWebgpuAvailable(false);
    expect(checkCapabilities(5, ['webgpu']).message).not.toMatch(/typo/i);
    expect(checkCapabilities(5, ['scene.telepathy']).message).toMatch(/typo/i);
  });
});
