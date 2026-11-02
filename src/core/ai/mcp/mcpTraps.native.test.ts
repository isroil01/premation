/**
 * Traps hit while building films through the Premation MCP (the samurai title
 * 2026-10-12, The Last Blade and the ChatGPT launch film 2026-10-13, In Motion
 * 2026-10-15, Operand 2026-10-20): each one a call that quietly built
 * something other than what the model wrote. Every case drives the same
 * McpCallHost a connected client reaches, on the app's engine.
 */

import { flicksToSeconds, type Command } from '@motion/engine-api';
import { setupAppEngine, sec, settleEdits, type Harness } from '@core/engine/__testHelpers__/appEngine';
import { activeCompRootId } from '@core/scene/activeComp';
import { mirrorStrokes } from '@core/mirror/paintFields';
import { documentMirror } from '@stores/documentMirror';
import { McpCallHost, type McpResult } from './mcpHost';
import { editorMcpDeps } from './mcpDefaults';

jest.useFakeTimers({ doNotFake: ['setTimeout', 'queueMicrotask', 'nextTick', 'setImmediate'] });
jest.setTimeout(60_000);

let h: Harness;
let host: McpCallHost;
beforeEach(async () => {
  h = await setupAppEngine();
  await h.run({ type: 'setCompositionSettings', comp: activeCompRootId() as string, patch: { frameRate: { num: 30, den: 1 }, duration: sec(12) } } as Command);
  await settleEdits();
  host = new McpCallHost({ ...editorMcpDeps(), access: async () => ({ ok: true }) });
});
afterEach(async () => {
  await host.stop();
  await h.dispose();
});

