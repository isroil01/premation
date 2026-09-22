/**
 * A tool's reply must describe the scene it left behind.
 *
 * Every case here was reproduced in the desktop app by executing the tool
 * through `ToolRegistry.execute`, and every one REPORTED SUCCESS: a "radial"
 * backdrop that was linear and sat on top of the scene, a light "created" under
 * a name the scene did not contain, a second repeater that replaced the first
 * and returned its id, a "polygon" that was a square, two keyframes that became
 * one without a word, a trim on a layer with no path, a `cut` scene that was
 * opaque from t=0, and a morph that built a new layer over the one it was asked
 * to morph. So each test reads the SCENE back rather than the reply — and then
 * checks the reply agrees with it.
 */

import { ToolRegistry } from '@motion/ai-tools';
import type { ToolContext } from '@motion/ai-tools';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNodeFill } from '@core/paint/fill';
import { readNodePolystar } from '@core/scene/polystar';
import { applyPathOpChain, readPathOps, resolvePathOps, readTrimOp } from '@core/scene/pathOps';
import { getNodeEffects } from '@core/effects/effects';
import { EFFECT_DEFS, BLUR_MAX_PX } from '@core/effects/effects';
import { insertSvgLayer } from '@core/scene/sceneInsert';
import { readNodeKind } from '@core/scene/sceneDerive';
import { measureTextNodeBoxes } from '@core/text/measureText';
import { useProjectStore } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import type { SceneNode } from '@core/types';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
}

const ctx = (): ToolContext => createToolContext(new AbortController().signal);

function shape(id: string, kind = 'shape'): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 100, y: 100, width: 100, height: 100 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ],
  } as unknown as SceneNode;
}

beforeEach(() => {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root', name: 'Main', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  } as unknown as SceneNode);
  const actions = useProjectStore.getState().actions;
  actions.resetTabs();
  actions.replaceComps({
    comp_root: { id: 'comp_root', name: 'Main', width: 1920, height: 1080, fps: 30, durationSeconds: 12, background: '#101014', transparent: false, startFrame: 0 },
  });
  getTimelineController().syncFromScene('comp_root');
});

const idOf = (res: { data?: unknown }): string => (res.data as { id: string }).id;

describe('create_gradient', () => {
  it('kind "radial" produces a RADIAL fill, not a left→right ramp', async () => {
    const res = await registry().execute('create_gradient', { kind: 'radial', stops: ['#ff0000', '#0000ff'] }, ctx());
    expect(res.ok).toBe(true);
    const id = idOf(res);

    const fill = readNodeFill(defaultSceneGraph.getNode(id)!);
    expect(fill?.type).toBe('radial');
    if (fill?.type !== 'radial') return;
    expect([fill.cx, fill.cy]).toEqual([0.5, 0.5]);
    // 1 = the last stop lands on the corners; less leaves a flat band.
    expect(fill.radius).toBe(1);
    expect(fill.stops.map((s) => [s.offset, s.color])).toEqual([[0, '#ff0000'], [1, '#0000ff']]);
    // The bug: radial went through `gradient-ramp`, which has no radial mode.
    expect(getNodeEffects(id).some((e) => e.type === 'gradient-ramp')).toBe(false);
  });

  it('keeps every stop of a 3-stop radial, evenly spaced', async () => {
    const res = await registry().execute('create_gradient', { kind: 'radial', stops: ['#111111', '#555555', '#999999'], centerX: 25, radius: 50 }, ctx());
    const fill = readNodeFill(defaultSceneGraph.getNode(idOf(res))!);
    if (fill?.type !== 'radial') throw new Error('not radial');
    expect(fill.stops.map((s) => s.offset)).toEqual([0, 0.5, 1]);
    expect(fill.cx).toBe(0.25);
    expect(fill.radius).toBe(0.5);
  });

  it('a backdrop goes to the BOTTOM of the stack, and the reply says so', async () => {
    defaultSceneGraph.addChild('comp_root', shape('hero') as never);
    defaultSceneGraph.addChild('comp_root', shape('logo') as never);
    const res = await registry().execute('create_gradient', { stops: ['#000000', '#222244'] }, ctx());
    // Index 0 is the BACK-most sibling (SceneGraph.getChildOrder).
    expect(defaultSceneGraph.getChildOrder('comp_root')).toEqual([idOf(res), 'hero', 'logo']);
    expect(res.content).toMatch(/BOTTOM of the layer stack/);
  });

  it('placement "top" is still reachable, and is reported as covering the scene', async () => {
    defaultSceneGraph.addChild('comp_root', shape('hero') as never);
    const res = await registry().execute('create_gradient', { stops: ['#000000', '#222244'], placement: 'top' }, ctx());
    expect(defaultSceneGraph.getChildOrder('comp_root')).toEqual(['hero', idOf(res)]);
    expect(res.content).toMatch(/on TOP/);
  });

  it('a radial backdrop can be animated: its centre/radius pass the keyframe gate', async () => {
    const reg = registry();
    const c = ctx();
    const id = idOf(await reg.execute('create_gradient', { kind: 'radial', stops: ['#ff0000', '#0000ff'] }, c));
    const res = await reg.execute('set_keyframes', { keyframes: [
      { nodeId: id, prop: 'fillRadius', t: 0, value: 0.2 },
      { nodeId: id, prop: 'fillRadius', t: 2, value: 1 },
    ] }, c);
    expect(res.ok).toBe(true);
  });
});

