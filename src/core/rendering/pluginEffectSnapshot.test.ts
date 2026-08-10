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

/**
 * A CHAIN reaching the scene, which is the seam the GPU probe cannot see.
 *
 * `verify-plugin-chain` proves the composed shaders blur correctly when a host
 * ping-pongs them — it builds that ping-pong itself, in a standalone harness.
 * What it cannot prove is that THIS function hands the renderer more than one
 * draw. Between the two lies the exact bug 3.3 shipped with: passes composed,
 * registered, and then a single scene entry emitted, so the renderer faithfully
 * drew half a blur.
 *
 * So this asserts the count and the ordering at the seam, and the probe asserts
 * the pixels. Neither is sufficient alone.
 */
describe('a multi-pass effect reaching the scene', () => {
  const CHAIN_PLUGIN = 'studio.acme.blur';
  const CHAIN_ID = `${CHAIN_PLUGIN}.gaussian`;
  const fs = (axis: string) =>
    '@fragment fn fs(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {'
    + `  return textureSample(src, samp, uv + vec2<f32>(${axis}));`
    + '}';

  const chain: EffectContribution = {
    id: 'gaussian',
    label: 'Gaussian',
    shader: fs('params.texelSize.x, 0.0'),
    params: { radius: { type: 'number', default: 4 } },
    passes: [
      { name: 'horizontal', wgsl: fs('params.texelSize.x, 0.0'), scale: 1, reads: 'previous' },
      { name: 'vertical', wgsl: fs('0.0, params.texelSize.y'), scale: 1, reads: 'previous' },
    ],
  };

  beforeEach(async () => {
    registerEffects(CHAIN_PLUGIN, 'Acme Blur', [chain]);
    await compileEffect(CHAIN_ID, ok);
    // The outer setup REGISTERS the single-pass effect but never compiles it,
    // and a `pending` effect correctly emits nothing. The single-pass check at
    // the end of this block needs it ready, or it passes for the wrong reason.
    await compileEffect(ID, ok);
  });

  it('★ emits ONE draw per pass, not one per effect', () => {
    const spatial = spatialOf(layerWith(CHAIN_ID));
    expect(spatial).toHaveLength(2);
  });

  it('names each pass its own shader, pass 0 keeping the bare id', () => {
    // The bare id on pass 0 is the compatibility hinge: a document stores the
    // effect under it, so suffixing would break every stored reference.
    expect(spatialOf(layerWith(CHAIN_ID)).map((e) => (e as { shader: string }).shader))
      .toEqual([CHAIN_ID, `${CHAIN_ID}#vertical`]);
  });

  it('emits them in declaration order, carrying the pass index', () => {
    // Order IS the semantics — the renderer ping-pongs in the order it is
    // given, so a reversed list is a blur that runs vertical-then-horizontal.
    expect(spatialOf(layerWith(CHAIN_ID)).map((e) => (e as { passIndex?: number }).passIndex))
      .toEqual([0, 1]);
  });

  it('★ carries a downsampled pass its scale', async () => {
    /*
      The seam AE-1 turns on. The renderer reads `passScale` three ways — which
      target pool to draw into, what viewport to give the draw, and what texel
      size to hand the shader — and all three come from this one field.

      The failure if it goes missing is not an error: the pass draws at full
      size into a full-size target and looks merely "not as soft as I asked
      for", which an author debugs as their own kernel being wrong.
    */
    const scaled: EffectContribution = {
      ...chain,
      passes: [
        { name: 'down', wgsl: fs('0.0, 0.0'), scale: 0.25, reads: 'previous' },
        { name: 'up', wgsl: fs('0.0, 0.0'), scale: 1, reads: 'previous' },
      ],
    };
    resetEffectsForTests();
    registerEffects(CHAIN_PLUGIN, 'Acme Blur', [scaled]);
    await compileEffect(CHAIN_ID, ok);

    expect(spatialOf(layerWith(CHAIN_ID)).map((e) => (e as { passScale?: number }).passScale))
      .toEqual([0.25, undefined]);
  });

  it('omits passScale entirely at full scale', () => {
    // So a single-pass effect's scene entry is byte-identical to what it was
    // before any of this existed, and the renderer's `?? 1` is never exercised
    // by a value that means the same thing spelled differently.
    for (const e of spatialOf(layerWith(CHAIN_ID))) {
      expect(e).not.toHaveProperty('passScale');
    }
  });

  it('gives every pass the same parameter block', () => {
    // One pack, shared. The passes differ only in their shader and the host
    // fields the renderer writes; a per-pass copy would be the same bytes
    // allocated twice per frame.
    const [a, b] = spatialOf(layerWith(CHAIN_ID)) as Array<{ params: Float32Array }>;
    expect(a!.params).toBe(b!.params);
    expect(a!.params[UNIFORM_HEADER_BYTES / 4]).toBe(4);
  });

  it('emits NOTHING for a chain that failed to compile', async () => {
    /*
      All-or-nothing, and the reason is what a half-drawn chain looks like: not
      a weaker blur but a smear in one axis, which reads as the author's kernel
      being wrong rather than as the platform failing. `compileEffect` fails the
      whole effect on any pass, and this is the half that must then draw none.
    */
    resetEffectsForTests();
    registerEffects(CHAIN_PLUGIN, 'Acme Blur', [chain]);
    await compileEffect(CHAIN_ID, broken);
    expect(spatialOf(layerWith(CHAIN_ID))).toEqual([]);
  });

  it('still emits exactly one draw for a single-pass effect', () => {
    // The regression that would matter most, since every published effect is
    // one pass: the chain loop must not turn them into two draws.
    expect(spatialOf(layerWith(ID))).toHaveLength(1);
  });
});