const call = (name: string, args: unknown = {}): Promise<McpResult> => host.handle({ clientId: 1, name, args });
const textOf = (r: McpResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');

const named = (name: string): string => {
  const m = documentMirror();
  const id = m.layerIds().find((c) => m.layer(c)?.name === name);
  if (!id) throw new Error(`no layer named ${name}: ${m.layerIds().map((c) => m.layer(c)?.name).join(', ')}`);
  return id;
};
const bar = (id: string): { inSec: number; outSec: number } => {
  const t = documentMirror().layer(id)!.timing;
  return { inSec: flicksToSeconds(t.inPoint), outSec: flicksToSeconds(t.outPoint) };
};
/** Top-level layer names of the active composition, top of the stack first. */
const topStack = (): string[] => {
  const m = documentMirror();
  return (m.comp(activeCompRootId() as string)?.layers ?? []).map((id) => m.layer(id)?.name ?? '');
};
async function built(script: unknown, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call('author_scene', { script, ...extra });
  const t = textOf(r);
  expect([r.isError, t]).toEqual([undefined, expect.stringMatching(/^Built /)]);
  expect(t).not.toMatch(/Rejected by the engine/);
  await settleEdits();
  return t;
}
async function value(layer: string, path: string, t = 0): Promise<unknown> {
  const r = (await h.query({ type: 'getPropertyValues', props: [{ layer, path }], time: sec(t), evaluated: true } as never)) as {
    values: { value: { value: unknown } }[];
  };
  return r.values[0]?.value.value;
}
async function tracks(nodeId: string): Promise<{ prop: string; keys: [number, number, string][] }[]> {
  const r = await call('read_tracks', { nodeId });
  const t = textOf(r);
  return t.includes('no animated') ? [] : (JSON.parse(t.split('\n')[1]!) as { prop: string; keys: [number, number, string][] }[]);
}

const script = (over: Record<string, unknown>): Record<string, unknown> => ({
  title: 'Trap', intent: 'a regression probe', durationSec: 12, background: '$bg',
  palette: { bg: '#101014', ink: '#f4efe6', accent: '#ee5a2f' },
  grid: { columns: 12, gutter: 24, margin: 120, baseline: 8 },
  type: { h1: { family: 'Inter', weight: 700, size: 96 } },
  globals: [],
  beats: [],
  ...over,
});

// ── author_scene ─────────────────────────────────────────────────────

describe('author_scene builds what the script says', () => {
  it('a precompose group plays inside its beat, not across the whole comp (The Last Blade)', async () => {
    await built(script({
      beats: [
        { name: 'Open', purpose: '', startSec: 0, endSec: 3, layers: [{ id: 'o', kind: 'shape', name: 'Open card', shape: 'rect', props: { x: 960, y: 540, width: 300, height: 300, fill: '$ink' } }] },
        {
          name: 'Standoff', purpose: '', startSec: 3, endSec: 7,
          layers: [
            { id: 'a', kind: 'shape', name: 'Ronin', shape: 'rect', props: { x: 700, y: 540, width: 100, height: 300, fill: '$ink' } },
            { id: 'b', kind: 'shape', name: 'Rival', shape: 'rect', props: { x: 1200, y: 540, width: 100, height: 300, fill: '$accent' } },
          ],
          precompose: [{ id: 'rig', name: 'Standoff rig', layers: ['a', 'b'], keys: { scale: [{ t: 0, v: 1 }, { t: 4, v: 1.2 }] } }],
        },
        { name: 'Close', purpose: '', startSec: 7, endSec: 12, layers: [{ id: 'c', kind: 'shape', name: 'Close card', shape: 'rect', props: { x: 960, y: 540, width: 300, height: 300, fill: '$accent' } }] },
      ],
    }));
    const b = bar(named('Standoff rig'));
    expect(b.inSec).toBeCloseTo(3, 3);
    expect(b.outSec).toBeCloseTo(7, 3);
  });

  it('a second call (no globals) keeps the first call\'s front globals on top (Last Blade, In Motion)', async () => {
    await built(script({
      globals: [{ id: 'grain', kind: 'adjustment', name: 'Grain', stack: 'front', effects: [{ type: 'noise' }] }],
      beats: [{ name: 'One', purpose: '', startSec: 0, endSec: 6, layers: [{ id: 'a', kind: 'shape', name: 'First', shape: 'rect', props: { width: 200, height: 200, fill: '$ink' } }] }],
    }));
    await built(script({
      beats: [{ name: 'Two', purpose: '', startSec: 6, endSec: 12, layers: [{ id: 'b', kind: 'shape', name: 'Second', shape: 'rect', props: { width: 200, height: 200, fill: '$accent' } }] }],
    }));
    expect(topStack()[0]).toBe('Front globals');
    // And the first beat is still there: a call with other beats replaces nothing.
    expect(topStack()).toEqual(expect.arrayContaining(['Beat 1 — One', 'Beat 1 — Two']));
  });

  it('stroke palette references resolve on shapes, lines and stroke-only ellipses (Operand, ChatGPT film)', async () => {
    await built(script({
      beats: [{
        name: 'Lines', purpose: '', startSec: 0, endSec: 6,
        layers: [
          { id: 'u', kind: 'shape', name: 'Underline', shape: 'line', props: { x: 960, y: 700, width: 600, height: 0, stroke: '$accent', strokeWidth: 6 } },
          { id: 'r', kind: 'shape', name: 'Ring', shape: 'ellipse', props: { x: 960, y: 540, width: 300, height: 300, fill: 'none', stroke: '$ink', strokeWidth: 4 } },
          { id: 'x', kind: 'shape', name: 'Hex line', shape: 'line', props: { x: 960, y: 800, width: 400, height: 0, stroke: '#33aa55', strokeWidth: 3 } },
        ],
      }],
    }));
    const m = documentMirror();
    expect(mirrorStrokes(m, named('Underline'))[0]).toMatchObject({ enabled: true, color: '#ee5a2f', width: 6 });
    expect(mirrorStrokes(m, named('Ring'))[0]).toMatchObject({ enabled: true, color: '#f4efe6', width: 4 });
    expect(mirrorStrokes(m, named('Hex line'))[0]).toMatchObject({ enabled: true, color: '#33aa55', width: 3 });
  });

  it('text `width` is a paragraph box: it wraps, and align left keeps the left edge (ChatGPT film)', async () => {
    await built(script({
      beats: [{
        name: 'Copy', purpose: '', startSec: 0, endSec: 6,
        layers: [{
          id: 't', kind: 'text', name: 'Body', typeStyle: 'h1',
          text: 'A long line of body copy that cannot fit in a narrow column of type',
          props: { x: 960, y: 540, width: 600, align: 'left' },
        }],
      }],
    }));
    const id = named('Body');
    expect(await value(id, 'text/boxWidth')).toBe(600);
    const layout = await h.query({ type: 'getTextLayout', layer: id, time: 0 } as never) as unknown as { lines: number };
    expect(layout.lines).toBeGreaterThan(1);
  });

  const lateCard = script({
    beats: [{
      name: 'Late', purpose: '', startSec: 2, endSec: 8,
      layers: [{
        id: 'l', kind: 'shape', name: 'Late card', shape: 'rect', inSec: 1.4,
        props: { x: 960, y: 540, width: 200, height: 200, fill: '$ink' },
        keys: { opacity: [{ t: 0.8, v: 0 }, { t: 2, v: 100 }], x: [{ t: 1.4, v: 500 }, { t: 3, v: 900 }] },
      }],
    }],
  });

  it('keys before a layer\'s in point keep their time: the in point shows the interpolated value (ChatGPT film)', async () => {
    await built(lateCard);
    const id = named('Late card');
    expect(bar(id).inSec).toBeCloseTo(3.4, 3);
    // Opacity 0 at 2.8 → 100 at 4: at the in point (3.4) it is halfway, not 0.
    expect(await value(id, 'transform/opacity', 3.4)).toBeCloseTo(50, 3);
  });

  // getKeyframes mapped a key outside every clip of the layer to the clip's
  // edge (native/engine/src/core/timeline.cpp keyframe_to_comp_time clamped),
  // so read_tracks — and the timeline — showed 3.4 for a key that evaluates at
  // 2.8. The film's "8.75 landed at 9.4" was this readback.
  it('read_tracks reports a key before the in point at its own time (engine readback)', async () => {
    await built(lateCard);
    const tr = await tracks(named('Late card'));
    expect(tr.find((t) => t.prop === 'opacity')!.keys.map((k) => k[0])).toEqual([2.8, 4]);
  });

  it('an svg layer is the size its markup says (In Motion)', async () => {
    const markup = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="68" viewBox="0 0 80 68"><path d="M0 0H80V68H0Z" fill="#ee5a2f"/></svg>';
    const r = await call('import_svg', { id: 'mark', name: 'Mark', markup, x: 960, y: 540 });
    expect(r.isError).toBeUndefined();
    await settleEdits();
    const id = named('Mark');
    const b = (await h.query({ type: 'getLayerBounds', layers: [id], time: 0, space: 'comp', includeEffects: false } as never)) as unknown as { bounds: { bounds: { width: number; height: number } }[] };
    expect([Math.round(b.bounds[0]!.bounds.width), Math.round(b.bounds[0]!.bounds.height)]).toEqual([80, 68]);
  });
});

// ── review_design ────────────────────────────────────────────────────

describe('review_design judges the frame the camera sees', () => {
  it('a 3D layer the camera frames is not "outside the frame"; a 2D layer that is, still is (Operand)', async () => {
    // A one-node camera (zoom 2000 at z −2000): a layer at z 6000 shows at a
    // quarter scale, so x 4000 lands at 960 + 3040 / 4 = 1720 — in frame.
    for (const [name, args] of [
      ['create_layer', { id: 'cam', kind: 'camera', name: 'Cam', x: 960, y: 540 }],
      ['update_layer', { nodeId: 'cam', z: -2000, focalLength: 2000 }],
      ['create_layer', { id: 'far', kind: 'shape', shape: 'rect', name: 'Far panel', width: 400, height: 300, x: 4000, y: 540, fill: '#ee5a2f' }],
      ['update_layer', { nodeId: 'far', threeD: true, z: 6000 }],
      ['create_layer', { id: 'off', kind: 'shape', shape: 'rect', name: 'Lost card', width: 200, height: 200, x: 5000, y: 540, fill: '#33aa55' }],
    ] as const) {
      const r = await call(name, args);
      expect([name, r.isError, r.isError ? textOf(r).slice(0, 300) : '']).toEqual([name, undefined, '']);
    }
    await settleEdits();
    const review = textOf(await call('review_design'));
    expect(review).not.toMatch(/'Far panel' is outside/);
    expect(review).toMatch(/'Lost card' is outside/);
  });
});

// ── the layer tools ──────────────────────────────────────────────────

describe('the layer tools do what they say', () => {
  it('set_motion_blur with a nodeId switches that layer (In Motion)', async () => {
    await call('create_layer', { id: 'mb', kind: 'shape', shape: 'rect', name: 'Mover', width: 100, height: 100 });
    const r = await call('set_motion_blur', { nodeId: 'mb', enabled: true });
    expect([r.isError, textOf(r)]).toEqual([undefined, expect.stringMatching(/enabled on/)]);
    expect(documentMirror().layer(named('Mover'))!.switches.motionBlur).toBe(true);
  });

  it('remove_keyframes takes scaleX / scaleY on script-made scale (ChatGPT film)', async () => {
    await built(script({
      beats: [{
        name: 'Pop', purpose: '', startSec: 0, endSec: 6,
        layers: [{ id: 'p', kind: 'shape', name: 'Pop', shape: 'rect', props: { width: 200, height: 200, fill: '$ink' }, keys: { scale: [{ t: 0, v: 0.5 }, { t: 1, v: 1 }, { t: 2, v: 1.2 }] } }],
      }],
    }));
    const id = named('Pop');
    const r = await call('remove_keyframes', { targets: [{ nodeId: id, prop: 'scaleX', t: 2 }, { nodeId: id, prop: 'scaleY', t: 2 }] });
    expect([r.isError, textOf(r)]).toEqual([undefined, expect.stringMatching(/./)]);
    const left = await tracks(id);
    for (const t of left.filter((x) => /scale/.test(x.prop))) expect(t.keys.map((k) => k[0])).toEqual([0, 1]);
  });

  it('set_keyframes on uniform scale does not say "only ONE keyframe" when two landed (samurai title)', async () => {
    await call('create_layer', { id: 's', kind: 'shape', shape: 'rect', name: 'Scaled', width: 100, height: 100 });
    const r = await call('set_keyframes', { keyframes: [{ nodeId: 's', prop: 'scale', t: 0, value: 0.5 }, { nodeId: 's', prop: 'scale', t: 1, value: 1 }] });
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).not.toMatch(/only ONE keyframe/);
  });
});