describe('create_layer', () => {
  it('kind "light" honours the name, and the reply names the real layer', async () => {
    const res = await registry().execute('create_layer', { kind: 'light', name: 'My Key Light' }, ctx());
    expect(res.ok).toBe(true);
    const node = defaultSceneGraph.getNode(idOf(res))!;
    expect(readNodeKind(node)).toBe('light');
    expect(node.name).toBe('My Key Light');
    expect(res.content).toContain(`'${node.name}'`);
    expect((res.data as { name: string }).name).toBe(node.name);
  });

  it.each(['camera', 'adjustment', 'particle'] as const)('kind "%s" is named as asked too', async (kind) => {
    const res = await registry().execute('create_layer', { kind, name: `My ${kind}` }, ctx());
    expect(res.ok).toBe(true);
    expect(defaultSceneGraph.getNode(idOf(res))!.name).toBe(`My ${kind}`);
  });

  it('shape "polygon" is a parametric polystar with the requested side count', async () => {
    const res = await registry().execute('create_layer', { kind: 'shape', name: 'Oct', shape: 'polygon', points: 8, outerRadius: 120, roundness: 20 }, ctx());
    expect(res.ok).toBe(true);
    const node = defaultSceneGraph.getNode(idOf(res))!;
    const ps = readNodePolystar(node);
    expect(ps).toMatchObject({ starType: 'polygon', points: 8, outerRadius: 120, outerRoundness: 20 });
    const t = node.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;
    // NOT 'polygon' — a primitive name with no SDF and no Geometry draws a square.
    expect(t.shapeType).toBe('polystar');
    expect([t.width, t.height]).toEqual([240, 240]);
    expect(res.content).toMatch(/parametric polygon: 8 points/);
  });

  it('shape "star" takes points and an inner radius', async () => {
    const res = await registry().execute('create_layer', { kind: 'shape', name: 'Star', shape: 'star', points: 7, outerRadius: 100, innerRadius: 30 }, ctx());
    const ps = readNodePolystar(defaultSceneGraph.getNode(idOf(res))!);
    expect(ps).toMatchObject({ starType: 'star', points: 7, outerRadius: 100, innerRadius: 30 });
  });

  it('an un-parameterised polygon / star keeps its familiar look (hexagon, 5 points)', async () => {
    const reg = registry();
    const hex = readNodePolystar(defaultSceneGraph.getNode(idOf(await reg.execute('create_layer', { kind: 'shape', name: 'P', shape: 'polygon', width: 300, height: 300 }, ctx())))!);
    const star = readNodePolystar(defaultSceneGraph.getNode(idOf(await reg.execute('create_layer', { kind: 'shape', name: 'S', shape: 'star' }, ctx())))!);
    expect(hex).toMatchObject({ points: 6, outerRadius: 150 });
    expect(star).toMatchObject({ points: 5, outerRadius: 100, innerRadius: 50 });
  });

  it('a rect stays a rect — no polystar is attached', async () => {
    const res = await registry().execute('create_layer', { kind: 'shape', name: 'R', shape: 'rect' }, ctx());
    expect(readNodePolystar(defaultSceneGraph.getNode(idOf(res))!)).toBeNull();
  });
});

