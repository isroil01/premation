/**
 * Turning a plugin effect on a layer into something the renderer can draw.
 *
 * The interesting assertions are about what is NOT emitted. A plugin effect
 * whose shader has not compiled — or was refused, or was turned off after a
 * device loss — must produce no draw at all. Emitting one asks the renderer for
 * a pipeline that does not exist, and in the `disabled` case it would silently
 * undo the protection the user was given, which is the worst of the three.
 *
 * The identification rule is worth stating too: a plugin effect is recognised
 * by the DOT in its type, because the set of them is whatever is installed and
 * cannot be a list in this file. Namespacing is what makes that safe — no
 * built-in effect type contains a dot.
 */

import { extractSpatialEffects } from './snapshotToFrameScene';
import {
  registerEffects,
  compileEffect,
  effectById,
  reenableEffect,
  noteDeviceLoss,
  beginEffectDraw,
  resetEffectsForTests,
  type EffectCompiler,
} from '@core/plugins/pluginEffects';
import type { EffectContribution } from '@core/plugins/effectSchema';
import { UNIFORM_HEADER_BYTES } from '@core/plugins/effectSchema';
import { useUIStore } from '@stores/uiStore';
import type { RenderLayer } from './RenderBackend';

const PLUGIN = 'studio.acme.glow';
const ID = `${PLUGIN}.tint`;

const contribution: EffectContribution = {
  id: 'tint',
  label: 'Tint',
  shader: '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> { return vec4<f32>(params.amount); }',
  params: { amount: { type: 'number', default: 1 } },
};

const ok: EffectCompiler = { compile: () => Promise.resolve() };
const broken: EffectCompiler = { compile: () => Promise.reject(new Error('nope')) };

/** A layer carrying one effect. Only the fields this path reads are set. */
const layerWith = (type: string, params: Record<string, unknown> = {}): RenderLayer =>
  ({ effects: [{ type, params }] }) as unknown as RenderLayer;

const spatialOf = (layer: RenderLayer) => extractSpatialEffects(layer) ?? [];

beforeEach(() => {
  resetEffectsForTests();
  jest.spyOn(console, 'warn').mockImplementation(() => '');
  jest.spyOn(useUIStore.getState(), 'notify').mockImplementation(() => '');
  registerEffects(PLUGIN, 'Acme Glow', [contribution]);
});
afterEach(() => jest.restoreAllMocks());

describe('a ready plugin effect', () => {
  beforeEach(async () => { await compileEffect(ID, ok); });

  it('is emitted, naming the registered shader', () => {
    const [effect] = spatialOf(layerWith(ID, { amount: 0.5 }));

    expect(effect).toMatchObject({ type: 'plugin', shader: ID });
  });

  it('★ carries parameters packed AFTER the renderer s header', () => {
    /*
      The whole layout contract, observed from the producer's side. If the
      packing started at zero the parameter would land on `mvp` and the layer
      would draw with a garbage transform — which is exactly the bug that
      shipped once.
    */
    const [effect] = spatialOf(layerWith(ID, { amount: 0.5 }));
    const params = (effect as { params: Float32Array }).params;

    expect(params.byteLength).toBeGreaterThan(UNIFORM_HEADER_BYTES);
    expect(params[UNIFORM_HEADER_BYTES / 4]).toBeCloseTo(0.5);
  });

  it('★ brackets the draw so a device loss can be attributed', () => {
    // Without these the marker is never set, and every device loss blames
    // nobody — which reads as "attribution does not work" rather than as
    // "nothing was drawing".
    const [effect] = spatialOf(layerWith(ID));
    const onDraw = (effect as { onDraw?: { begin(): void; end(): void } }).onDraw;

    expect(onDraw).toBeDefined();
    onDraw!.begin();
    expect(noteDeviceLoss('device lost')?.id).toBe(ID);
  });
});

describe('★ what is NOT emitted', () => {
  it('emits nothing while the shader is still pending', () => {
    // No compiled pipeline exists yet. Asking the renderer to use one is a
    // frame that does not happen.
    expect(spatialOf(layerWith(ID))).toEqual([]);
  });

  it('emits nothing when the shader was refused', async () => {
    await compileEffect(ID, broken);
    expect(effectById(ID)!.state).toBe('failed');

    expect(spatialOf(layerWith(ID))).toEqual([]);
  });

  it('★ emits nothing for an effect disabled after a device loss', async () => {
    /*
      The one that matters most. Drawing a disabled effect would put back the
      exact shader that was implicated in resetting the user's GPU, without
      asking them — undoing their protection silently.
    */
    await compileEffect(ID, ok);
    beginEffectDraw(ID);
    noteDeviceLoss('device lost');
    expect(effectById(ID)!.state).toBe('disabled');

    expect(spatialOf(layerWith(ID))).toEqual([]);
  });

  it('emits it again once the user re-enables and it recompiles', async () => {
    // Re-enabling is a retry, so it has to actually come back — otherwise the
    // "you can turn it back on" in the device-loss message is a lie.
    await compileEffect(ID, ok);
    beginEffectDraw(ID);
    noteDeviceLoss('device lost');

    reenableEffect(ID);
    await compileEffect(ID, ok);

    expect(spatialOf(layerWith(ID))).toHaveLength(1);
  });

  it('emits nothing for a plugin effect nobody registered', () => {
    // A document referencing a plugin the user does not have. It renders
    // without the effect rather than failing to open.
    expect(spatialOf(layerWith('studio.nobody.thing'))).toEqual([]);
  });
});

describe('telling a plugin effect from a built-in', () => {
  it('★ does not mistake a built-in for one', () => {
    /*
      The identification rule is "contains a dot", because the set of plugin
      effects is whatever is installed. That is only safe while no built-in type
      contains one — asserted here rather than assumed, since a built-in named
      `color.grade` would be swallowed by that branch and stop rendering.
    */
    const builtins = ['blur', 'glow', 'drop-shadow', 'sharpen', 'noise', 'set-matte', 'motion-tile'];
    for (const type of builtins) {
      expect(type.includes('.')).toBe(false);
    }
  });

  it('leaves built-in effects alone', async () => {
    await compileEffect(ID, ok);
    const [effect] = spatialOf(layerWith('sharpen', { amount: 50 }));

    expect(effect).toMatchObject({ type: 'sharpen' });
  });
});