// ── effects ──────────────────────────────────────────────────────────

describe('effect params the model writes arrive', () => {
  it('add_effect and update_effect_param take a curve\'s points (Curves was unreachable)', async () => {
    await call('create_layer', { id: 'g', kind: 'adjustment', name: 'Grade' });
    const s = [[0, 0], [64, 48], [192, 208], [255, 255]];
    const added = await call('add_effect', { nodeId: 'g', type: 'curves', id: 'cv', params: { points: s } });
    expect([added.isError, textOf(added)]).toEqual([undefined, expect.stringMatching(/points=\[\[0,0\]/)]);
    expect(textOf(added)).not.toMatch(/unknown|ignored/i);
    const red = [[0, 0], [128, 160], [255, 255]];
    const set = await call('update_effect_param', { nodeId: 'g', effectId: 'cv', key: 'redPoints', value: red });
    expect(set.isError).toBeUndefined();
    await settleEdits();
    const id = named('Grade');
    await documentMirror().loadTree(id);
    const stored = (k: string): unknown => {
      const v = documentMirror().property(id, `effects/cv/${k}`)?.value as { kind: string; value: string } | undefined;
      return v?.kind === 'json' ? JSON.parse(v.value) : v;
    };
    expect(stored('points')).toEqual(s);
    expect(stored('redPoints')).toEqual(red);
  });
});

// ── text animators ───────────────────────────────────────────────────

describe('text animator sweeps say what a shape can do', () => {
  it('a sweep with a bump or ramp shape is told hidden characters show outside the window (Operand, The Last Blade)', async () => {
    await call('create_layer', { id: 't', kind: 'text', name: 'Title', text: 'OPERAND' });
    const r = await call('text_animator', { nodeId: 't', shape: 'smooth', opacity: 0, sweep: { fromSec: 0.5, toSec: 1.5 } });
    expect([r.isError, textOf(r)]).toEqual([undefined, expect.stringMatching(/shape smooth never selects every character fully/)]);
    const sq = await call('text_animator', { nodeId: 't', shape: 'square', opacity: 0, sweep: { fromSec: 0.5, toSec: 1.5 } });
    expect(textOf(sq)).not.toMatch(/never selects every character/);
  });

  // AE's Ramp Up holds characters PAST the window's end at full strength (Ramp
  // Down: before its start), which is what makes the classic "Ramp Up, offset
  // −100 → 100" soft reveal hide the text before it passes. The selector
  // (native/engine/src/scene/text_port.cpp range_selector_at, mirrored by
  // src/core/text/textSelectors.ts) gave 0 outside the window on both sides.
  it('Ramp Up selects characters past the window\'s end fully (AE), so offset −100 hides the whole text', async () => {
    const { defaultRangeSelector, rangeSelectorAt } = await import('@core/text/textSelectors');
    const sel = { ...defaultRangeSelector(), start: 0, end: 100, offset: -100, shape: 'rampUp' as const };
    expect(Array.from({ length: 7 }, (_, u) => rangeSelectorAt(sel, u, 7))).toEqual(Array(7).fill(1));
  });
});

// ── inspect_layers through the camera ────────────────────────────────

describe('inspect_layers reports the camera-projected box', () => {
  it('a 3D layer the camera frames is not OFF-SCREEN', async () => {
    await call('create_layer', { id: 'cam', kind: 'camera', name: 'Cam', x: 960, y: 540 });
    await call('update_layer', { nodeId: 'cam', z: -2000, focalLength: 2000 });
    await call('create_layer', { id: 'far', kind: 'shape', shape: 'rect', name: 'Far panel', width: 400, height: 300, x: 4000, y: 540, fill: '#ee5a2f' });
    await call('update_layer', { nodeId: 'far', threeD: true, z: 6000 });
    await settleEdits();
    const t = textOf(await call('inspect_layers', { t: 1 }));
    const line = t.split('\n').find((l) => l.includes('"Far panel"'))!;
    expect(line).not.toMatch(/OFF-SCREEN/);
    // A quarter scale at 8000 px in front of the eye: 100×75 around x 1720.
    expect(line).toMatch(/x 1670\.\.1770, y 503\.\.578 \(100×75\)/);
  });
});

// ── parenting ────────────────────────────────────────────────────────

describe('a child of a scaled layer lands where AE puts it', () => {
  it('re-scaling a parent moves a child by the parent\'s scale times its local offset, not twice that (ChatGPT film)', async () => {
    for (const [name, args] of [
      ['create_layer', { id: 'plate', kind: 'solid', name: 'Plate', width: 800, height: 450, x: 960, y: 540, fill: '#202020' }],
      ['update_layer', { nodeId: 'plate', scaleX: 2, scaleY: 2 }],
      ['create_layer', { id: 'patch', kind: 'shape', shape: 'rect', name: 'Patch', width: 20, height: 20, x: 1060, y: 540, fill: '#ee5a2f' }],
      ['reparent_layer', { nodeId: 'patch', parentId: 'plate' }],
    ] as const) {
      const r = await call(name, args);
      expect([name, r.isError]).toEqual([name, undefined]);
    }
    await settleEdits();
    const id = named('Patch');
    const worldX = async (): Promise<number> =>
      ((await h.query({ type: 'getLayerTransforms', layers: [id], time: 0 } as never)) as unknown as { transforms: { matrix: number[] }[] }).transforms[0]!.matrix[12]!;
    // Parenting keeps the world place (AE): still at 1060, i.e. 100 px right of the parent at scale 2.
    expect(await worldX()).toBeCloseTo(1060, 3);
    // Scale 3: the same local offset (50 px at scale 2) now spans 150 px.
    await call('update_layer', { nodeId: 'plate', scaleX: 3, scaleY: 3 });
    await settleEdits();
    expect(await worldX()).toBeCloseTo(960 + 150, 3);
  });
});

// ── big scripts ──────────────────────────────────────────────────────

describe('a big author_scene', () => {
  it('a 40 KB+ script builds, and a retry after a client timeout replaces instead of doubling (Operand)', async () => {
    const layers = Array.from({ length: 200 }, (_, i) => ({
      id: `l${i}`, kind: 'shape', name: `Tile ${i}`, shape: 'rect',
      props: { x: 100 + (i % 16) * 110, y: 100 + Math.floor(i / 16) * 90, width: 90, height: 70, fill: i % 2 ? '$ink' : '$accent' },
      keys: {
        opacity: [{ t: 0.1 + (i % 16) * 0.05, v: 0 }, { t: 0.6 + (i % 16) * 0.05, v: 100, ease: 'easeOut' }],
        y: [{ t: 0.1, v: 140 + Math.floor(i / 16) * 90 }, { t: 0.9, v: 100 + Math.floor(i / 16) * 90 }],
      },
    }));
    const big = script({ beats: [{ name: 'Grid', purpose: 'a wall of tiles', startSec: 0, endSec: 12, layers }] });
    expect(JSON.stringify(big).length).toBeGreaterThan(40_000);
    const t0 = process.hrtime.bigint();
    await built(big);
    const ms = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    const count = documentMirror().layerIds().length;
    await built(big);
    expect(documentMirror().layerIds().length).toBe(count);
    // What a client's tool timeout sees, for the trap table.
    console.info(`author_scene ${JSON.stringify(big).length} B, ${layers.length} layers: ${ms} ms`);
  });
});

// ── expression-driven values ─────────────────────────────────────────

describe('evaluate_at / inspect_layers report post-expression values', () => {
  it('opacity and rotation driven by expressions read as the frame draws them', async () => {
    await built(script({
      beats: [{ name: 'One', purpose: '', startSec: 0, endSec: 12, layers: [{ id: 'a', kind: 'shape', name: 'Driven', shape: 'rect', props: { x: 960, y: 540, width: 200, height: 200, fill: '$ink' } }] }],
    }));
    const id = named('Driven');
    expect(textOf(await call('set_expression', { nodeId: id, prop: 'rotation', expression: '45' }))).not.toMatch(/error/i);
    expect(textOf(await call('set_expression', { nodeId: id, prop: 'opacity', expression: '0' }))).not.toMatch(/error/i);
    await settleEdits();
    expect(await value(id, 'transform/rotation')).toBeCloseTo(45, 3);
    expect(await value(id, 'transform/opacity')).toBeCloseTo(0, 3);

    const ev = textOf(await call('evaluate_at', { nodeId: id, t: 1 }));
    expect(ev).toMatch(/rotation\W+45(?!\d)/);
    expect(ev).toMatch(/opacity\W+0(?!\d)/);
    expect(ev).toMatch(/come from an expression/);

    const insp = textOf(await call('inspect_layers', { nodeIds: [id], t: 1 }));
    expect(insp).toMatch(/opacity 0% \(from expression\)/);
    expect(insp).toMatch(/rotation 45° \(from expression\)/);
  });
});
