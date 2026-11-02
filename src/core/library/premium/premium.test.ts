/**
 * The premium library's pure parts: the pack contract's validators, the
 * transition spec's pose invariants, template placement, the catalog filter
 * and who may do what with a premium item.
 */

import { AnimationEngine } from '@motion/animation';
import type { FragmentLayer } from '@/engine-client/fragmentBuilder';
import { premiumAccessOf } from '@hooks/usePremiumAccess';
import {
  catalogItemProblem,
  parsePayload,
  templatePayloadProblem,
  transitionPayloadProblem,
  type TemplatePayload,
  type TransitionPayload,
} from './packFormat';
import { sanitizeCatalog } from './catalog';
import { elementRoot, preparedLayers, retime, rewriteAssetRefs } from './templatePayload';
import { offFrame, planSpecTransition, resolveValue, specRecipe } from './transitionSpec';
import type { LayerPose, TransitionLayerFacts } from '@core/library/transitionLibrary';

const META = {
  id: 'pro.template.aurora-title', kind: 'template', name: 'Aurora Title', category: 'Openers', tags: ['cinematic'],
  tier: 'cloud', version: 2, durationSec: 6, aspect: '16:9', width: 1920, height: 1080, fieldCount: 4,
  fieldLabels: ['Title', 'Subtitle'], mode: 'scene', description: 'A cinematic opener.',
  poster: '/library/media/a', preview: '/library/media/b',
};

describe('catalog rows', () => {
  it('accepts a contract row', () => {
    expect(catalogItemProblem(META)).toBeNull();
  });

  it.each([
    ['bad id', { ...META, id: 'Pro.Template.X' }],
    ['kind mismatch', { ...META, kind: 'lottie' }],
    ['bad tier', { ...META, tier: 'pro' }],
    ['zero version', { ...META, version: 0 }],
    ['no duration', { ...META, durationSec: 0 }],
    ['bad peaks', { ...META, peaks: [2] }],
    ['bad mode', { ...META, mode: 'overlay' }],
    ['bad field labels', { ...META, fieldLabels: [''] }],
  ])('refuses %s', (_why, row) => {
    expect(catalogItemProblem(row)).not.toBeNull();
  });

  it('keeps the good rows, drops bad ones and duplicates', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rows = sanitizeCatalog({ items: [META, { ...META, id: 'nope' }, META, { ...META, id: 'pro.template.b' }] });
    expect(rows.map((r) => r.id)).toEqual(['pro.template.aurora-title', 'pro.template.b']);
    expect(sanitizeCatalog(null)).toEqual([]);
    warn.mockRestore();
  });

  it('takes absent media as null (the launch server sent audio: null on every template)', () => {
    const [row] = sanitizeCatalog({ items: [{ ...META, audio: null }] });
    expect(row?.id).toBe('pro.template.aurora-title');
    expect(row && 'audio' in row).toBe(false);
  });
});

// ── Transitions ───────────────────────────────────────────────────

const SPEC: TransitionPayload = {
  v: 1,
  duration: 0.6,
  motionBlur: true,
  enter: [
    { prop: 'x', t: 0, value: { base: 'offL' }, ease: [0.16, 1, 0.3, 1] },
    { prop: 'x', t: 0.8, value: { base: 'pose', add: 12 } },
    { prop: 'opacity', t: 0, value: { base: 'const', add: 0 } },
    { prop: 'opacity', t: 0.4, value: { base: 'const', add: 100 } },
    { prop: 'scaleX', t: 0, value: { base: 'pose', mul: 1.2 } },
  ],
  exit: [
    { prop: 'x', t: 0, value: { base: 'pose' }, ease: 'easeIn' },
    { prop: 'x', t: 1, value: { base: 'offR' }, ease: 'easeIn' },
    { prop: 'opacity', t: 1, value: { base: 'const', add: 0 } },
  ],
  fx: [{ type: 'directional-blur', param: 'length', enter: [{ t: 0, value: 80 }, { t: 1, value: 0 }], exit: [{ t: 0, value: 0 }, { t: 1, value: 80 }] }],
};

const POSE: LayerPose = { x: 600, y: 400, scaleX: 1, scaleY: 1, rotation: 0, width: 300, height: 200 };
const COMP = { width: 1920, height: 1080 };

const lastOf = (keys: ReturnType<typeof specRecipe>, prop: string) =>
  keys.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t).at(-1);

