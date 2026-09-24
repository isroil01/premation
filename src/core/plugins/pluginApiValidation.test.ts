/**
 * The plugin API refusing what it used to accept silently — and accepting the
 * value shapes it used to refuse.
 *
 * Every case here is one of the two directions:
 *
 *   • A name that does not exist (`opactiy`, a Blur `radius`, a Drop Shadow
 *     `blur`) or a value outside a declared range. These all used to return
 *     success and leave junk in the document. Each refusal is checked for the
 *     suggestion it carries AND for the document being untouched.
 *   • A colour or a point as a keyframe value, a gradient given to `fill`. These
 *     used to be refused; they now map onto the tracks and paint the renderer
 *     actually reads.
 *
 * Driven through `createHostApi` directly, as `structuredProps.test.ts` is: the
 * permission gate is `PluginHost`'s concern and has its own suite.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { seedDefaultScene } from '@core/scene/seedDefaultScene';
import { insertPrimitive } from '@core/scene/sceneInsert';
import { useSelectionStore } from '@stores/selectionStore';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { getNodeEffects } from '@core/effects/effects';
import { getNodeFill } from '@core/paint/fill';
import { createHostApi } from './hostApi';
import { METHOD_PERMISSIONS } from './protocol';
import { hostCapabilities } from './capabilities';
import { closestName, editDistance } from './propValidation';
import type { PluginManifest } from './manifest';

const manifest = {
  id: 'studio.acme.check',
  name: 'Checker',
  version: '1.0.0',
  description: 'Exercises validation.',
  apiVersion: 5,
  main: 'main.js',
  permissions: ['scene:write', 'animation:write'],
  activationEvents: ['onStartup'],
  contributes: { commands: [], panels: [], layerKinds: [], effects: [], net: null },
} as unknown as PluginManifest;

const api = createHostApi(manifest, {
  registerCommand: () => {},
  openPanel: () => {},
  closePanel: () => {},
  warn: () => {},
  granted: () => new Set(['scene:read', 'scene:write', 'animation:write']) as never,
});

const call = (method: string, ...args: unknown[]): unknown => api[method]!(...args);

function newLayer(kind = 'shape'): string {
  insertPrimitive(kind as never, kind);
  return useSelectionStore.getState().ids[0]!;
}

function transformProps(id: string): Record<string, unknown> {
  return defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
}

function track(id: string, prop: string): Array<{ t: number; value: number }> | undefined {
  return defaultAnimation.tracksFor(id).find((t) => t.prop === prop)?.keyframes as
    | Array<{ t: number; value: number }>
    | undefined;
}

beforeAll(() => {
  const services = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  } as never;
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
  seedDefaultScene();
});

describe('suggestions', () => {
  it('measures edits and finds a plausible typo, and only a plausible one', () => {
    expect(editDistance('opactiy', 'opacity')).toBe(2);
    expect(closestName('opactiy', ['x', 'opacity', 'rotation'])).toBe('opacity');
    expect(closestName('RotationX', ['rotationX'])).toBe('rotationX');
    // No suggestion is better than a wrong one.
    expect(closestName('softness', ['amount'])).toBeNull();
  });
});

describe('scene.setProperty — names', () => {
  it('★ refuses an unknown name, suggests the real one, and writes nothing', () => {
    const id = newLayer();
    expect(() => call('scene.setProperty', id, 'opactiy', 50)).toThrow(/"opactiy" is not a property.*Did you mean "opacity"/);
    expect(transformProps(id)).not.toHaveProperty('opactiy');
  });

  it('keeps every name the bundled examples use working', async () => {
    // examples/plugins/depth-stack writes rotationX, rotationY and z; the
    // starter and the batch tests write x and opacity.
    const id = newLayer();
    for (const [prop, value] of [['x', 10], ['rotationX', 0], ['rotationY', 0], ['z', 3], ['opacity', 40]] as const) {
      // A plain write is an engine `setProperty` (B5): the verb resolves.
      expect(await call('scene.setProperty', id, prop, value)).toBe(true);
    }
  });

  it('sends an effect path to the verb that owns it', () => {
    const id = newLayer();
    expect(() => call('scene.setProperty', id, 'effect.fx_1.amount', 3)).toThrow(/effects\.setParam/);
  });

  it('explains that a colour channel is a keyframe track', () => {
    const id = newLayer();
    expect(() => call('scene.setProperty', id, 'fill_r', 1)).toThrow(/keyframe channel/);
  });

  it('is enforced inside a batch too, which then applies nothing', () => {
    const id = newLayer();
    expect(() => call('scene.apply', [
      { op: 'setProperty', layer: id, path: 'x', value: 77 },
      { op: 'setProperty', layer: id, path: 'blurr', value: 1 },
    ])).toThrow(/blurr/);
    expect(transformProps(id)).not.toHaveProperty('blurr');
  });
});

describe('scene.setProperty — fill', () => {
  it('★ routes a gradient object given to `fill` into the fill stack', () => {
    const id = newLayer();
    expect(call('scene.setProperty', id, 'fill', {
      type: 'linear', angle: 30,
      stops: [{ offset: 0, color: '#ff0055' }, { offset: 1, color: '#0055ff' }],
    })).toBe(true);
    expect(getNodeFill(id)?.type).toBe('linear');
  });

  it('accepts the CSS function names as type aliases', () => {
    const id = newLayer();
    call('scene.setProperty', id, 'fill', {
      type: 'radial-gradient', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }],
    });
    expect(getNodeFill(id)?.type).toBe('radial');
    call('scene.setProperty', id, 'fillPaint', {
      type: 'linear-gradient', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }],
    });
    expect(getNodeFill(id)?.type).toBe('linear');
  });

  it('★ refuses a CSS gradient STRING, spelling out the object form, and changes nothing', () => {
    const id = newLayer();
    call('scene.setProperty', id, 'fill', '#123456');
    const before = JSON.stringify(getNodeFill(id));
    expect(() => call('scene.setProperty', id, 'fill', 'linear-gradient(90deg, #f00, #00f)'))
      .toThrow(/CSS gradient string[\s\S]*type: 'linear'[\s\S]*stops/);
    expect(JSON.stringify(getNodeFill(id))).toBe(before);
  });

  it('turns a hex colour on `fill` into a solid fill rather than overwriting the fill record', async () => {
    const id = newLayer();
    expect(await call('scene.setProperty', id, 'fill', '#00ff00')).toBe(true);
    expect(getNodeFill(id)).toEqual({ type: 'solid', color: '#00ff00' });
  });
});

describe('animation.setKeyframes — names', () => {
  it('★ refuses an unknown track and creates nothing', () => {
    const id = newLayer();
    expect(() => call('animation.setKeyframes', id, 'opactiy', [{ t: 0, value: 1 }]))
      .toThrow(/"opactiy" is not an animatable property.*Did you mean "opacity"/);
    expect(track(id, 'opactiy')).toBeUndefined();
  });

  it('still writes numbers to a real track', async () => {
    const id = newLayer();
    await call('animation.setKeyframes', id, 'x', [{ t: 0, value: 0 }, { t: 1, value: 100 }]);
    expect(track(id, 'x')?.map((k) => k.value)).toEqual([0, 100]);
  });

  it('refuses a plugin prop path on a layer that is not a plugin layer', () => {
    const id = newLayer();
    expect(() => call('animation.setKeyframes', id, 'plugin.focal', [{ t: 0, value: 1 }])).toThrow(/not a plugin layer/);
  });

  it('refuses a param the effect does not have', async () => {
    const id = newLayer();
    const fx = await (call('effects.add', id, 'glow') as Promise<string>);
    expect(() => call('animation.setKeyframes', id, `effect.${fx}.threshold`, [{ t: 0, value: 1 }]))
      .toThrow(/"threshold" is not a parameter of Glow/);
  });
});

describe('animation.setKeyframes — typed values', () => {
  it('★ writes a hex colour as the four 0..1 channel tracks ColorKfRow writes', () => {
    const id = newLayer();
    call('animation.setKeyframes', id, 'fill', [
      { t: 0, value: '#ff000080' },
      { t: 1, value: '#0000ff' },
    ]);
    expect(track(id, 'fill_r')?.map((k) => k.value)).toEqual([1, 0]);
    expect(track(id, 'fill_b')?.map((k) => k.value)).toEqual([0, 1]);
    expect(track(id, 'fill_a')![0]!.value).toBeCloseTo(128 / 255, 5);
    expect(track(id, 'fill_a')![1]!.value).toBe(1);
    expect(track(id, 'fill')).toBeUndefined();
  });

  it('accepts { r, g, b, a } in CSS rgba units', () => {
    const id = newLayer();
    call('animation.setKeyframes', id, 'stroke', [{ t: 0, value: { r: 0, g: 255, b: 0, a: 0.5 } }]);
    expect(track(id, 'stroke_g')![0]!.value).toBe(1);
    expect(track(id, 'stroke_a')![0]!.value).toBe(0.5);
    expect(() => call('animation.setKeyframes', id, 'stroke', [{ t: 0, value: { r: 300, g: 0, b: 0 } }]))
      .toThrow(/"keyframe\[0\]\.value\.r" must be a number from 0 to 255/);
  });

  it('animates an effect colour param through its channels, one keyframe at a time too', async () => {
    const id = newLayer();
    const fx = await (call('effects.add', id, 'glow') as Promise<string>);
    call('animation.setKeyframe', id, `effect.${fx}.color`, 0.5, '#00ff00');
    expect(track(id, `effect.${fx}.color_g`)).toEqual([expect.objectContaining({ t: 0.5, value: 1 })]);
  });

  it('★ writes a point to its axis tracks', async () => {
    const id = newLayer();
    await call('animation.setKeyframes', id, 'position', [{ t: 0, value: { x: 10, y: 20 } }, { t: 1, value: { x: 30, y: 40 } }]);
    expect(track(id, 'x')?.map((k) => k.value)).toEqual([10, 30]);
    expect(track(id, 'y')?.map((k) => k.value)).toEqual([20, 40]);
    await call('animation.setKeyframes', id, 'anchor', [{ t: 0, value: { x: 1, y: 2, z: 3 } }]);
    expect(track(id, 'anchorZ')![0]!.value).toBe(3);
  });

  it('refuses a colour or a point on a property that is neither', () => {
    const id = newLayer();
    expect(() => call('animation.setKeyframes', id, 'x', [{ t: 0, value: '#ffffff' }])).toThrow(/not a colour property/);
    expect(() => call('animation.setKeyframes', id, 'opacity', [{ t: 0, value: { x: 1, y: 2 } }])).toThrow(/no X\/Y tracks/);
  });

  it('refuses an unsupported value by naming the supported ones', () => {
    const id = newLayer();
    expect(() => call('animation.setKeyframes', id, 'x', [{ t: 0, value: true }])).toThrow(/number, a colour .* or a point/);
    expect(() => call('animation.setKeyframes', id, 'fill', [{ t: 0, value: 'red' }])).toThrow(/not a hex colour/);
  });

  it('refuses mixing kinds in one call, before writing any of it', () => {
    const id = newLayer();
    expect(() => call('animation.setKeyframes', id, 'fill', [{ t: 0, value: '#fff' }, { t: 1, value: 3 }]))
      .toThrow(/one call animates one kind of value/);
    expect(track(id, 'fill_r')).toBeUndefined();
  });
});

describe('effects.setParam — keys and ranges', () => {
  it('★ turns the guessed Drop Shadow "blur" into a refusal that names "softness"', async () => {
    // The exact call a real plugin shipped: a name borrowed from CSS. It used
    // to store `blur` beside `softness` and render nothing different.
    const id = newLayer();
    const fx = await (call('effects.add', id, 'drop-shadow') as Promise<string>);
    expect(() => call('effects.setParam', id, fx, 'blur', 8))
      .toThrow(/"blur" is not a parameter of Drop Shadow[\s\S]*softness[\s\S]*effects\.describe\("drop-shadow"\)/);
    expect(getNodeEffects(id).find((e) => e.id === fx)?.params).not.toHaveProperty('blur');
  });

  it('★ refuses a value outside the declared range, naming it, and stores nothing', async () => {
    const id = newLayer();
    const fx = await (call('effects.add', id, 'glow') as Promise<string>);
    const before = getNodeEffects(id).find((e) => e.id === fx)?.params?.intensity;
    expect(() => call('effects.setParam', id, fx, 'intensity', 150)).toThrow(/between 0 and 100 \(%\); got 150/);
    expect(getNodeEffects(id).find((e) => e.id === fx)?.params?.intensity).toBe(before);
  });

  it('checks the value against the param type', async () => {
    const id = newLayer();
    const fx = await (call('effects.add', id, 'glow') as Promise<string>);
    expect(() => call('effects.setParam', id, fx, 'color', 'red')).toThrow(/colour string/);
    expect(() => call('effects.setParam', id, fx, 'radius', '12')).toThrow(/finite number/);
    expect(await call('effects.setParam', id, fx, 'color', '#ff0000')).toBe(true);
    expect(await call('effects.setParam', id, fx, 'radius', 60)).toBe(true);
  });
});

describe('effects.describe', () => {
  it('★ lists ids, types and the ranges setParam enforces', () => {
    const d = call('effects.describe', 'glow') as { type: string; params: Array<Record<string, unknown>> };
    expect(d.type).toBe('glow');
    expect(d.params).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'radius', type: 'number', min: 0, max: 60, settable: true, animatable: true }),
      expect.objectContaining({ id: 'color', type: 'color' }),
      expect.objectContaining({ id: 'fx.opacity', min: 0, max: 100 }),
    ]));
  });

  it('refuses an unknown type with a suggestion', () => {
    expect(() => call('effects.describe', 'glw')).toThrow(/Did you mean "glow"/);
  });

  it('needs no permission and is advertised as a capability', () => {
    expect(METHOD_PERMISSIONS['effects.describe']).toBeNull();
    expect(hostCapabilities().has('effects.describe')).toBe(true);
    expect(hostCapabilities().has('animation.typed')).toBe(true);
  });
});