describe('add_repeater', () => {
  it('a second call APPENDS a repeater with its own id', async () => {
    defaultSceneGraph.addChild('comp_root', shape('dot') as never);
    const reg = registry();
    const a = await reg.execute('add_repeater', { nodeId: 'dot', copies: 5, positionX: 40 }, ctx());
    const b = await reg.execute('add_repeater', { nodeId: 'dot', copies: 4, positionY: 40 }, ctx());
    const idA = (a.data as { opId: string }).opId;
    const idB = (b.data as { opId: string }).opId;
    expect(idA).not.toBe(idB);

    const reps = readPathOps(defaultSceneGraph.getNode('dot')!).filter((o) => o.type === 'repeater');
    expect(reps.map((o) => o.id)).toEqual([idA, idB]);
    expect(reps.map((o) => [o.copies, o.offsetX, o.offsetY])).toEqual([[5, 40, 0], [4, 0, 40]]);
    expect(b.content).toMatch(/20 copies in all/);
  });

  it('the render chain applies stacked repeaters in order: row × column = a grid', async () => {
    defaultSceneGraph.addChild('comp_root', shape('dot') as never);
    const reg = registry();
    await reg.execute('add_repeater', { nodeId: 'dot', copies: 5, positionX: 40 }, ctx());
    await reg.execute('add_repeater', { nodeId: 'dot', copies: 4, positionY: 30 }, ctx());

    const ops = resolvePathOps(defaultSceneGraph.getNode('dot')!, undefined);
    const runs = applyPathOpChain([{ closed: true, pts: [{ x: 0, y: 0 }] }], ops);
    expect(runs).toHaveLength(20);
    const cells = new Set(runs.map((r) => `${Math.round(r.pts[0]!.x)},${Math.round(r.pts[0]!.y)}`));
    expect(cells.size).toBe(20);
    expect(cells.has('160,90')).toBe(true); // the far corner: 4 steps right, 3 down
  });

  it('opId UPDATES that repeater in place, patching only what was passed', async () => {
    defaultSceneGraph.addChild('comp_root', shape('dot') as never);
    const reg = registry();
    const a = await reg.execute('add_repeater', { nodeId: 'dot', copies: 5, positionX: 40 }, ctx());
    const opId = (a.data as { opId: string }).opId;
    const u = await reg.execute('add_repeater', { nodeId: 'dot', opId, copies: 9 }, ctx());
    expect(u.ok).toBe(true);
    const reps = readPathOps(defaultSceneGraph.getNode('dot')!).filter((o) => o.type === 'repeater');
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ id: opId, copies: 9, offsetX: 40 });
  });

  it('an unknown opId is a repair message, not a silent append', async () => {
    defaultSceneGraph.addChild('comp_root', shape('dot') as never);
    const res = await registry().execute('add_repeater', { nodeId: 'dot', opId: 'op_nope', copies: 3 }, ctx());
    expect(res.ok).toBe(false);
    expect(readPathOps(defaultSceneGraph.getNode('dot')!)).toHaveLength(0);
  });
});

describe('set_keyframes', () => {
  it('names the keys that merged when two land on one frame', async () => {
    defaultSceneGraph.addChild('comp_root', shape('box') as never);
    getTimelineController().syncFromScene('comp_root');
    const res = await registry().execute('set_keyframes', { keyframes: [
      { nodeId: 'box', prop: 'opacity', t: 0, value: 0 },
      { nodeId: 'box', prop: 'opacity', t: 0.01, value: 100 },
      { nodeId: 'box', prop: 'opacity', t: 1, value: 50 },
    ] }, ctx());
    expect(res.ok).toBe(true);
    // The engine's rule (snap to the frame grid) stands…
    expect(defaultAnimation.tracksFor('box').find((t) => t.prop === 'opacity')!.keyframes).toHaveLength(2);
    // …but it is no longer silent.
    expect(res.content).toMatch(/keyframes\[0\] \(t=0s\) and keyframes\[1\] \(t=0\.01s\)/);
    expect(res.content).toMatch(/Set 2 keyframes/);
    expect((res.data as { merged: Array<{ kept: number; replaced: number }> }).merged).toEqual([
      expect.objectContaining({ nodeId: 'box', prop: 'opacity', kept: 1, replaced: 0 }),
    ]);
  });

  it('says nothing when every key has its own frame', async () => {
    defaultSceneGraph.addChild('comp_root', shape('box') as never);
    getTimelineController().syncFromScene('comp_root');
    const res = await registry().execute('set_keyframes', { keyframes: [
      { nodeId: 'box', prop: 'opacity', t: 0, value: 0 },
      { nodeId: 'box', prop: 'opacity', t: 1 / 30, value: 100 },
    ] }, ctx());
    expect(res.content).not.toMatch(/MERGED/);
    expect(res.data).toBeUndefined();
  });
});

