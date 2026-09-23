/**
 * propRefs — the one place UI code turns what it holds today (track names,
 * component props, effect/mask/animator/style ids) into API property paths.
 * Every path built here must be one the engine's catalog actually has, and a
 * write composed here must apply.
 */

import { unwrap, parsePropPath } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { setupEngine, sec, type Harness } from '../__testHelpers__/harness';
import { buildScene, type Scene } from '../__testHelpers__/scene';
import { catalogFor } from '../props';
import {
  paths,
  values,
  ref,
  propRefForTrack,
  pathForTrack,
  propRefForComponentProp,
  memberWrite,
  scalarWrites,
  numbersOfValue,
  valueOfNumbers,
  compTime,
} from '../propRefs';

jest.useFakeTimers();

describe('paths (pure)', () => {
  test.each([
    [paths.transform('opacity'), 'transform/opacity'],
    [paths.transform('anchorPoint'), 'transform/anchorPoint'],
    [paths.positionDimension('x'), 'transform/position/x'],
    [paths.effectGroup('fx_1'), 'effects/fx_1'],
    [paths.effectParam('fx_1', 'radius'), 'effects/fx_1/radius'],
    [paths.effectOpacity('fx_1'), 'effects/fx_1/compositing/opacity'],
    [paths.expressionControl('ctrl_1', 'slider'), 'effects/ctrl_1/slider'],
    [paths.mask('m1', 'feather'), 'masks/m1/feather'],
    [paths.maskGroup('m1'), 'masks/m1'],
    [paths.sourceText(), 'text/sourceText'],
    [paths.textAxis('wght'), 'text/axes/wght'],
    [paths.animatorGroup('a1'), 'text/animators/a1'],
    [paths.animatorProp('a1', 'opacity'), 'text/animators/a1/props/opacity'],
    [paths.selectorParam('a1', 's1', 'start'), 'text/animators/a1/selectors/s1/start'],
    [paths.styleParam('dropShadow', 'distance'), 'styles/dropShadow/distance'],
    [paths.contents('op1', 'amount'), 'contents/op1/amount'],
    [paths.material('metal'), 'material/metal'],
    [paths.geometry('extrusionDepth'), 'geometry/extrusionDepth'],
    [paths.camera('zoom'), 'camera/zoom'],
    [paths.light('intensity'), 'light/intensity'],
    [paths.paintParam('st1', 'path'), 'paint/st1/path'],
    [paths.puppetParam('pin1', 'position'), 'puppet/pin1/position'],
    [paths.audioLevels(), 'audio/levels'],
    [paths.audioPan(), 'audio/pan'],
    [paths.timeRemap(), 'timeRemap'],
    [paths.timeSpeed(), 'layer/timeSpeed'],
    [paths.layerParam('color'), 'layer/color'],
    [paths.pluginParam('seed'), 'plugin/seed'],
  ])('%s', (built, expected) => {
    expect(built).toBe(expected);
    expect(parsePropPath(built)).not.toBeNull();
  });

  test('refuses a segment that would change the path shape', () => {
    expect(() => paths.effectParam('fx/1', 'radius')).toThrow(RangeError);
    expect(() => paths.mask('', 'path')).toThrow(RangeError);
  });

  test('values and member numbers round-trip', () => {
    expect(values.vec2(1, 2)).toEqual({ kind: 'vec2', value: { x: 1, y: 2 } });
    expect(numbersOfValue(values.color(0.1, 0.2, 0.3, 0.4))).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(valueOfNumbers('vec3', [1, 2, 3])).toEqual(values.vec3(1, 2, 3));
    expect(valueOfNumbers('bool', [1])).toEqual(values.bool(true));
    expect(ref('L', 'transform/opacity')).toEqual({ layer: 'L', path: 'transform/opacity' });
    expect(compTime(1)).toBe(705_600_000);
  });
});