describe('transition specs', () => {
  it('validates', () => {
    expect(transitionPayloadProblem(SPEC)).toBeNull();
    expect(transitionPayloadProblem({ ...SPEC, duration: 0 })).not.toBeNull();
    expect(transitionPayloadProblem({ ...SPEC, enter: [{ prop: 'skew', t: 0, value: { base: 'pose' } }] })).not.toBeNull();
    expect(transitionPayloadProblem({ ...SPEC, enter: [{ prop: 'x', t: 1.5, value: { base: 'pose' } }] })).not.toBeNull();
    expect(transitionPayloadProblem({ ...SPEC, enter: [{ prop: 'x', t: 0, value: { base: 'pose' }, ease: [2, 0, 0, 1] }] })).not.toBeNull();
  });

  it('resolves pose-relative values', () => {
    const off = offFrame(POSE, COMP);
    expect(resolveValue({ base: 'offL' }, 'x', POSE, COMP)).toBe(POSE.x + off.offL);
    expect(POSE.x + off.offL + POSE.width / 2).toBeLessThan(0); // fully off the left edge
    expect(resolveValue({ base: 'pose', mul: 1.2 }, 'scaleX', POSE, COMP)).toBeCloseTo(1.2);
    expect(resolveValue({ base: 'const', add: 42 }, 'rotation', POSE, COMP)).toBe(42);
  });

  it('an entrance ends every prop on the pose, opacity on 100', () => {
    const keys = specRecipe(SPEC, POSE, COMP, 'enter');
    expect(lastOf(keys, 'x')).toMatchObject({ t: 0.6, value: POSE.x });
    expect(lastOf(keys, 'scaleX')).toMatchObject({ t: 0.6, value: 1 });
    expect(lastOf(keys, 'opacity')?.value).toBe(100);
  });

  it('an exit is invisible before it glides back onto the pose', () => {
    const keys = specRecipe(SPEC, POSE, COMP, 'exit');
    const op = lastOf(keys, 'opacity')!;
    expect(op.value).toBe(0);
    expect(op.t).toBeLessThan(0.6);
    const x = lastOf(keys, 'x')!;
    expect(x).toMatchObject({ t: 0.6, value: POSE.x });
    // The author's off-frame key was pulled in so the restore can follow it.
    expect(keys.filter((k) => k.prop === 'x' && k.t > op.t && k.t < 0.6).length).toBe(1);
  });

  it('keys a scratch engine, with bezier eases and the effect it needs', () => {
    const engine = new AnimationEngine();
    const facts: TransitionLayerFacts = {
      pose: () => POSE,
      clips: () => ({ fps: 30, clips: [{ start: 0, end: 300 }] }),
      effects: () => [],
    };
    const plan = planSpecTransition(SPEC, ['L1'], 1, COMP, facts, engine, (_id, s) => s);
    expect(plan.result?.nodeIds).toEqual(['L1']);
    expect(plan.result?.phases).toEqual(['enter']);
    expect(plan.needFx).toEqual([{ layer: 'L1', id: 'transition_directional_blur', type: 'directional-blur' }]);
    const x = engine.getTrackKeyframes('L1', 'x')!;
    expect(x[0]).toMatchObject({ t: 1, easing: 'bezier', bezier: [0.16, 1, 0.3, 1] });
    expect(engine.animatedProps('L1').some((p) => p.includes('transition_directional_blur'))).toBe(true);
  });

  it('reuses an effect the layer already has', () => {
    const engine = new AnimationEngine();
    const facts: TransitionLayerFacts = {
      pose: () => POSE,
      clips: () => ({ fps: 30, clips: [] }),
      effects: () => [{ id: 'fx9', type: 'directional-blur' }],
    };
    expect(planSpecTransition(SPEC, ['L1'], 0, COMP, facts, engine, (_id, s) => s).needFx).toEqual([]);
  });
});

// ── Templates ─────────────────────────────────────────────────────

function layer(id: string, parent: string | null, props: Record<string, unknown>, tracks: Record<string, Array<{ t: number; value: number }>> = {}): FragmentLayer {
  return {
    row: {
      id, name: id, parent, children: [], visible: true, locked: false,
      transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
      components: [{ id: `${id}_t`, type: 'Transform', props }],
    },
    anim: Object.keys(tracks).length ? { tracks, expressions: {}, data: {} } : null,
    bars: [{ start: 0, duration: 120, sourceIn: 0, sourceDuration: null }],
  };
}

const ELEMENT: TemplatePayload = {
  v: 1,
  mode: 'element',
  settings: { width: 1920, height: 1080, fps: 30, durationSeconds: 4, background: '#000000' },
  layers: [
    layer('root', null, { x: 0, y: 0, scaleX: 1, scaleY: 1 }),
    layer('bar', 'root', { x: 960, y: 900, __src: 'asset:bg', assetId: 'asset:bg' }, { opacity: [{ t: 0, value: 0 }, { t: 0.5, value: 100 }] }),
  ],
  fields: [{ id: 'title', label: 'Title', kind: 'text', target: { nodeId: 'bar', componentType: 'Text', prop: 'content' }, default: 'Hello' }],
  assets: [{ ref: 'asset:bg', name: 'bg.png', mime: 'image/png', data: '' }],
};