describe('set_trim_path', () => {
  const RING = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#fff" stroke-width="6"/></svg>';

  it('refuses an SVG layer honestly instead of storing a trim nothing renders', async () => {
    const svgId = insertSvgLayer(RING, 'Ring')!;
    expect(svgId).toBeTruthy();
    const res = await registry().execute('set_trim_path', { nodeId: svgId, end: 50 }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/convertSvg: true/);
    expect(readTrimOp(defaultSceneGraph.getNode(svgId)!)).toBeNull();
  });

  it.each(['text', 'group', 'image'])('refuses a %s layer too', async (kind) => {
    defaultSceneGraph.addChild('comp_root', shape('n', kind) as never);
    const res = await registry().execute('set_trim_path', { nodeId: 'n', end: 50 }, ctx());
    expect(res.ok).toBe(false);
    expect(readTrimOp(defaultSceneGraph.getNode('n')!)).toBeNull();
  });

  it('still trims a shape (and a solid, which renders down the shape path)', async () => {
    defaultSceneGraph.addChild('comp_root', shape('line') as never);
    defaultSceneGraph.addChild('comp_root', shape('plate', 'solid') as never);
    const reg = registry();
    expect((await reg.execute('set_trim_path', { nodeId: 'line', end: 40 }, ctx())).ok).toBe(true);
    expect((await reg.execute('set_trim_path', { nodeId: 'plate', end: 40 }, ctx())).ok).toBe(true);
    expect(readTrimOp(defaultSceneGraph.getNode('line')!)!.end).toBe(40);
  });
});

describe('add_scene', () => {
  const bgOf = (n: number): string =>
    defaultSceneGraph.getChildren('comp_root').find((c) => c.name === `Scene ${n} BG`)!.id;

  it('a CUT scene is not live before its start: its bar begins at the scene start', async () => {
    const reg = registry();
    const c = ctx();
    await reg.execute('add_scene', { index: 1, startSec: 0, durationSec: 8, background: '#101010' }, c);
    await reg.execute('add_scene', { index: 2, startSec: 8, durationSec: 4, background: '#303030', transition: 'cut' }, c);

    const tl = getTimelineController();
    const bar2 = tl.clipStartsForNode(bgOf(2));
    expect(bar2).toHaveLength(1);
    expect(bar2[0]!.startSeconds).toBeCloseTo(8);
    // Scene 1 starts at 0 and is untouched.
    expect(tl.clipStartsForNode(bgOf(1))[0]!.startSeconds).toBe(0);
  });

  it('the in-point is set for a dissolve as well — every transition type', async () => {
    const reg = registry();
    const c = ctx();
    await reg.execute('add_scene', { index: 1, startSec: 0, durationSec: 4, background: '#101010' }, c);
    await reg.execute('add_scene', { index: 2, startSec: 4, durationSec: 4, background: '#303030' }, c);
    expect(getTimelineController().clipStartsForNode(bgOf(2))[0]!.startSeconds).toBeCloseTo(4);
  });

  it('REGRESSION: the cut\'s opacity keys survive the frame snap (0 before, 100 at the start)', async () => {
    const reg = registry();
    const c = ctx();
    await reg.execute('add_scene', { index: 1, startSec: 0, durationSec: 8, background: '#101010' }, c);
    await reg.execute('add_scene', { index: 2, startSec: 8, durationSec: 4, background: '#303030', transition: 'cut' }, c);
    const keys = defaultAnimation.tracksFor(bgOf(2)).find((t) => t.prop === 'opacity')!.keyframes;
    // The old pair sat 1 ms apart and merged into a lone 100 — opaque from t=0.
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.value)).toEqual([0, 100]);
    expect(keys[1]!.t - keys[0]!.t).toBeGreaterThanOrEqual(1 / 30 - 1e-6);
  });

  it('content bound to a scene starts with the scene', async () => {
    const reg = registry();
    const c = ctx();
    await reg.execute('add_scene', { index: 1, startSec: 0, durationSec: 5, background: '#101010' }, c);
    await reg.execute('add_scene', { index: 2, startSec: 5, durationSec: 5, background: '#303030', transition: 'cut' }, c);
    const before = new Set(defaultSceneGraph.getChildren('comp_root').map((n) => n.id));
    await reg.execute('add_kinetic_title', { text: 'Hello there', scene: 2 }, c);
    const words = defaultSceneGraph.getChildren('comp_root').filter((n) => !before.has(n.id));
    expect(words.length).toBe(2);
    for (const w of words) {
      expect(getTimelineController().clipStartsForNode(w.id)[0]!.startSeconds).toBeCloseTo(5);
    }
  });
});

