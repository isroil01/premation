/**
 * The two properties the AI architecture rests on:
 *
 *  1. A whole prompt is ONE undoable act, and a failed run leaves no trace.
 *  2. A keyframe's value and its easing land at the SAME time (bug B1) — the
 *     old op path converted one to layer time and not the other, so on any
 *     layer whose clip didn't start at zero the easing addressed a keyframe
 *     that wasn't there, and vanished silently.
 */

import { ToolRegistry } from '@motion/ai-tools';
import type { AnimFacade, SceneFacade, ToolContext } from '@motion/ai-tools';
import { beginAiTransaction } from './aiTransaction';
import { buildAiTools } from './toolHandlers';
import { createToolContext } from './toolContext';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { sceneProjectIO } from '@core/scene/sceneProjectIO';
import { useAssetStore } from '@stores/assetStore';
import { getCommandSystem, setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

function bootCommandSystem(): void {
  const services: any = {
    undo: { push: () => {}, undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false },
    selection: { get: () => [], set: () => {}, clear: () => {} },
    panels: { open: () => {}, close: () => {}, toggle: () => {}, isOpen: () => false },
    workspace: { setActive: () => {}, getActive: () => '' },
    get: () => undefined,
  };
  setCommandSystem(new CommandSystem({ services, getState: () => ({}) }));
}

const registry = (): ToolRegistry => {
  const r = new ToolRegistry();
  for (const t of buildAiTools()) r.register(t);
  return r;
};

/**
 * Reset to an empty composition — a bare `clear` leaves the graph with no
 * root, and new layers parented to a root that doesn't exist are unreachable
 * from `flattenScene` even though `getNode` still finds them.
 */
function resetDocument(): void {
  defaultAnimation.clear();
  defaultSceneGraph.clear();
  defaultSceneGraph.addNode({
    id: 'comp_root',
    name: 'Composition 1',
    parent: null,
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [{ id: 'comp_root_meta', type: 'group', props: { __kind: 'group' } }],
  });
  getCommandSystem().getHistory().clear();
}

// ── B1: one time conversion, applied to value AND easing ──────────

describe('layer-time conversion (B1)', () => {
  /**
   * A fake context whose layer time is offset by 2s, standing in for a layer
   * whose clip starts at 2s. Recording the calls is the point: the assertion is
   * about which TIME each engine call receives.
   */
  function offsetCtx(offset: number) {
    const calls: { fn: string; nodeId: string; prop: string; t: number }[] = [];
    const anim: Partial<AnimFacade> = {
      isValidProp: () => true,
      setKeyframe: (nodeId, prop, t) => { calls.push({ fn: 'setKeyframe', nodeId, prop, t }); },
      setBezier: (nodeId, prop, t) => { calls.push({ fn: 'setBezier', nodeId, prop, t }); },
      setEasing: (nodeId, prop, t) => { calls.push({ fn: 'setEasing', nodeId, prop, t }); },
      removeKeyframe: (nodeId, prop, t) => { calls.push({ fn: 'removeKeyframe', nodeId, prop, t }); },
      setRoving: () => {},
      tracks: () => [{ prop: 'opacity', keyframes: [{ t: 1, value: 0, easing: 'linear' }] }],
    };
    const scene: Partial<SceneFacade> = { has: () => true, nearest: () => [], get: () => undefined };
    const ctx = {
      scene,
      anim,
      comp: { get: () => ({ width: 1920, height: 1080, fps: 30, durationSeconds: 10, background: '#000' }), update: () => {}, playhead: () => 0 },
      time: { toLayerTime: (_id: string, t: number) => t - offset, toCompTime: (_id: string, t: number) => t + offset },
      signal: new AbortController().signal,
    } as unknown as ToolContext;
    return { ctx, calls };
  }

  it('sends the bezier to the same time as the value it eases', async () => {
    const { ctx, calls } = offsetCtx(2);
    const res = await registry().execute(
      'set_keyframes',
      { keyframes: [{ nodeId: 'title', prop: 'x', t: 3, value: 100, easing: 'bezier', bezier: [0.34, 1.56, 0.64, 1] }] },
      ctx,
    );
    expect(res.ok).toBe(true);

    const kf = calls.find((c) => c.fn === 'setKeyframe')!;
    const bez = calls.find((c) => c.fn === 'setBezier')!;
    expect(kf.t).toBe(1);                 // 3s comp − 2s clip start
    expect(bez.t).toBe(kf.t);             // ← B1: these disagreed before
  });

  it('converts remove_keyframes to layer time', async () => {
    const { ctx, calls } = offsetCtx(2);
    await registry().execute('remove_keyframes', { targets: [{ nodeId: 'title', prop: 'x', t: 3 }] }, ctx);
    expect(calls.find((c) => c.fn === 'removeKeyframe')!.t).toBe(1);
  });

  it('converts set_easing to layer time and matches its bezier to it', async () => {
    const { ctx, calls } = offsetCtx(2);
    // The fake track has a keyframe at layer t=1, i.e. comp t=3.
    const res = await registry().execute(
      'set_easing',
      { targets: [{ nodeId: 'title', prop: 'opacity', t: 3, easing: 'bezier', bezier: [0, 0, 1, 1] }] },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.fn === 'setEasing')!.t).toBe(1);
    expect(calls.find((c) => c.fn === 'setBezier')!.t).toBe(1);
  });

  it('refuses to ease a keyframe that does not exist, and says which times do', async () => {
    const { ctx } = offsetCtx(2);
    const res = await registry().execute('set_easing', { targets: [{ nodeId: 'title', prop: 'opacity', t: 9, easing: 'ease' }] }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('Existing times: 3');   // reported in comp time
  });
});

// ── The transaction boundary ──────────────────────────────────────

describe('one prompt, one undo entry', () => {
  beforeAll(bootCommandSystem);

  beforeEach(resetDocument);

  const ctx = (): ToolContext => createToolContext(new AbortController().signal);

  it('collapses 30 mixed scene + animation calls into a single entry', async () => {
    const reg = registry();
    const c = ctx();
    const tx = beginAiTransaction('AI: make it move');

    const created: string[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await reg.execute('create_layer', { kind: 'shape', name: `box_${i}` }, c);
      created.push((res.data as { id: string }).id);
    }
    for (const id of created) {
      await reg.execute('set_keyframes', {
        keyframes: [
          { nodeId: id, prop: 'opacity', t: 0, value: 0, easing: 'easeOut' },
          { nodeId: id, prop: 'opacity', t: 0.5, value: 100 },
        ],
      }, c);
      await reg.execute('update_layer', { nodeId: id, rotation: 15 }, c);
    }

    tx.commit();

    const history = getCommandSystem().getHistory().getEntries();
    expect(history).toHaveLength(1);
    expect(history[0]!.label).toBe('AI: make it move');
    expect(created.every((id) => defaultSceneGraph.getNode(id))).toBe(true);
  });

  it('undoes the whole run at once, and redoes it', async () => {
    const reg = registry();
    const c = ctx();
    const tx = beginAiTransaction('AI: build');
    const res = await reg.execute('create_layer', { kind: 'text', name: 'Title' }, c);
    const id = (res.data as { id: string }).id;
    await reg.execute('set_keyframes', {
      keyframes: [
        { nodeId: id, prop: 'opacity', t: 0, value: 0 },
        { nodeId: id, prop: 'opacity', t: 1, value: 100 },
      ],
    }, c);
    tx.commit();

    expect(defaultSceneGraph.getNode(id)).toBeDefined();
    expect(defaultAnimation.tracksFor(id)).toHaveLength(1);

    getCommandSystem().getHistory().undo();
    expect(defaultSceneGraph.getNode(id)).toBeUndefined();
    expect(defaultAnimation.tracksFor(id)).toHaveLength(0);

    getCommandSystem().getHistory().redo();
    expect(defaultSceneGraph.getNode(id)).toBeDefined();
    expect(defaultAnimation.tracksFor(id)).toHaveLength(1);
  });

  it('leaves the document byte-identical when a run is rolled back', async () => {
    const reg = registry();
    const c = ctx();
    // Something pre-existing, so we're not just comparing two empty documents.
    await reg.execute('create_layer', { kind: 'shape', name: 'Existing' }, c);
    const before = JSON.stringify({ scene: sceneProjectIO.capture(), anim: defaultAnimation.snapshot() });

    const tx = beginAiTransaction('AI: doomed');
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Doomed' }, c);
    const id = (res.data as { id: string }).id;
    await reg.execute('set_keyframes', { keyframes: [{ nodeId: id, prop: 'x', t: 0, value: 0 }, { nodeId: id, prop: 'x', t: 1, value: 500 }] }, c);
    expect(defaultSceneGraph.getNode(id)).toBeDefined();   // it really did land

    tx.rollback();

    expect(defaultSceneGraph.getNode(id)).toBeUndefined();
    expect(JSON.stringify({ scene: sceneProjectIO.capture(), anim: defaultAnimation.snapshot() })).toBe(before);
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(0);
  });

  it('leaves no undo entry for a read-only run', async () => {
    const reg = registry();
    const c = ctx();
    const tx = beginAiTransaction('AI: what is here?');
    await reg.execute('describe_scene', {}, c);
    await reg.execute('list_capabilities', {}, c);
    await reg.execute('get_selection', {}, c);
    tx.commit();
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(0);
  });

  it('swallows commands other subsystems push mid-run', async () => {
    // Lazily booting a comp's timeline pushes an "Add Track" through
    // TimelineController's history bridge, and toLayerTime triggers that boot.
    // Left alone it lands on the undo stack as a second entry, so one undo
    // would only half-undo the run.
    const history = getCommandSystem().getHistory();
    const tx = beginAiTransaction('AI: suppressed');
    history.push({ label: 'Add Track', execute: () => {}, undo: () => {} } as never);
    await registry().execute('create_layer', { kind: 'shape', name: 'A' }, ctx());
    tx.commit();

    const entries = history.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('AI: suppressed');
  });

  it('stops suppressing once the run settles', async () => {
    const history = getCommandSystem().getHistory();
    beginAiTransaction('AI: done').commit();
    history.push({ label: 'A later user edit', execute: () => {}, undo: () => {} } as never);
    expect(history.getEntries().map((e) => e.label)).toEqual(['A later user edit']);
  });

  it('ignores a double commit / commit-after-rollback', async () => {
    const reg = registry();
    const c = ctx();
    const tx = beginAiTransaction('AI: once');
    await reg.execute('create_layer', { kind: 'shape', name: 'A' }, c);
    tx.commit();
    tx.commit();
    tx.rollback();
    expect(getCommandSystem().getHistory().getEntries()).toHaveLength(1);
  });
});

// ── Handler behaviour that keeps the model on the rails ───────────

describe('tool results teach the model', () => {
  beforeAll(bootCommandSystem);
  beforeEach(resetDocument);

  const ctx = (): ToolContext => createToolContext(new AbortController().signal);

  it('suggests real ids when given a bad one', async () => {
    const reg = registry();
    const c = ctx();
    await reg.execute('create_layer', { kind: 'text', name: 'Title' }, c);
    const res = await reg.execute('set_keyframes', { keyframes: [{ nodeId: 'ttle', prop: 'x', t: 0, value: 1 }] }, c);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('did you mean');
    expect(res.content).toContain('Title');
  });

  it('rejects a prop the renderer would silently ignore (B2)', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    // The old server validator ALLOWED width/height; nothing samples them, so
    // the track was stored and the animation just never happened.
    const bad = await reg.execute('set_keyframes', { keyframes: [{ nodeId: id, prop: 'width', t: 0, value: 10 }] }, c);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('not animatable');
    expect(defaultAnimation.tracksFor(id)).toHaveLength(0);
  });

  it('accepts the real prop paths the old validator rejected (B2)', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    await reg.execute('update_layer', { nodeId: id, threeD: true }, c);
    const ok = await reg.execute('set_keyframes', {
      keyframes: [
        { nodeId: id, prop: 'rotationY', t: 0, value: 0 },
        { nodeId: id, prop: 'rotationY', t: 1, value: 180 },
      ],
    }, c);
    expect(ok.ok).toBe(true);
    expect(defaultAnimation.tracksFor(id).map((t) => t.prop)).toContain('rotationY');
  });

  it('tells the model when a 3D prop needs the 3D switch first', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    const bad = await reg.execute('set_keyframes', { keyframes: [{ nodeId: id, prop: 'z', t: 0, value: 100 }] }, c);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('threeD: true');
  });

  it('lets a camera dolly (z) and zoom (focalLength) with no 3D switch', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'camera', name: 'Cam' }, c);
    const id = (res.data as { id: string }).id;
    expect(id).toBeTruthy();
    // A camera is 3D by nature — its z and focalLength animate without the gate
    // that a normal layer's z hits above.
    const okRes = await reg.execute('set_keyframes', {
      keyframes: [
        { nodeId: id, prop: 'z', t: 0, value: -800 },
        { nodeId: id, prop: 'z', t: 2, value: -300 },
        { nodeId: id, prop: 'focalLength', t: 0, value: 50 },
        { nodeId: id, prop: 'focalLength', t: 2, value: 35 },
      ],
    }, c);
    expect(okRes.ok).toBe(true);
    const props = defaultAnimation.tracksFor(id).map((t) => t.prop);
    expect(props).toContain('z');
    expect(props).toContain('focalLength');
  });

  it('adds a vector mask and returns a maskId the model can reference', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Framed' }, c);
    const id = (res.data as { id: string }).id;
    const m = await reg.execute('create_mask', { nodeId: id, shape: 'ellipse', feather: 20, mode: 'add' }, c);
    expect(m.ok).toBe(true);
    expect((m.data as { maskId: string }).maskId).toBeTruthy();
    expect(m.content.toLowerCase()).toContain('mask');
  });

  it('places an imported asset as a media layer and returns its id', async () => {
    const reg = registry();
    const c = ctx();
    // Seed the asset library the way an import would, without a real file.
    useAssetStore.setState({
      assets: [
        { id: 'asset_logo', name: 'logo.png', type: 'image', src: 'blob:test-logo', size: 1000, metadata: { width: 200, height: 200 } },
      ],
    });

    const listed = await reg.execute('list_assets', {}, c);
    expect(listed.ok).toBe(true);
    expect(listed.content).toContain('asset_logo');

    const made = await reg.execute('create_media', { assetId: 'asset_logo', x: 100, y: 100 }, c);
    expect(made.ok).toBe(true);
    const id = (made.data as { id: string }).id;
    expect(id).toBeTruthy();
    // It is a real, animatable layer now.
    expect(c.scene.has(id)).toBe(true);

    useAssetStore.setState({ assets: [] });
  });

  it('refuses to place a media asset that was never imported', async () => {
    const reg = registry();
    const c = ctx();
    const bad = await reg.execute('create_media', { assetId: 'nope' }, c);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('list_assets');
  });

  it('fans un-placed layers out instead of stacking them at the same centre', async () => {
    const reg = registry();
    const c = ctx();
    const a = (await reg.execute('create_layer', { kind: 'shape', name: 'A' }, c)).data as { id: string };
    const b = (await reg.execute('create_layer', { kind: 'shape', name: 'B' }, c)).data as { id: string };
    const va = c.scene.get(a.id)!;
    const vb = c.scene.get(b.id)!;
    // Two layers created with NO position must not land on the exact same pixel.
    expect(va.x !== vb.x || va.y !== vb.y).toBe(true);
  });

  it('honours a partial position instead of discarding it (x only)', async () => {
    const reg = registry();
    const c = ctx();
    const r = (await reg.execute('create_layer', { kind: 'shape', name: 'Placed', x: 123 }, c)).data as { id: string };
    expect(c.scene.get(r.id)!.x).toBe(123);
  });

  it('add_title creates a positioned, animated title in one call', async () => {
    const reg = registry();
    const c = ctx();
    const r = await reg.execute('add_title', { text: 'NOVA', level: 'title', style: 'premium' }, c);
    expect(r.ok).toBe(true);
    const id = (r.data as { id: string }).id;
    const props = defaultAnimation.tracksFor(id).map((t) => t.prop);
    // A real entrance = opacity AND a transform animate, not a static layer.
    // The archetype varies per run (rise/scale_pop/blur_resolve/…), so assert
    // "some transform/effect moved", not one hardcoded property.
    expect(props).toContain('opacity');
    const movers = props.filter((p) => p !== 'opacity' && p !== 'z');
    expect(movers.length).toBeGreaterThan(0);
    // It carries its text and is not stuck at fontSize default.
    expect(c.scene.get(id)!.text).toBe('NOVA');
  });

  it('add_cards builds a staggered row of distinct, animated cards', async () => {
    const reg = registry();
    const c = ctx();
    const r = await reg.execute('add_cards', { count: 3, style: 'premium' }, c);
    expect(r.ok).toBe(true);
    const ids = (r.data as { ids: string[] }).ids;
    expect(ids).toHaveLength(3);
    // Cards sit at distinct x positions (a row, not a stack)…
    const xs = ids.map((id) => c.scene.get(id)!.x);
    expect(new Set(xs).size).toBe(3);
    // …and each animates in.
    for (const id of ids) {
      expect(defaultAnimation.tracksFor(id).map((t) => t.prop)).toContain('opacity');
    }
  });

  it('add_background makes a full-comp layer', async () => {
    const reg = registry();
    const c = ctx();
    const comp = c.comp.get();
    const r = await reg.execute('add_background', { style: 'premium' }, c);
    const id = (r.data as { id: string }).id;
    expect(c.scene.get(id)!.width).toBe(comp.width);
    expect(c.scene.get(id)!.height).toBe(comp.height);
  });

  it('add_camera_move ramps a push-in scale across content (no fragile 3D camera)', async () => {
    const reg = registry();
    const c = ctx();
    await reg.execute('add_title', { text: 'Depth', style: 'premium' }, c);
    const move = await reg.execute('add_camera_move', { kind: 'push_in' }, c);
    expect(move.ok).toBe(true);
    const camNode = c.scene.all().find((n) => n.kind === 'camera')!;
    expect(camNode).toBeDefined();
    const zTrack = defaultAnimation.tracksFor(camNode.id).find((t) => t.prop === 'z');
    expect(zTrack).toBeTruthy();
  });

  it('applies the good half of a batch and names the bad half', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    const mixed = await reg.execute('set_keyframes', {
      keyframes: [
        { nodeId: id, prop: 'opacity', t: 0, value: 0 },
        { nodeId: id, prop: 'opacity', t: 1, value: 100 },
        { nodeId: 'ghost', prop: 'opacity', t: 0, value: 0 },
      ],
    }, c);
    expect(mixed.ok).toBe(false);
    expect(mixed.content).toContain('Applied 2 of 3');
    // The valid two still landed — a batch is not all-or-nothing.
    expect(defaultAnimation.tracksFor(id)[0]!.keyframes).toHaveLength(2);
  });

  it('warns when a property was left holding a constant', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    const one = await reg.execute('set_keyframes', { keyframes: [{ nodeId: id, prop: 'opacity', t: 0, value: 50 }] }, c);
    expect(one.ok).toBe(true);
    expect(one.content).toContain('ONE keyframe');
  });

  it('reports an effect id the model can then keyframe', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    const fx = await reg.execute('add_effect', { nodeId: id, type: 'blur', amount: 12 }, c);
    expect(fx.ok).toBe(true);
    const effectId = (fx.data as { effectId: string }).effectId;
    expect(fx.content).toContain(`effect.${effectId}`);
    const anim = await reg.execute('set_keyframes', {
      keyframes: [
        { nodeId: id, prop: `effect.${effectId}`, t: 0, value: 40 },
        { nodeId: id, prop: `effect.${effectId}`, t: 1, value: 0 },
      ],
    }, c);
    expect(anim.ok).toBe(true);
  });

  it('does not apply an expression that fails to compile', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    const bad = await reg.execute('set_expression', { nodeId: id, prop: 'x', expression: 'return wiggle(2,30);' }, c);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('single expression');
  });

  it('applies a valid expression', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    const ok = await reg.execute('set_expression', { nodeId: id, prop: 'x', expression: 'wiggle(2, 30)' }, c);
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain('overrides any keyframed value');
  });

  /**
   * Writing an expression onto a property whose expression the user DISABLED
   * succeeds and drives nothing: `setExpression` preserves the bit on purpose,
   * so a rewrite cannot silently switch a formula back on. The tool has to say
   * so, or the model reads "applied … it now overrides" and goes looking for a
   * rendering bug that is not there.
   *
   * The clean fixture cannot reach this — it creates a fresh layer, where every
   * expression is new and therefore enabled. Only pre-disabling gets here, and
   * until this existed, breaking the report failed nothing across 155 AI tests.
   */
  it('says so when the property it wrote to has a DISABLED expression', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;

    await reg.execute('set_expression', { nodeId: id, prop: 'x', expression: 'wiggle(2, 30)' }, c);
    defaultAnimation.setExpressionEnabled(id, 'x', false);

    const out = await reg.execute('set_expression', { nodeId: id, prop: 'x', expression: 'time * 90' }, c);
    expect(out.ok).toBe(true);
    expect(out.content).toContain('DISABLED');
    expect(out.content).not.toContain('It now overrides');
    // …and the claim is true: the write landed, the bit did not move.
    expect(defaultAnimation.getExpressionSrc(id, 'x')).toBe('time * 90');
    expect(defaultAnimation.isExpressionEnabled(id, 'x')).toBe(false);
  });

  it('names the available presets when given an unknown one', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'Box' }, c);
    const id = (res.data as { id: string }).id;
    const bad = await reg.execute('apply_preset', { nodeId: id, preset: 'Zoomy McZoomface' }, c);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('Fade In');
  });

  it('describe_scene reports what is already animated', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'text', name: 'Title' }, c);
    const id = (res.data as { id: string }).id;
    await reg.execute('set_keyframes', { keyframes: [{ nodeId: id, prop: 'opacity', t: 0, value: 0 }, { nodeId: id, prop: 'opacity', t: 1, value: 100 }] }, c);

    const desc = await reg.execute('describe_scene', {}, c);
    const data = desc.data as { layers: { id: string; animated?: string[] }[]; composition: { fps: number } };
    expect(data.composition.fps).toBeGreaterThan(0);
    expect(data.layers.find((l) => l.id === id)!.animated).toContain('opacity');
  });

  it('describe_scene says so out loud when it truncates', async () => {
    const reg = registry();
    const c = ctx();
    for (let i = 0; i < 8; i++) await reg.execute('create_layer', { kind: 'shape', name: `n${i}` }, c);
    const desc = await reg.execute('describe_scene', { limit: 3 }, c);
    // 8 created + the comp root.
    expect(desc.content).toContain('Showing 3 of 9');
    expect(desc.content).toContain('subtreeOf');
  });

  it('create_puppet_rig registers puppet pins on layer', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'PuppetLayer' }, c);
    const id = (res.data as { id: string }).id;
    const ok = await reg.execute('create_puppet_rig', {
      layerId: id,
      pins: [
        { name: 'Pin 1', x: -10, y: -20 },
        { name: 'Pin 2', x: 10, y: 20 },
      ],
    }, c);
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain('Created puppet rig with 2 pins');
    // The result must teach the model the pin ids and the track-path convention.
    expect(ok.content).toContain('puppet.<pinId>.rotation');
    const pins = (ok.data as { pins: Array<{ id: string; name: string }> }).pins;
    expect(pins).toHaveLength(2);
    expect(pins[0]!.id).toMatch(/^pin_/);
  });

  it('set_puppet_pin_keyframes animates a rigged pin position', async () => {
    const reg = registry();
    const c = ctx();
    const res = await reg.execute('create_layer', { kind: 'shape', name: 'PuppetLayer' }, c);
    const id = (res.data as { id: string }).id;
    const rig = await reg.execute('create_puppet_rig', {
      layerId: id,
      pins: [{ name: 'Mover', x: 0, y: 0 }, { name: 'Anchor', x: 40, y: 0 }],
    }, c);
    const pinId = (rig.data as { pins: Array<{ id: string }> }).pins[0]!.id;

    // Unknown pin → helpful error, not a silent no-op.
    const bad = await reg.execute('set_puppet_pin_keyframes', {
      layerId: id, pinId: 'pin_nope', keyframes: [{ timeSec: 0, x: 0, y: 0 }],
    }, c);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('not on layer');

    const ok = await reg.execute('set_puppet_pin_keyframes', {
      layerId: id,
      pinId,
      keyframes: [
        { timeSec: 0, x: 0, y: 0 },
        { timeSec: 1, x: 0, y: 60 },
      ],
    }, c);
    expect(ok.ok).toBe(true);
    expect((ok.data as { keyframes: number }).keyframes).toBe(2);
    // The pin's position data track now carries the keyframes.
    const track = defaultAnimation.getDataTrack(id, `puppet.${pinId}.position`);
    expect(track?.keyframes.length).toBe(2);
  });
});