describe('template payloads', () => {
  it('validates', () => {
    expect(templatePayloadProblem(ELEMENT)).toBeNull();
    expect(templatePayloadProblem({ ...ELEMENT, fields: [{ ...ELEMENT.fields[0]!, target: { ...ELEMENT.fields[0]!.target, nodeId: 'ghost' } }] })).toMatch(/missing layer/);
    expect(templatePayloadProblem({ ...ELEMENT, layers: [] })).not.toBeNull();
  });

  it('rewrites asset placeholders and reports unused ones', () => {
    const layers = JSON.parse(JSON.stringify(ELEMENT.layers)) as FragmentLayer[];
    const unused = rewriteAssetRefs(layers, [{ ref: 'asset:bg', id: 'item_7', src: 'media://7' }, { ref: 'asset:other', id: 'x', src: 'y' }]);
    expect(layers[1]!.row.components[0]!.props).toMatchObject({ assetId: 'item_7', __src: 'media://7' });
    expect(unused).toEqual(['asset:other']);
  });

  it('places an element at the target centre, scaled, starting at the playhead', () => {
    const out = preparedLayers(ELEMENT, [], { width: 3840, height: 2160, fps: 60, t0: 2 });
    const root = elementRoot(out)!;
    const t = root.row.components[0]!.props;
    expect(t.scaleX).toBe(2);
    // The authored centre (960, 540) lands on the target centre (1920, 1080).
    expect((t.x as number) + 2 * 960).toBe(1920);
    expect((t.y as number) + 2 * 540).toBe(1080);
    expect(out[1]!.anim!.tracks.opacity!.map((k) => k.t)).toEqual([2, 2.5]);
    expect(out[1]!.bars[0]).toMatchObject({ start: 120, duration: 240 });
    // The payload itself is untouched (it is memoised for the next insert).
    expect(ELEMENT.layers[0]!.row.components[0]!.props.scaleX).toBe(1);
  });

  it('a scene pastes as authored', () => {
    const scene = { ...ELEMENT, mode: 'scene' as const };
    const out = preparedLayers(scene, [], null);
    expect(out[0]!.row.components[0]!.props.scaleX).toBe(1);
    expect(out[1]!.anim!.tracks.opacity![0]!.t).toBe(0);
  });

  it('refuses an element with no single root', () => {
    const two = { ...ELEMENT, layers: [layer('a', null, {}), layer('b', null, {})] };
    expect(() => preparedLayers(two, [], { width: 1920, height: 1080, fps: 30, t0: 0 })).toThrow(/exactly one top layer/);
  });

  it('retimes bars across frame rates', () => {
    const layers = [layer('a', null, {})];
    retime(layers, 1, 30, 24);
    expect(layers[0]!.bars[0]).toMatchObject({ start: 24, duration: 96 });
  });
});

describe('payload parsing', () => {
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

  it('parses each kind, refusing what does not match it', () => {
    expect(parsePayload('transition', enc(SPEC)).kind).toBe('transition');
    expect(parsePayload('template', enc(ELEMENT)).kind).toBe('template');
    expect(parsePayload('lottie', enc({ v: 1, doc: { w: 512, h: 512, fr: 60, layers: [] } })).kind).toBe('lottie');
    expect(() => parsePayload('lottie', enc(SPEC))).toThrow();
    expect(() => parsePayload('template', new Uint8Array([1, 2, 3]))).toThrow(/not JSON/);
    const wav = new Uint8Array(44);
    wav.set(new TextEncoder().encode('RIFF'), 0);
    wav.set(new TextEncoder().encode('WAVE'), 8);
    expect(parsePayload('sfx', wav).kind).toBe('sfx');
    expect(() => parsePayload('sfx', new Uint8Array(44))).toThrow(/RIFF/);
  });
});

describe('premium access', () => {
  it('reads the edition, the session and the plan', () => {
    expect(premiumAccessOf({ billing: false, signedIn: true, access: null })).toBe('local');
    expect(premiumAccessOf({ billing: true, signedIn: false, access: null })).toBe('signedOut');
    expect(premiumAccessOf({ billing: true, signedIn: true, access: null })).toBe('unknown');
    const base = { read: true, write: true, reason: 'paid', daysRemaining: null, writeEndsAt: null } as never;
    expect(premiumAccessOf({ billing: true, signedIn: true, access: { ...(base as object), plan: 'free' } as never })).toBe('free');
    expect(premiumAccessOf({ billing: true, signedIn: true, access: { ...(base as object), plan: 'pro' } as never })).toBe('pro');
  });
});