describe('through the engine catalog', () => {
  let h: Harness;
  let s: Scene;
  beforeEach(async () => {
    h = await setupEngine();
    s = await buildScene(h);
  });
  afterEach(async () => { await h.dispose(); });

  const inCatalog = (layer: string, path: string): boolean => catalogFor(layer).byPath.has(path);

  test('transform tracks: opacity, rotation, merged Position members', () => {
    expect(propRefForTrack(s.A, 'opacity')).toMatchObject({ ref: { layer: s.A, path: 'transform/opacity' }, member: 0, valueType: 'scalar' });
    expect(pathForTrack(s.A, 'rotation')).toBe('transform/rotation');
    const y = propRefForTrack(s.A, 'y')!;
    expect(y.ref.path).toBe('transform/position');
    expect(y.member).toBe(1);
    expect(y.members).toEqual(expect.arrayContaining(['x', 'y']));
    expect(inCatalog(s.A, y.ref.path)).toBe(true);
  });

  test('effect, mask and text-animator tracks resolve to id-addressed paths', () => {
    const cat = catalogFor(s.A);
    const effectPath = [...cat.byPath.keys()].find((p) => p.startsWith(`effects/${s.fx}/`))!;
    const member = cat.byPath.get(effectPath)!.members[0]!;
    expect(pathForTrack(s.A, member)).toBe(effectPath);
    expect(pathForTrack(s.A, `mask.${s.mask}.feather`)).toBe(paths.mask(s.mask, 'feather'));
    // Text animators are addressed by id, never by index (§2.5 #8).
    const tCat = catalogFor(s.T);
    const animPath = [...tCat.byPath.keys()].find((p) => p.startsWith(`text/animators/${s.animator}/props/`));
    expect(animPath).toBeDefined();
    if (animPath) {
      const m = tCat.byPath.get(animPath)!.members[0]!;
      expect(m).toMatch(/^ta\.0\./);
      expect(pathForTrack(s.T, m)).toBe(animPath);
    }
  });

  test('an API path is accepted as is; unknown tracks and layers are null', () => {
    expect(pathForTrack(s.A, 'transform/opacity')).toBe('transform/opacity');
    expect(propRefForTrack(s.A, 'no.such.track')).toBeNull();
    expect(propRefForTrack('ghost', 'opacity')).toBeNull();
  });

  test('component id + prop key → path (catalog first, component root otherwise)', () => {
    const node = defaultSceneGraph.getNode(s.T)!;
    const text = node.components.find((c) => c.type === 'Text')!;
    expect(propRefForComponentProp(s.T, text.id, 'content')).toEqual({ layer: s.T, path: 'text/sourceText' });
    const withOpacity = defaultSceneGraph.getNode(s.A)!.components.find((c) => typeof (c.props as Record<string, unknown>).opacity === 'number');
    if (withOpacity) expect(propRefForComponentProp(s.A, withOpacity.id, 'opacity')!.path).toBe('transform/opacity');
    const t = defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Transform')!;
    expect(propRefForComponentProp(s.A, t.id, 'someCustomKnob')!.path).toBe('layer/someCustomKnob');
    expect(propRefForComponentProp(s.A, 'nope', 'opacity')).toBeNull();
  });

  test('memberWrite composes the whole vector and applies (static and keyed)', async () => {
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/position' }, value: values.vec2(10, 20) });
    const w = memberWrite(s.A, 'y', 99, 0)!;
    expect(w.value).toEqual(values.vec2(10, 99));
    await h.run({ type: 'setProperties', writes: [w] });
    const v = await h.query({ type: 'getPropertyValues', props: [{ layer: s.A, path: 'transform/position' }], time: 0, evaluated: false });
    expect(v.values[0]!.value).toEqual(values.vec2(10, 99));

    // Animated (B has two Position keys): the write lands as a key at the playhead.
    const wb = memberWrite(s.B, 'x', 555, 1)!;
    expect(wb.time).toBe(sec(1));
    const res = unwrap(await h.engine.execute({ type: 'setProperty', prop: wb.prop, value: wb.value, time: wb.time }));
    expect(res.keyframe).toBeTruthy();
  });

  test('memberWrite converts stored units to API units (scale is %, C3 parity)', async () => {
    // The UI hands memberWrite STORED numbers: scale 2 = a 2× multiplier.
    await h.run({ type: 'setProperty', prop: { layer: s.A, path: 'transform/scale' }, value: values.vec2(100, 100) });
    const w = memberWrite(s.A, 'scaleX', 2, 0)!;
    // …and the API value is percent: 200 % on X, the untouched Y member stays 100 %
    // (read back through readStatic, which is already in API units — no double scaling).
    expect(numbersOfValue(w.value).slice(0, 2)).toEqual([200, 100]);
    await h.run({ type: 'setProperties', writes: [w] });
    const t = defaultSceneGraph.getNode(s.A)!.components.find((c) => c.type === 'Transform')!;
    const stored = t.props as Record<string, unknown>;
    expect(stored.scaleX ?? (stored.scale as { x?: number } | undefined)?.x).toBe(2);
  });

  test('scalarWrites: one write per layer that has the property', async () => {
    const ws = scalarWrites([s.A, s.B, 'ghost'], 'opacity', (id) => (id === s.A ? 0.2 : 0.8), 0);
    expect(ws).toHaveLength(2);
    await h.run({ type: 'setProperties', writes: ws });
    const v = await h.query({ type: 'getPropertyValues', props: ws.map((w) => w.prop), time: 0, evaluated: false });
    expect(v.values.map((x) => numbersOfValue(x.value)[0])).toEqual([0.2, 0.8]);
  });
});