describe('add_path_morph', () => {
  it('morphs the layer it is GIVEN — no new layer, fill untouched, amount keyframed', async () => {
    defaultSceneGraph.addChild('comp_root', shape('badge') as never);
    const count = defaultSceneGraph.getChildren('comp_root').length;
    const res = await registry().execute('add_path_morph', { nodeId: 'badge', op: 'puckerBloat', amount: 60, startSec: 1, durationSec: 2 }, ctx());
    expect(res.ok).toBe(true);
    expect(defaultSceneGraph.getChildren('comp_root')).toHaveLength(count);

    const data = res.data as { id: string; opId: string; prop: string; created: boolean };
    expect(data).toMatchObject({ id: 'badge', created: false });
    const ops = readPathOps(defaultSceneGraph.getNode('badge')!);
    expect(ops).toEqual([expect.objectContaining({ id: data.opId, type: 'pucker', amount: 60 })]);

    // A morph MOVES: the operator amount is a track, 0 → 60 over the span asked.
    const track = defaultAnimation.tracksFor('badge').find((t) => t.prop === data.prop)!;
    expect(track.keyframes.map((k) => [k.t, k.value])).toEqual([[1, 0], [3, 60]]);
    // And nothing else about the caller's layer was animated or restyled.
    expect(defaultAnimation.tracksFor('badge').map((t) => t.prop)).toEqual([data.prop]);
    const style = defaultSceneGraph.getNode('badge')!.components.find((c) => c.type === 'Style')!;
    expect(style.props.fill).toBe('#ffffff');
  });

  it('creates a layer only when no nodeId is given, in the requested fill', async () => {
    const res = await registry().execute('add_path_morph', { fill: '#ff3366', op: 'zigzag' }, ctx());
    const data = res.data as { id: string; created: boolean };
    expect(data.created).toBe(true);
    const node = defaultSceneGraph.getNode(data.id)!;
    expect(node.components.find((c) => c.type === 'Style')!.props.fill).toBe('#ff3366');
    // A real star, not the square `shapeType: 'star'` used to draw.
    expect(readNodePolystar(node)?.starType).toBe('star');
  });

  it('refuses a layer with no path, and an unknown id', async () => {
    defaultSceneGraph.addChild('comp_root', shape('label', 'text') as never);
    const reg = registry();
    expect((await reg.execute('add_path_morph', { nodeId: 'label' }, ctx())).ok).toBe(false);
    expect((await reg.execute('add_path_morph', { nodeId: 'ghost' }, ctx())).ok).toBe(false);
    expect(readPathOps(defaultSceneGraph.getNode('label')!)).toHaveLength(0);
  });
});

describe('add_kinetic_title', () => {
  it('sets words with ONE gap between every pair, whatever their lengths', async () => {
    const res = await registry().execute('add_kinetic_title', { text: 'Every frame tells a story', fontSize: 100 }, ctx());
    expect(res.ok).toBe(true);
    const words = defaultSceneGraph.getChildren('comp_root')
      .map((n) => {
        const t = n.components.find((c) => c.type === 'Transform')!.props as { x: number };
        const content = String(n.components.find((c) => c.type === 'Text')!.props.content);
        // The SAME measurer the renderer sizes the word with; the per-character
        // estimate is only what the recipe falls back to with no canvas at all.
        const w = measureTextNodeBoxes(n)?.advance ?? content.length * 100 * 0.56;
        return { x: t.x, content, w };
      })
      .sort((a, b) => a.x - b.x);
    expect(words.map((w) => w.content)).toEqual(['Every', 'frame', 'tells', 'a', 'story']);

    // Edge to edge, every pair is ONE gap apart. The bug was a slot estimated
    // from the letter COUNT with the word centred in it, so "frame" and "tells"
    // (five letters each, different widths) sat at different distances.
    const width = (w: { w: number }): number => w.w;
    const gaps = words.slice(1).map((w, i) => (w.x - width(w) / 2) - (words[i]!.x + width(words[i]!) / 2));
    expect(gaps[0]!).toBeGreaterThan(0);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 3);
    // …and that the line is centred on the comp.
    const left = words[0]!.x - width(words[0]!) / 2;
    const right = words[4]!.x + width(words[4]!) / 2;
    expect((left + right) / 2).toBeCloseTo(960, 3);
  });
});

describe('blur', () => {
  it('reaches far past the old 40px slider bound', () => {
    const amount = EFFECT_DEFS.find((d) => d.type === 'blur')!.params[0]!;
    expect(amount.max).toBe(BLUR_MAX_PX);
    expect(BLUR_MAX_PX).toBeGreaterThanOrEqual(200);
  });
});
