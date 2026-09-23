/**
 * Golden-table generator for motion_expr — the expression language's parity
 * contract.
 *
 * RUNS the TypeScript expression engine (`packages/animation/src/
 * expressions.ts` — `compileExpression(src).run(ctx)` / `.runText(ctx)`) over
 * a corpus of expressions × contexts × times and writes `golden_expr.inc`.
 * The Catch2 suite (`test_expr.cpp`) rebuilds every context in C++ (the same
 * keyframe tracks through motion_eval, the same provider arithmetic) and
 * checks the C++ result EXACTLY: same number bits (so -0 ≠ +0), same vector,
 * same error text, same Source Text result.
 *
 * Also writes `golden_expr_engine.inc`: AnimationEngine.sample() over a small
 * scene whose expressions read each other (cross-layer chains, a cycle, a
 * chain deeper than 16, per-(node, prop) wiggle seeds, vector component
 * picks). test_expr.cpp mirrors AnimationEngine.sampleInternal as a Host.
 *
 * Regenerate (Node ≥ 22.6; a resolve hook adds the `.ts` the package's
 * extensionless relative imports leave out):
 *
 *     node native/tests/gen_golden_expr.ts
 *
 * Math.random is included: it draws from the evaluation's seeded random()
 * sequence, so it is deterministic in both engines.
 */

import { writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\.[cm]?[jt]s$/.test(specifier)) {
    try { return await next(specifier + '.ts', context); } catch {}
  }
  return next(specifier, context);
}`),
  pathToFileURL('./'),
);

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..', '..', 'packages', 'animation', 'src');
const { compileExpression } = await import(pathToFileURL(join(pkg, 'expressions.ts')).href);
const { sampleTrack } = await import(pathToFileURL(join(pkg, 'interpolate.ts')).href);
const { AnimationEngine } = await import(pathToFileURL(join(pkg, 'AnimationEngine.ts')).href);

// ── Encoding helpers ────────────────────────────────────────────────────────

const dv = new DataView(new ArrayBuffer(8));
function hex(x: number): string {
  dv.setFloat64(0, x);
  return `0x${dv.getBigUint64(0).toString(16).padStart(16, '0')}ull`;
}
function u16(s: string | null | undefined): string {
  if (s === null || s === undefined) return 'nullptr';
  let o = 'u"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c) o += `\\${s[i]}`;
    else if (c >= 0x20 && c < 0x7f && s[i] !== '?') o += s[i];
    // \x escapes (legal for surrogate halves, unlike \u), closed so a following hex digit is not absorbed.
    else o += `\\x${c.toString(16)}" u"`;
  }
  return `${o}"`;
}
function num(x: number): string {
  if (Number.isNaN(x)) return 'std::numeric_limits<double>::quiet_NaN()';
  if (x === Infinity) return 'std::numeric_limits<double>::infinity()';
  if (x === -Infinity) return '-std::numeric_limits<double>::infinity()';
  if (Object.is(x, -0)) return '-0.0';
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}

// ── Keyframe tracks (the motion_keyframe encoding of gen_golden.ts) ────────

type Kf = { t: number; value: number; easing?: string; bezier?: number[]; si?: number; so?: number; spatialInterp?: string };
const EASING: Record<string, number> = {
  linear: 0, hold: 1, bezier: 2, easeIn: 3, easeOut: 4, easeInOut: 5, ease: 6, autoBezier: 7, continuousBezier: 8, step: 9,
};
const SPATIAL: Record<string, number> = { linear: 1, bezier: 2, continuous: 3, auto: 4 };
function kfCpp(k: Kf): string {
  let f = 0;
  if (k.bezier) f |= 1;
  if (k.si !== undefined) f |= 2;
  if (k.so !== undefined) f |= 4;
  if (k.spatialInterp) f |= SPATIAL[k.spatialInterp]! << 4;
  const [c0, c1, c2, c3] = k.bezier ?? [0, 0, 0, 0];
  return `{${num(k.t)}, ${num(k.value)}, ${EASING[k.easing ?? 'linear']}, ${f}u, ${num(c0!)}, ${num(c1!)}, ${num(c2!)}, ${num(c3!)}, ${num(k.si ?? 0)}, ${num(k.so ?? 0)}}`;
}
const track = (kfs: Kf[]) => ({ nodeId: 'g', prop: 'p', keyframes: kfs });

const RAMP: Kf[] = [{ t: 0, value: 0 }, { t: 1, value: 100 }];
const BEZ: Kf[] = [
  { t: 0, value: 0, easing: 'bezier', bezier: [0.42, 0, 0.58, 1] },
  { t: 1, value: 100, easing: 'bezier', bezier: [0.17, 0.67, 0.83, 0.67], so: 30 },
  { t: 2.5, value: -40, si: -12.5 },
];
const HOLDY: Kf[] = [
  { t: 0.5, value: 10, easing: 'hold' },
  { t: 1.5, value: 30, easing: 'easeInOut' },
  { t: 3, value: -5, easing: 'autoBezier', spatialInterp: 'auto' },
  { t: 4, value: 12 },
];

// ── Contexts ────────────────────────────────────────────────────────────────

type Marker = { time: number; duration: number; name: string; comment: string };
type Style = Record<string, unknown>;
type TextSample = { text: string; style: Style; runs?: Array<{ start: number; end: number; style: Record<string, unknown> }> };
interface Ctx {
  self?: Kf[];                 // selfAt / selfSpan / keyTimes
  base: number;                // `value` when there is no track (or before sampling)
  audio?: number;
  propSeed?: number;
  comp?: { width: number; height: number; duration: number; fps: number; numLayers: number };
  layerInfo?: { name: string; width: number; height: number };
  ctrls?: Array<[string, number]>;
  tracks?: Array<[string, string, Kf[]]>;              // layerAt
  spaces?: Array<[string | null, number, number, number]>; // [name, k, off, z]
  rect?: boolean;
  markers?: { comp: Marker[]; layer: Marker[] };
  texts?: Array<[string | null, TextSample]>;
  textValue?: boolean;         // the expression is ON the Source Text property (self text)
}

const STYLE: Style = {
  fontFamily: 'Inter', fontSize: 48, fontWeight: '400', fontStyle: 'normal', fill: '#ffffff',
  strokeWidth: 0, letterSpacing: 4.8, lineHeight: 1.25, baselineShift: 0, horizontalScale: 100,
  verticalScale: 100, textTransform: 'none', fontVariant: 'normal', align: 'left', paragraphSpacing: 6,
  firstLineIndent: 0, leftIndent: 0, rightIndent: 0, spaceBefore: 0,
};
const TITLE: TextSample = {
  text: 'Hello',
  style: { ...STYLE, fontWeight: '700', fill: 'rgb(255, 128, 0)', stroke: '#123', direction: 'rtl' },
  runs: [
    { start: 0, end: 3, style: { fontSize: 96, fill: '#ff0000' } },
    { start: 2, end: 4, style: { fontFamily: 'Roboto', letterSpacing: 2 } },
  ],
};
const SELF_TEXT: TextSample = { text: 'Hello', style: STYLE };
const EMOJI_TEXT: TextSample = { text: 'é\u{1F1FA}\u{1F1F8}\u{1F44D}\u{1F3FD}x\r\n가', style: { ...STYLE, fill: '#0f08' } };

const LAYER_MARKERS: Marker[] = [
  { time: 2.0, duration: 0, name: 'Intro', comment: 'beat' },
  { time: 0.5, duration: 1.5, name: 'beat', comment: 'chorus' },
  { time: 4.0, duration: 0, name: 'Outro', comment: '' },
  { time: 2.0, duration: 0.25, name: 'Dup', comment: 'same time' },
];
const COMP_MARKERS: Marker[] = [
  { time: 3.0, duration: 0.25, name: 'End', comment: 'tail' },
  { time: 1.0, duration: 0, name: 'Start', comment: 'head' },
];

const CTXS: Ctx[] = [
  /* 0 */ { base: 0 },
  /* 1 */ { self: RAMP, base: 0 },
  /* 2 */ { self: BEZ, base: 0, propSeed: 1234 },
  /* 3 */ {
    self: HOLDY, base: 7, audio: 0.375, propSeed: 5821,
    comp: { width: 1280, height: 720, duration: 12, fps: 24, numLayers: 6 },
    layerInfo: { name: 'Self', width: 400, height: 300 },
    ctrls: [['Speed', 25], ['Amp', -3.5]],
    tracks: [['Leader', 'x', RAMP], ['Title', 'x', BEZ], ['Title', 'y', HOLDY], ['#n_42', 'x', [{ t: 0, value: 5 }]]],
    spaces: [[null, 2, 0, 7], ['Other', 1, 1000, -3], ['Target', 0.5, -20, 1.5]],
    rect: true,
    markers: { comp: COMP_MARKERS, layer: LAYER_MARKERS },
  },
  /* 4 */ {
    base: 0, layerInfo: { name: 'Caption', width: 640, height: 80 },
    texts: [[null, SELF_TEXT], ['Title', TITLE], ['Emoji', EMOJI_TEXT]], textValue: true,
    tracks: [['Leader', 'x', RAMP]], propSeed: 17,
  },
  /* 5 */ { base: 42, comp: { width: 800, height: 600, duration: 5, fps: 0.5, numLayers: 2 }, markers: { comp: [], layer: [] } },
  /* 6 */ { self: [{ t: 2, value: 9 }], base: 3, propSeed: 0, texts: [[null, EMOJI_TEXT]] },
  /* 7 */ {
    base: 1, propSeed: 77,
    markers: {
      comp: [
        { time: NaN, duration: 0, name: 'n1', comment: '' }, { time: 2, duration: 0, name: 'b', comment: '' },
        { time: NaN, duration: 0, name: 'n2', comment: '' }, { time: 0.5, duration: 0, name: 'a', comment: '' },
        { time: 2, duration: 1, name: 'b2', comment: '' },
      ],
      layer: [{ time: NaN, duration: 0, name: 'only', comment: 'x' }],
    },
  },
];

function resolveRef(ref: any): string | null {
  // AnimationEngine.resolveLayerRef — the same TypeError for a non-string ref.
  if (ref.startsWith('#')) {
    const id = ref.slice(1);
    return id.length > 0 ? `#${id}` : null;
  }
  return ref;
}

function tsContext(c: Ctx, time: number): any {
  const selfTrack = c.self ? track(c.self) : null;
  const value = selfTrack ? (sampleTrack(selfTrack, time) ?? c.base) : c.base;
  const ctx: any = { time, value };
  if (c.audio !== undefined) ctx.audio = c.audio;
  if (c.propSeed !== undefined) ctx.propSeed = c.propSeed;
  if (c.comp) ctx.comp = c.comp;
  if (c.layerInfo) ctx.layerInfo = c.layerInfo;
  if (selfTrack) {
    ctx.selfAt = (tt: number) => sampleTrack(selfTrack, tt) ?? c.base;
    ctx.selfSpan = { start: c.self![0]!.t, end: c.self![c.self!.length - 1]!.t };
    ctx.keyTimes = c.self!.map((k) => k.t);
  }
  if (c.ctrls) {
    const m = new Map(c.ctrls);
    ctx.ctrl = (name: unknown) => m.get(name as string) ?? 0;
  }
  if (c.tracks) {
    const byLayer = new Map<string, Map<string, any>>();
    for (const [l, p, kfs] of c.tracks) {
      if (!byLayer.has(l)) byLayer.set(l, new Map());
      byLayer.get(l)!.set(p, track(kfs));
    }
    ctx.layerAt = (name: unknown, prop: unknown, tt: number) => {
      const id = resolveRef(name);
      if (id === null) return undefined;
      const tr = (byLayer as Map<unknown, Map<unknown, any>>).get(id)?.get(prop);
      return tr ? sampleTrack(tr, tt) : undefined;
    };
  }
  if (c.spaces) {
    ctx.spaceAt = (name: unknown, tt: unknown) => {
      const s = c.spaces!.find(([n]) => n === name);
      if (!s) return undefined;
      const [, k, off, z] = s;
      const t = Number(tt);
      return {
        toComp: (p: number[]) => [p[0]! * k + off + t, p[1]! * k + off],
        fromComp: (p: number[]) => [(p[0]! - off - t) / k, (p[1]! - off) / k],
        toWorld: (p: number[]) => [p[0]! * k + off, p[1]! * k + off + t, z],
        fromWorld: (p: number[]) => [(p[0]! - off) / k, (p[1]! - off) / k + p[2]! * z],
      };
    };
  }
  if (c.rect) ctx.sourceRectAt = (tt: unknown, extents: unknown) => ({ top: -Number(tt), left: extents ? 1 : 0, width: 100, height: 40 });
  if (c.markers) ctx.markersAt = (scope: 'comp' | 'layer') => c.markers![scope];
  if (c.texts) {
    ctx.sourceTextAt = (name: unknown) => c.texts!.find(([n]) => n === name)?.[1];
    if (c.textValue) ctx.textValue = c.texts.find(([n]) => n === null)?.[1];
  }
  return ctx;
}

function styleCpp(s: Style): string {
  const str = (v: unknown) => u16(v as string);
  const opt = (v: unknown) => (v === undefined ? 'std::nullopt' : `std::u16string(${u16(v as string)})`);
  return `{${str(s.fontFamily)}, ${num(s.fontSize as number)}, ${str(s.fontWeight)}, ${str(s.fontStyle)}, ${str(s.fill)}, ` +
    `${opt(s.stroke)}, ${num(s.strokeWidth as number)}, ${num(s.letterSpacing as number)}, ${num(s.lineHeight as number)}, ` +
    `${num(s.baselineShift as number)}, ${num(s.horizontalScale as number)}, ${num(s.verticalScale as number)}, ` +
    `${str(s.textTransform)}, ${str(s.fontVariant)}, ${str(s.align)}, ${num(s.paragraphSpacing as number)}, ` +
    `${num(s.firstLineIndent as number)}, ${num(s.leftIndent as number)}, ${num(s.rightIndent as number)}, ` +
    `${num(s.spaceBefore as number)}, ${opt(s.direction)}}`;
}
function sampleCpp(t: TextSample): string {
  let runs = 'std::nullopt';
  if (t.runs) {
    const rs = t.runs.map((r) => {
      const o = (v: unknown) => (v === undefined ? 'std::nullopt' : typeof v === 'number' ? `std::optional<double>(${num(v)})` : `std::optional<std::u16string>(${u16(v as string)})`);
      const st = r.style;
      return `{${num(r.start)}, ${num(r.end)}, {${o(st.fontSize)}, ${o(st.fontFamily)}, ${o(st.fontWeight)}, ${o(st.fontStyle)}, ${o(st.letterSpacing)}, ${o(st.fill)}}}`;
    });
    runs = `std::vector<motion::expr::SourceTextRun>{${rs.join(', ')}}`;
  }
  return `motion::expr::SourceTextSample{${u16(t.text)}, ${styleCpp(t.style)}, ${runs}}`;
}

function ctxCpp(c: Ctx, i: number): string {
  const L: string[] = [`  {  // context ${i}`, '    GCtx c;'];
  if (c.self) L.push(`    c.self = {${c.self.map(kfCpp).join(', ')}};`);
  L.push(`    c.base = ${num(c.base)};`);
  if (c.audio !== undefined) L.push(`    c.audio = ${num(c.audio)};`);
  if (c.propSeed !== undefined) L.push(`    c.prop_seed = ${num(c.propSeed)};`);
  if (c.comp) L.push(`    c.comp = motion::expr::CompInfo{${num(c.comp.width)}, ${num(c.comp.height)}, ${num(c.comp.duration)}, ${num(c.comp.fps)}, ${num(c.comp.numLayers)}};`);
  if (c.layerInfo) L.push(`    c.layer_info = motion::expr::LayerInfo{${u16(c.layerInfo.name)}, ${num(c.layerInfo.width)}, ${num(c.layerInfo.height)}};`);
  if (c.ctrls) L.push(`    c.has_ctrl = true; c.ctrls = {${c.ctrls.map(([n, v]) => `{${u16(n)}, ${num(v)}}`).join(', ')}};`);
  if (c.tracks) L.push(`    c.has_layer_at = true; c.tracks = {${c.tracks.map(([l, p, k]) => `{${u16(l)}, ${u16(p)}, {${k.map(kfCpp).join(', ')}}}`).join(', ')}};`);
  if (c.spaces) L.push(`    c.has_space = true; c.spaces = {${c.spaces.map(([n, k, o, z]) => `{${u16(n)}, ${num(k)}, ${num(o)}, ${num(z)}}`).join(', ')}};`);
  if (c.rect) L.push('    c.has_rect = true;');
  if (c.markers) {
    const ms = [...c.markers.comp.map((m) => [0, m] as const), ...c.markers.layer.map((m) => [1, m] as const)];
    L.push(`    c.has_markers = true; c.markers = {${ms.map(([s, m]) => `{${s}, ${num(m.time)}, ${num(m.duration)}, ${u16(m.name)}, ${u16(m.comment)}}`).join(', ')}};`);
  }
  if (c.texts) {
    L.push(`    c.has_text = true;`);
    for (const [n, t] of c.texts) L.push(`    c.texts.push_back({${u16(n)}, ${sampleCpp(t)}});`);
    if (c.textValue) L.push('    c.text_value = true;');
  }
  L.push('    v.push_back(std::move(c));', '  }');
  return L.join('\n');
}

// ── Canonical Source Text result (test_expr.cpp builds the same string) ─────

const OVERRIDE_KEYS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'applyFill', 'stroke', 'strokeWidth', 'applyStroke',
  'tracking', 'leading', 'baselineShift', 'horizontalScale', 'verticalScale', 'textTransform', 'fontVariant', 'align',
  'firstLineIndent', 'leftIndent', 'rightIndent', 'spaceBefore', 'spaceAfter', 'direction', 'leadingType',
];
function canonStyle(s: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const k of OVERRIDE_KEYS) if (s[k] !== undefined) parts.push(`${k}=${String(s[k])}`);
  for (const k of Object.keys(s)) if (!OVERRIDE_KEYS.includes(k)) parts.push(`UNKNOWN:${k}`);
  return parts.join(';');
}
function canonText(r: any): string {
  return `${r.text}|${canonStyle(r.style)}|${r.ranges.map((g: any) => `[${String(g.start)},${String(g.count)},${canonStyle(g.style)}]`).join('')}`;
}

// ── The corpus ──────────────────────────────────────────────────────────────

/** A source too long for one C++ literal: `pre + unit × n + post`. */
type Rep = { pre: string; unit: string; n: number; post: string };
const rep = (pre: string, unit: string, n: number, post: string): Rep => ({ pre, unit, n, post });
type Src = string | Rep;
const expand = (s: Src): string => (typeof s === 'string' ? s : s.pre + s.unit.repeat(s.n) + s.post);
const srcCpp = (s: Src): string => (typeof s === 'string' ? `S(${u16(s)})` : `R(${u16(s.pre)}, ${u16(s.unit)}, ${s.n}, ${u16(s.post)})`);
type Case = { src: Src; ctx: number; times: number[]; text?: boolean };
const cases: Case[] = [];
const add = (ctx: number, times: number[], ...srcs: Src[]) => { for (const src of srcs) cases.push({ src, ctx, times }); };
const addText = (ctx: number, times: number[], ...srcs: string[]) => { for (const src of srcs) cases.push({ src, ctx, times, text: true }); };

// exprLang.test.ts — parser, literals, operators, sandbox, syntax errors
add(0, [0],
  '1 + 2 * 3', '(1 + 2) * 3', '2 * 3 + 1', '10 - 2 - 3', '10 / 2 / 5', '7 % 4', '-3 + 1', '- -3', '2 * -3',
  '.5', '1.25', '1e3', '1e-3', '1E2', '1e+2', '0.1 + 0.2', '1 / 3', '-7 % 3', '7 % -3', '5.5 % 2', '1 / 0', '-1 / 0', '0 / 0',
  '1 < 2', '2 <= 2', '3 > 4', '1 === 1', '1 !== 2', '1 < 2 === true', '1 > 0 ? 10 : 20', '0 > 1 ? 10 : 20', '1 ? 2 ? 3 : 4 : 5',
  'false && boom()', 'true || boom()', '"a"', "'a'", '"it\\\'s"', '"a\\nb"', 'Math.max(1, 5, 3)', '[1, 2, 3][1]', 'Math.sin(0)',
  'Math.round(1.6)', '1 +', '(1', '1; 2', '"abc', '@', 'f(1,', 'window', 'fetch("http://x")', 'globalThis', 'value.constructor',
  'value["constructor"]', 'value.__proto__', 'Math.prototype', 'speeed', 'value(1)', 'Math.nope(1)', 'value +', '"hello"',
  'value["con" + "structor"]', 'value["__pro" + "to__"]', 'value["proto" + "type"]', 'Math["con" + "structor"]', 'Math[value]',
  'value[["constructor"]]', 'time *', 'foo + 1', '1e', '1e+', '1.2.3', '5..toFixed(1)', '1 = 2', 'a => 1', '{}', '[1, 2,]',
  '`x`', '#', '1 ?', '1 ? 2', '1 ? 2 :', 'Math.', 'Math..sin', '"\\u0041"', '"\\x"', '()', '[', ']', ')', '1 2',
  'true', 'false', 'null', 'undefined', '[]', '[1]', '[1, 2, 3, 4]', '[1, 2, 3, 4, 5]', '[NaN]', '[1, null]', '[[1]]',
  '[1, 2] + [3]', '[] + []', '[] + {}', '"5" * "2"', '"5" + 2', '5 + "2"', '"5" - 2', 'true + 1', 'null + 1', 'undefined + 1',
  '"abc" < "abd"', '"10" < "9"', '10 < "9"', '"a" < 1', 'null == undefined', 'null === undefined', 'null == 0', '0 == ""',
  '"1" == 1', '[1] == 1', '[1,2] == "1,2"', 'NaN == NaN', 'true == 1', '"true" == true', '-0 === 0', '+"  42  "', '+"0x1F"',
  '+"1e3"', '+""', '+[]', '+[7]', '+[1, 2]', '+null', '+undefined', '+true', '-"3"', '!0', '!""', '!"0"', '![]', '!!Math',
  '"b" + "a" + +"a" + "a"', '1 + 2 + "3"', '"3" + 1 + 2', '"x" + [1, [2, 3]]', '"x" + null + undefined + true', '"" + 1e21',
  '"" + 1e-7', '"" + 123456789012345680000', '"" + 0.000001', '"" + -0', '"" + 2 ** 53', '"" + Math.PI', 'String',
  '(1 + 2) * (3 + 4) / (5 - 6) % 7', '1 || 2', '0 || 2', '0 && 2', '1 && 2', '"" || "d"', 'null ?? 1', '2 ** 3',
  '1 < 2 < 3', '3 > 2 > 1', '"2" > "12"', '[2] > 1', 'Math.max()', 'Math.min()', 'Math.max(1, NaN)', 'Math.max(-0, 0)',
  'Math.min(-0, 0)', '1/Math.min(0, -0)', '1/Math.max(-0, 0)', 'Math.hypot()', 'Math.hypot(3, 4)', 'Math.hypot(NaN, Infinity)',
  'Math.hypot(1e200, 1e200)', 'Math.hypot(1, 2, 3, 4, 5)', 'Math.round(-0.5)', 'Math.round(2.5)', 'Math.round(-2.5)',
  'Math.round(0.49999999999999994)', 'Math.sign(-3)', 'Math.trunc(-4.7)', 'Math.cbrt(27)', 'Math.fround(5.5)', 'Math.fround(5.05)',
  'Math.clz32(1)', 'Math.imul(3, 4)', 'Math.imul(0xffffffff, 5)', 'Math.f16round(5.0005)', 'Math.f16round(65520)', 'Math.E',
  'Math.LN10', 'Math.LN2', 'Math.LOG10E', 'Math.LOG2E', 'Math.PI', 'Math.SQRT1_2', 'Math.SQRT2', 'Math.pow(2, 0.5)',
  'Math.pow(-8, 1/3)', 'Math.pow(1, Infinity)', 'Math.pow(NaN, 0)', 'Math.pow(4.5, -3)', 'Math.pow(10, 308)', 'Math.pow(2, -1074)',
  'Math.atan2(1, -1)', 'Math.atan2(-0, -1)', 'Math.exp(1)', 'Math.log(10)', 'Math.log2(8)', 'Math.log10(1000)', 'Math.log1p(1e-10)',
  'Math.expm1(1e-5)', 'Math.sinh(1)', 'Math.cosh(1)', 'Math.tanh(0.5)', 'Math.asinh(1)', 'Math.acosh(2)', 'Math.atanh(0.5)',
  'Math.asin(0.5)', 'Math.acos(0.5)', 'Math.atan(1)', 'Math.tan(1e10)', 'Math.sin(1e22)', 'Math.cos(1e300)', 'Math.sqrt(-1)',
  'Math.abs("-3")', 'Math.floor("2.5")', 'Math.ceil([3.2])', 'Math.sin', 'Math.sin + ""', 'Math + ""', 'Math.toString()',
  'Math.hasOwnProperty("sin")', 'Math.hasOwnProperty("x")', 'Math.valueOf() === Math', 'Math == Math', 'thisComp === thisComp',
  '[1] === [1]', 'wiggle === wiggle', 'Math.sin === Math.sin', 'Math.max.call(null, 1, 9, 3)', 'Math.max.apply(null, [4, 8])',
  'Math.pow.call(0, 2, 10)', 'Math.random.x', 'Math.sin.call', 'Math.sin.length', 'Math.sin.name', 'wiggle.toString === Math.sin.toString',
);
// Number / String / Array built-ins
add(0, [0],
  '(1.005).toFixed(2)', '(2.5).toFixed(0)', '(-2.5).toFixed(0)', '(0.5).toFixed(0)', '(1e21).toFixed(2)', '(123.456).toFixed(10)',
  '(0).toFixed(3)', '(-0).toFixed(2)', '(1.45).toFixed(1)', '(8.345).toFixed(2)', '(0.000001).toFixed(7)', '(5).toFixed(101)',
  '(5).toFixed(-1)', '(5).toFixed("2")', '(5).toFixed()', '(123.456).toPrecision(4)', '(0.00001234).toPrecision(2)',
  '(123456).toPrecision(2)', '(1.5).toPrecision()', '(1).toPrecision(0)', '(255).toString(16)', '(255).toString(2)', '(-255).toString(36)',
  '(0.1).toString(3)', '(0.5).toString(2)', '(3.14159).toString(8)', '(1e21).toString(7)', '(10).toString(1)', '(10).toString(37)',
  '(123.456).toExponential()', '(123.456).toExponential(2)', '(0).toExponential(3)', '(1).toExponential(101)', '(12).valueOf()',
  'true.toString()', 'false.valueOf()', '(5).toString === (6).toString', '(5).constructor',
  '"hello".length', '"hello"[1]', '"hello"[9]', '"hello"["1"]', '"hello"["01"]', '"hello".charAt(1)', '"hello".charAt(-1)',
  '"hello".charCodeAt(0)', '"hello".charCodeAt(9)', '"\\ud83d\\ude00".codePointAt(0)', '"\\ud83d\\ude00".length', '"abc".at(-1)',
  '"abc".at(5)', '"a-b-c".split("-")', '"a-b-c".split("-", 2)', '"abc".split("")', '"abc".split()', '"".split("")', '"".split(",")',
  '"a,b,".split(",")', '"hello".indexOf("l")', '"hello".indexOf("l", 3)', '"hello".indexOf("")', '"hello".indexOf("", 99)',
  '"hello".lastIndexOf("l")', '"hello".lastIndexOf("l", 2)', '"hello".lastIndexOf("")', '"hello".includes("ell")',
  '"hello".startsWith("he")', '"hello".startsWith("l", 2)', '"hello".endsWith("lo")', '"hello".endsWith("l", 4)',
  '"hello".slice(1, 3)', '"hello".slice(-3)', '"hello".slice(3, 1)', '"hello".substring(3, 1)', '"hello".substring(-2)',
  '"hello".substr(1, 2)', '"hello".substr(-3, 2)', '"Hello".toUpperCase()', '"HeLLo".toLowerCase()', '"straße".toUpperCase()',
  '"ÀÉÎ".toLowerCase()', '"ΑΒΓ".toLowerCase()', '"  pad ".trim()', '"  pad ".trimStart()', '"  pad ".trimEnd()', '"\\u00a0x\\ufeff".trim()',
  '"5".padStart(3, "0")', '"5".padEnd(4, "ab")', '"5".padStart(3)', '"5".padStart(3, "")', '"ab".repeat(3)', '"ab".repeat(0)',
  '"ab".repeat(-1)', '"a.b.c".replace(".", "-")', '"a.b.c".replaceAll(".", "-")', '"abc".replace("b", "[$&]")',
  '"abc".replace("b", "$`|$\'")', '"abc".replace("b", "$$")', '"abc".replace("x", "y")', '"aaa".replaceAll("", "-")',
  '"abc".replace("b", Math.max)', '"x".concat(1, [2, 3], null)', '"abc".toString()', '"abc".valueOf()', '"a".isWellFormed()',
  '"\\ud800".isWellFormed()', '"abc".big()', '"abc".anchor("x"y")', '"abc".fontsize(7)', '"abc".sub()',
  'wiggle.name', 'wiggle.length', 'linear.length', 'clamp.name + clamp.length', 'thisComp.layer.name', 'marker.key.name',
  'marker.nearestKey.length', 'toComp.name', 'toComp.length', 'random.length', 'ctrl.name', 'ctrl.length', 'Math.max.length',
  '"x".padStart.length', '[].reduce.name', '(1).toFixed.name', 'seedRandom.length', 'noise.length',
  '"hello".toFixed', '(5).length', 'true.length',
  '[1, 2, 3].length', '[1, 2, 3].join()', '[1, 2, 3].join("-")', '[1, null, undefined, 2].join()', '[1, [2, [3]]].join(";")',
  '[3, 1, 2].sort()', '[10, 9, 1, 100].sort()', '[3, 1, 2].sort(Math.max)', '[1, 2, 3].reverse()', '[1, 2, 3].slice(1)',
  '[1, 2, 3].slice(-2, -1)', '[1, 2].concat([3], 4, [[5]])', '[1, 2, 3].indexOf(2)', '[1, 2, NaN].indexOf(NaN)',
  '[1, 2, NaN].includes(NaN)', '[1, 2, 1].lastIndexOf(1)', '[1, 2, 3].at(-1)', '[4, 9, 16].map(Math.sqrt)',
  '[1.5, 2.5].map(Math.round)', '[1, -2, 3].filter(Math.sign)', '[1, 2, 3].reduce(Math.max)', '[1, 2, 3].reduce(Math.max, 10)',
  '[].reduce(Math.max)', '[[1, 2], [3]].reduce(add)', '[1, 2, 3].some(Math.sign)', '[0, 0].some(Math.sign)',
  '[1, 2].every(Math.sign)', '[0, 5].find(Math.sign)', '[0, 5].findIndex(Math.sign)', '[5, 0].findLast(Math.sign)',
  '[1, [2, [3, [4]]]].flat()', '[1, [2, [3, [4]]]].flat(2)', '[1, 2, 3].fill(0, 1)', '[1, 2].push(3)', '[1, 2].pop()',
  '[1, 2].shift()', '[1, 2].unshift(0)', '[1, 2].toString()', '[1, 2].forEach(Math.sin)', '[1, 2, 3].toReversed()',
  '[1, 2].map(1)', '[1, 2].hasOwnProperty(1)', '[1, 2].hasOwnProperty("length")', '[1, 2]["length"]', '[1, 2][-1]',
  '[1, 2][1.5]', '[1, 2]["1"]', '[1, 2][true]', '[5][0.0]', '[1, 2].toLocaleString', '[1,2].map(Math.max).join()',
  'Math.max(...[1])', 'Math.sin.apply(null, "x")', 'Math.max.apply(null, null)',
);
// expressions.test.ts, expressionBudget.test.ts, expressionEnabled etc.
add(0, [0, 2, 1.5],
  'time * 50', 'clamp(value + 10, 0, 100)', 'wiggle(2, 30)', 'value + audio * 100', "value + ctrl('Speed') * 2",
  'valueAtTime(0.25)', "layer('Title', 'x')", "layerAt('Title', 'x', 5)", "layer('Ghost', 'x') + 5", "loopOut('cycle')",
  "loopIn('offset')", 'thisComp.width + thisComp.fps', 'timeToFrames(1.5)', 'framesToTime(120)', 'ease(time, 0, 2, 10, 20)',
  'linear(time, 10, 20)', 'wiggle(2, 30, 3, 0.5, 1.0)', 'velocity + speed + velocityAtTime(2)', 'thisLayer.width + thisProperty.valueAtTime(0)',
  'wiggle(2, 30, 1000000000)', 'wiggle(2, 30, 8)', 'wiggle(2, 30, 1000000)', 'wiggle(2, 30, 4)', 'wiggle(2, 30, 1)',
  'value + Math.sin(time) * 40 + wiggle(3, 10)', 'thisComp.frameDuration', 'thisComp.duration', 'thisComp.numLayers',
  'thisComp.height', 'thisLayer.name', 'thisLayer.height', 'thisLayer.name + ""', 'sourceRectAtTime().width',
  'sourceRectAtTime(1, true).height', 'numKeys', 'key(1).time', 'key(1).value', 'key(numKeys).index', 'nearestKey(time).time',
  'nearestKey().value', 'marker.numKeys', 'marker.key(1).time', 'marker.nearestKey(time).index', 'thisComp.marker.numKeys',
  'toComp([0, 0])', 'fromComp([960, 540])', 'toWorld([0, 0])', 'fromWorld([960, 540])', 'plugin', 'plugin.x', 'plugin.acme.pulse(1)',
  'text.sourceText', 'text.sourceText.length', 'thisLayer.text.sourceText', 'thisComp.layer("x")', 'thisComp.layer("x").name',
  'thisComp.layer("x").width', 'thisComp.layer("x", "")', 'thisComp.layer', 'thisComp + 1', 'thisProperty.velocity',
  'thisProperty.speed', 'thisProperty.value', 'thisProperty.loopOut()', 'thisProperty.loopIn("pingpong")', 'posterizeTime(8)',
  'posterizeTime(0)', 'posterizeTime(-1, 3)', 'posterizeTime("8", time)', 'seedRandom(5)', 'random()', 'noise(time)', 'gaussRandom()',
);
// the vector helpers (vectorExpressions.test.ts + AE broadcast rules)
add(0, [0, 2],
  '[time * 100, 50]', '[1, "two"]', '[10 + time, 20 + time, 30 + time]', '[5, 7]', 'add([10, 20], 5)', 'add(5, [10, 20])',
  'add([1, 2, 3], [10, 20])', 'add(["a", 2], [1, 2])', 'add([], [])', 'add([null], [1])', 'sub([10, 20], [1, 2, 3])', 'mul([2, 3], 4)',
  'div([10, 20], [2, 0])', 'div([10, 20], ["0", 5])', 'div(10, 4)', 'dot([1, 2, 3], [4, 5, 6])', 'dot([1, 0], [0, 1])', 'dot(3, [1, 2])',
  'cross([1, 0], [0, 1])', 'cross([1, 2, 3], [4, 5, 6])', 'cross(1, 2)', 'cross([1, null, 3], [4, 5])', 'length([3, 4])',
  'length([1, 2], [4, 6])', 'length(5)', 'length([])', 'length(["3", 4])', 'normalize([3, 4])', 'normalize([0, 0])', 'normalize(5)',
  'normalize([1, 1, 1, 1])', 'add([1, 2], [3, 4])[1]', 'sub(value, [10, 0])', 'mul(value, 2)', 'div(value, 2)', 'add(value, [10, 0])',
  'add([1,2,3,4,5], 1)', 'length(add([1, 2], [2, 2]))', '[Infinity]', '[0, -0]', '[-0]', '-0', '0 * -1', '[1, 2, 3][3]',
);
// ranges: linear / ease / easeIn / easeOut / clamp — JS coercions included
for (const f of ['linear', 'ease', 'easeIn', 'easeOut']) {
  add(0, [0, 0.25, 0.5, 1, 1.7, -0.4],
    `${f}(time, 0, 1, 0, 100)`, `${f}(time, 0.2, 1.2, -50, 50)`, `${f}(time, 10, 20)`, `${f}(time, 1, 1, 5, 9)`,
    `${f}(time, 1, 0, 0, 100)`, `${f}(time, 0, 1, "5", 10)`, `${f}(time, "0", 1, 0, 10)`, `${f}(time, 0, 1, undefined, undefined)`,
    `${f}(time, 0, 1, [1, 2], 10)`, `${f}(time, 0, 1)`, `${f}(time)`, `${f}("0.5", 0, 1, 0, 10)`,
  );
}
add(0, [0], 'clamp(5, 0, 10)', 'clamp(-5, 0, 10)', 'clamp(50, 0, 10)', 'clamp(5, 10, 0)', 'clamp("7", 0, 10)', 'clamp(5)',
  'clamp(NaN, 0, 1)', 'clamp(-0, 0, 1)', 'clamp(0, -0, 1)', 'timeToFrames()', 'timeToFrames(2.51, 10)', 'framesToTime(12, 24)',
  'framesToTime("12")', 'timeToFrames(1/3, 30)', 'framesToTime(1)');
// wiggle / random / noise determinism over seeds and times (contexts 0, 2, 3, 4, 6)
const WIGGLES = [
  'wiggle(2, 30)', 'wiggle(3, 40)', 'wiggle(1, 100, 3)', 'wiggle(5, 10, 2, 0.7)', 'wiggle(0.5, 200, 8, 0.9)', 'wiggle(3, 40, 1, 0.5, posterizeTime(6, time))',
  'wiggle(2, "30")', 'wiggle("2", 30, "2")', 'wiggle(2, 30, 0)', 'wiggle(2, 30, -3)', 'wiggle(2, 30, NaN)', 'wiggle(2, 30, 2.9)',
  'wiggle(2, undefined, 2)', 'wiggle(2, thisComp.nope)', 'wiggle(2, 0)', 'wiggle(2, -30, 3)', 'wiggle(2, 30, 3, 0)', 'wiggle(2, 30, 3, -1)',
  'wiggle(2, "30", 3)', 'wiggle(2, [30], 2)', 'wiggle(1e6, 30)', 'wiggle(2, 30, 1, 0.5, 12345.678)',
  'random()', 'random(100)', 'random(-5, 5)', '[random(), random(), random()]', 'random("10")', 'random("a", 5)', 'random(1, "5")',
  'seedRandom(7) + random()', 'seedRandom(7, true) + random(10)', 'random() + seedRandom(3) + random()', 'seedRandom("x") + random()',
  'seedRandom(-2.5) + random(1, 2)', 'gaussRandom()', '[gaussRandom(), gaussRandom()]', 'seedRandom(99) + gaussRandom()',
  'noise(time)', 'noise(time, 3)', 'noise(-time * 13.1)', 'noise(1e7)', 'noise("2")', 'noise(time) + random()',
  // Math.random draws from the same seeded sequence as random()/gaussRandom().
  'Math.random()', '[Math.random(), random(), Math.random()]', 'seedRandom(7) + Math.random()',
  'Math.random() + gaussRandom() + Math.random() * 100', 'seedRandom("x") + Math.random(5)', 'Math.random.call(null)',
  'Math.random.apply(Math, [])', '[4, 5].map(Math.random).join()', 'Math.random === Math.random', 'Math.random.name.length',
  'Math.random.length', 'Math.hasOwnProperty("random")', '(Math + "").length', 'Math.toString().length', 'value + Math.random() * 10 - 5',
  'value + wiggle(4, 20) - value', 'Math.sin(time * 127.1) * 43758.5453', 'posterizeTime(12) * 1000',
];
for (const ctx of [0, 2, 3, 4, 6]) add(ctx, [0, 0.1, 0.7, 1.33, 2.25, 10.5, 97.03], ...WIGGLES);

// The random stream mixes in the FRAME (round(time * fps)) unless seedRandom(s, true):
// the default and seedRandom(s) vary across times, timeless is constant, sub-frame
// times (0.004 s after a frame, a motion-blur sample) keep the frame's values,
// gaussRandom and Math.random follow the same rule, and wiggle is unaffected.
const RANDOM_TIME = [
  'random()', 'random(100)', 'seedRandom(5) + random()', 'seedRandom(5, true) + random()', 'seedRandom(5, 1) + random()',
  'seedRandom(5, 0) + random()', 'seedRandom(5, "") + random()', 'seedRandom(5, true) + seedRandom(5) + random()',
  'gaussRandom()', 'seedRandom(5, true) + gaussRandom()', 'Math.random()', 'seedRandom(5, true) + Math.random()',
  'seedRandom(9) + Math.random() * 10', '[random(), Math.random(), gaussRandom()]', 'wiggle(2, 30)',
  'seedRandom(5, true) + wiggle(2, 30)', 'noise(time) + seedRandom(1, true) + random()',
];
for (const ctx of [0, 3, 5]) add(ctx, [0, 0.004, 0.5, 0.504, 1, 1.004, 2, -1.5, 1e6], ...RANDOM_TIME);

// loopOut / loopIn / valueAtTime / velocity over the keyed contexts
const LOOPS = [
  "loopOut('cycle')", "loopOut('pingpong')", "loopOut('offset')", "loopOut('continue')", 'loopOut()', "loopOut('bogus')",
  "loopIn('cycle')", "loopIn('pingpong')", "loopIn('offset')", "loopIn('continue')", 'loopIn()', 'loopOut(5)',
  'valueAtTime(time - 0.5)', 'valueAtTime("0.5")', 'valueAtTime()', 'valueAtTime(time + "1")', 'velocity', 'speed',
  'velocityAtTime(time)', 'velocityAtTime("1")', 'velocityAtTime(time + "")', 'key(1).value + key(numKeys).value', 'key(0).time',
  'key(99).time', 'key(NaN).index', 'key(NaN).value', 'key(1.5).index', 'key("2").time', 'nearestKey(1.9).index',
  'nearestKey(-10).time', 'nearestKey(time).value', 'numKeys', 'thisProperty.valueAtTime(0)', 'thisProperty.velocityAtTime(1)',
  'time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * 0.05 * Math.sin((time - key(numKeys).time) * 12) / Math.exp((time - key(numKeys).time) * 4)',
  'time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * Math.exp(-(time - key(numKeys).time) * 5)',
  "loopOut('offset') + valueAtTime(0.5) + wiggle(2, 30)",
  // A time that is not a number is a stated error, whatever the track.
  'valueAtTime(0/0)', 'valueAtTime("x")', 'valueAtTime([0.5])', 'valueAtTime(null)', 'thisProperty.valueAtTime()',
  'velocityAtTime()', 'velocityAtTime(0/0)', 'thisProperty.velocityAtTime("y")',
  // key(n): an index that rounds to NaN is 1.
  'key(0/0).index', 'key(0/0).time', 'key().index', 'key("x").value', 'key(-Infinity).index', 'key(Infinity).index',
];
for (const ctx of [0, 1, 2, 3, 6]) add(ctx, [-3.3, -1.25, -0.5, 0, 0.25, 0.5, 1, 1.25, 1.75, 2, 2.5, 2.75, 3.3, 7.01], ...LOOPS);

// The full-context API: layers, ctrl, spaces, markers, rects (context 3; some in 5)
const FULL = [
  "layer('Leader', 'x')", "layerAt('Leader', 'x', time - 0.2)", "layerAt('Title', 'y', 2.2)", "layer('Title', 'z')",
  "layer('#n_42', 'x')", "layer('#', 'x')", "layer(5, 'x')", 'layer(null, "x")', "layer('Leader')", "layer('Leader', 1)",
  "layerAt('Leader', 'x', '0.5')", "thisComp.layer('Leader', 'x')", "thisComp.layer('Title', 'y') * 2",
  "ctrl('Speed')", "ctrl('Amp') * time", "ctrl('nope')", 'ctrl(5)', 'ctrl()', 'audio', 'audio * 200 + value',
  'toComp([3, 4])', 'fromComp([6, 8])', 'toWorld([3, 4])', 'fromWorld([6, 8, 7])', 'fromWorld([6, 8])', 'fromWorld([6, 8, "7"])',
  "thisComp.layer('Other').toComp([3, 4])", 'thisLayer.toComp([3, 4])', "thisComp.layer('Target').fromComp([0, 0], 2)",
  'toComp([0, 0], 4)', "thisComp.layer('Nope').toComp([0, 0])", 'toComp(5)', "toComp('nope')", "toWorld('nope')",
  "fromComp('nope')", "fromWorld('nope')", 'toComp([1])', 'toComp([1, NaN])', 'toComp([1, "2"])', 'toComp([1, 2, 3, 4])',
  "thisComp.layer('Nope').toComp(5)", 'thisComp.layer(7).toComp([1, 1])', 'toComp([0, 0])[1] + fromComp([10, 10])[0]',
  'sourceRectAtTime()', 'sourceRectAtTime().top', 'sourceRectAtTime(2.5).top', 'sourceRectAtTime(0, true).left',
  'sourceRectAtTime(0, "").left', 'sourceRectAtTime(0, 1).width', 'sourceRectAtTime("3").top + sourceRectAtTime().height',
  'marker.numKeys', 'thisComp.marker.numKeys', 'thisLayer.marker.numKeys', 'marker.key(1).time', 'marker.key(2).name + ""',
  'marker.key(2).comment + marker.key(3).comment', 'thisComp.marker.key(1).time', 'marker.key(0).time', 'marker.key(-5).time',
  'marker.key(99).time', 'marker.key(1.6).time', 'marker.key(1).duration', 'marker.key("beat").time', 'marker.key("beat").index',
  'marker.key("chorus").index', 'marker.key("Outro").time', 'marker.key("nope").index', 'marker.key("").time', 'marker.key(NaN)',
  'marker.key(NaN).time', 'marker.nearestKey(1.9).time', 'marker.nearestKey(2).name', 'marker.nearestKey(0).time',
  'marker.nearestKey(100).index', 'marker.nearestKey().time', 'marker.nearestKey("3").comment', 'thisComp.marker.nearestKey(2).name',
  'marker.key(1)', 'thisComp.marker.key("head").duration', 'marker.key(text.sourceText)',
  'thisLayer.name + ":" + thisLayer.width', 'thisComp.width / thisComp.height', 'thisComp.frameDuration * 24',
  // marker.key(n): an index that rounds to NaN is 1, like key(n).
  'marker.key(0/0).time', 'marker.key().index', 'thisComp.marker.key(0/0).name', 'marker.key(null).index',
  // Runtime messages are never "Syntax error" because of their words.
  "thisComp.layer('missing').toComp([0, 0])", "thisComp.layer('Unexpected').fromComp([0, 0])", "layer('missing', 'x')",
  'timeToFrames()', 'framesToTime(48)', 'thisComp.layer("Leader").name', 'thisComp.layer("Leader").width',
];
add(3, [0, 0.8, 1.9, 3.75], ...FULL);
// Markers with NaN times: ascending, stable, NaN last (compareMarkerTimes) in both engines.
add(7, [0, 1],
  'thisComp.marker.numKeys', 'thisComp.marker.key(3).index', 'thisComp.marker.key("n2").index', 'thisComp.marker.key(5).time',
  'thisComp.marker.key(3).duration', 'marker.key(0/0).time', 'Math.random()',
);
addText(7, [0],
  'thisComp.marker.key(1).name + thisComp.marker.key(2).name + thisComp.marker.key(3).name + thisComp.marker.key(4).name + thisComp.marker.key(5).name',
  'thisComp.marker.nearestKey(0.6).name + "|" + thisComp.marker.nearestKey(5).name + "|" + thisComp.marker.nearestKey(0/0).name',
  'marker.key(1).name + marker.nearestKey(0).comment', 'Math.random.name', 'Math + ""',
);
add(5, [0, 1.25], ...FULL.slice(0, 60), 'thisComp.frameDuration', 'timeToFrames(3)', 'marker.nearestKey(5).time', 'marker.key("x").duration');

// Source Text: numeric reads (run) in the text context, plus runText results
const TEXT_NUM = [
  'text.sourceText.style.fontSize', 'text.sourceText.style.tracking', 'text.sourceText.style.leading',
  'text.sourceText.style.fillColor[0]', 'text.sourceText.style.horizontalScaling', 'text.sourceText.style.isFauxBold ? 1 : 0',
  'text.sourceText.style.applyStroke ? 1 : 0', 'text.sourceText.style.spaceAfter', 'thisComp.layer("Title").text.sourceText.getStyleAt(1).fontSize',
  'thisComp.layer("Title").text.sourceText.getStyleAt(5).fontSize', 'thisComp.layer("Title").text.sourceText.getStyleAt(0).fillColor[1]',
  'thisComp.layer("Title").text.sourceText.getStyleAt(3).tracking', 'thisComp.layer("Title").text.sourceText.style.fillColor[1]',
  'thisComp.layer("Title").text.sourceText.style.strokeColor[2]', 'text.sourceText.style.strokeColor[0]',
  'text.sourceText.style.setFontSize(100).fontSize', 'text.sourceText.style.setFauxBold(true).isFauxBold ? 1 : 0',
  'text.sourceText.style.setFontSize(96).setTracking(100).tracking', 'text.sourceText.style.setFontSize(10) ? text.sourceText.style.fontSize : 0',
  'text.sourceText.style.setLeftMargin(12).leftMargin', 'text.sourceText.length', 'text.sourceText.split("l").length',
  'thisComp.layer("Emoji").text.sourceText.length', 'text.sourceText.getStyleAt(2.7).fontSize', 'text.sourceText.getStyleAt(-3).fontSize',
  'text.sourceText.getStyleAt("1")', 'thisComp.layer("Nope").text.sourceText.length', 'text.sourceText == "Hello" ? 1 : 0',
  'text.sourceText === "Hello" ? 1 : 0', 'text.sourceText.value.length', 'value.length', 'thisProperty.value.length',
  'valueAtTime(0).length', 'text.sourceText.indexOf("l")', 'text.sourceText.charCodeAt(1)', 'text.sourceText.hasOwnProperty("style") ? 1 : 0',
  'text.sourceText["1"].charCodeAt(0)', 'text.sourceText.style.setFillColor([0.5, 0.25, 1]).fillColor[0]',
  'text.sourceText.style.setStrokeColor("rgb(10, 20, 300)").strokeColor[2]', 'text.sourceText.style.setFillColor("#abcdef80").fillColor[2]',
  'text.sourceText.style.setFillColor("#f0c").fillColor[1]', 'text.sourceText.style.setFillColor("bogus").fillColor[1]',
  'text.sourceText.style.setFillColor("RGBA(1.5,2 3)").fillColor[0]', 'text.sourceText.style.setApplyFill(false).applyFill ? 1 : 0',
  'text.sourceText.style.setStrokeWidth(-2).strokeWidth', 'text.sourceText.style.setLeading(-5).leading',
  'text.sourceText.style.setHorizontalScaling(1.5).horizontalScaling', 'text.sourceText.style.setSpaceBefore(4).spaceBefore',
  'text.sourceText.style.setBaselineShift(3).baselineShift', 'text.sourceText.style.setFontSize(0).fontSize',
  "layer('Leader', 'x') + text.sourceText.length",
];
add(4, [0, 0.5], ...TEXT_NUM);
const TEXT = [
  'text.sourceText.style.font', 'text.sourceText.style.justification', 'thisComp.layer("Title").text.sourceText.style.justification',
  'text.sourceText.style.setFontSize(80).setFillColor([1, 0, 0]).setFont("Roboto").setStrokeWidth(2).setStrokeColor([0, 0, 1])',
  'value.style.setFauxBold(true).setFauxItalic(true).setAllCaps(true).setSmallCaps(true).setBaselineShift(4).setHorizontalScaling(1.5).setVerticalScaling(0.5).setTracking(50).setLeading(72)',
  'value.style.setFontSize(20, 1, 3).setFillColor([0, 1, 0], 0, 2).setFauxBold(true, 4)',
  'value.style.setJustification("alignCenter").setFirstLineIndent(10).setLeftMargin(5).setRightMargin(6).setSpaceBefore(3).setSpaceAfter(9).setDirection("dirRightToLeft").setLeadingType("leadingEastAsian")',
  'value.style.setJustification("justifyLastLineFull").justification', 'value.style.setDirection("dirRightToLeft").direction',
  'value.style.setJustification("alignCenter", 0, 2)', 'thisComp.layer("Title").text.sourceText.style.setFontSize(64)',
  'thisComp.layer("Title").text.sourceText.style', 'thisComp.layer("Title").text.sourceText', 'value.style.setFontSize(64)',
  'value.style.setText("Bye").setFontSize(30, 0, 1)', 'Math.round(time * 10) + 7', 'value + "!"', 'thisProperty.value.length > 3',
  'value.style.setFontSize("big")', 'value.style.setFillColor(3)', 'value.style.setJustification("middle")', 'null', 'undefined',
  'value.style.setFont("  Fira Code  ")', 'value.style.setFont("")', 'value.style.setFont(3)', 'value.style.setText(42)',
  'value.style.setText(null)', 'value.style.setText([1, 2])', 'value.style.setText("x".repeat(100001))', '"x".repeat(100001)',
  '"x".repeat(100000).length', 'value.style.setFontSize(10, 2)', 'value.style.setFontSize(10, 9, 3)', 'value.style.setFontSize(10, 1, 0)',
  'value.style.setFontSize(10, -2, 3)', 'value.style.setFontSize(10, "1")', 'value.style.setFontSize(10, 1, "2")',
  'value.style.setFontSize(10, 1.7, 2.9)', 'value.style.setFauxBold(false)', 'thisComp.layer("Title").text.sourceText.style.setFauxBold(false)',
  'thisComp.layer("Title").text.sourceText.style.setFauxBold(1)', 'value.style.setAllCaps(0).setSmallCaps("")',
  'value.style.setApplyStroke(false).setApplyFill(true)', 'value.style.setDirection("ltr").setLeadingType("eastAsian")',
  'value.style.setDirection(1)', 'value.style.setSpaceAfter(2).spaceAfter', 'value.style.setSpaceAfter(2)',
  'value.style.getStyleAt', 'text.sourceText.getStyleAt(1).setFontSize(9)', 'text.sourceText.getStyleAt(1)',
  'value.style.setFontSize(12).setFontSize(14, 0, 2).setFontSize(16, 1, 1)', '[1, 2, "x"]', '[text.sourceText, 2]',
  'time', 'true', 'Math', 'wiggle', '1 / 0', 'NaN', '{}', 'thisComp', 'text.sourceText + text.sourceText',
  'text.sourceText.toUpperCase()', 'text.sourceText.split("").reverse().join("")', 'text.sourceText.slice(1, 3) + time.toFixed(2)',
  'thisComp.layer("Emoji").text.sourceText.style.setFontSize(20, 1)', 'thisComp.layer("Emoji").text.sourceText.style.setFontSize(20, 0)',
  'thisComp.layer("Emoji").text.sourceText.style.fillColor.join()', 'thisComp.layer("Nope").text.sourceText + ""',
  'thisComp.layer("Title").text.sourceText.getStyleAt(2).font', 'thisComp.layer("Title").text.sourceText.getStyleAt(2).setFontSize(5)',
  'thisComp.layer("Title").text.sourceText.style.direction', 'value.style.leadingType', 'value.style.setFontSize(0.01).fontSize + ""',
  'value.style.isAllCaps + "|" + value.style.isSmallCaps + "|" + value.style.isFauxItalic',
  'value.style.fillColor + ""', 'value.style.strokeColor + ""', 'value.style.setStrokeColor([2, -1, 0.5]).strokeColor + ""',
  'valueAtTime(0).style.fontSize + ""', 'text.sourceText.style.setFontSize(40, 1, 1).getStyleAt', 'layer("Leader", "x") + " px"',
];
addText(4, [0, 1.5], ...TEXT);
addText(6, [0], 'text.sourceText.style.setFontSize(20, 1)', 'text.sourceText.style.setText("héllo wörld").setFontSize(20, 3)',
  'text.sourceText', 'value + 1', 'text.sourceText.length', 'thisComp.layer("Title").text.sourceText');
addText(0, [0], 'text.sourceText', 'value', 'valueAtTime(1)', '"no text layer"');
let bigRange = 'value.style';
for (let i = 0; i <= 256; i++) bigRange += `.setFontSize(10, ${i}, 1)`;  // < 6k chars
addText(4, [0], bigRange);

// Parse depth (exprLang.ts MAX_PARSE_DEPTH = 2000): 1 999 / 2 000 / 2 001 levels
// reached through parentheses, prefix operators, both mixed, arrays, call
// arguments and binary right operands. Parsing succeeds up to 2 000; the
// deepest that parse then fail evaluation's own MAX_EVAL_DEPTH.
for (const levels of [1999, 2000, 2001]) {
  const n = levels - 1;
  add(0, [0],
    rep('', '(', n, `1${')'.repeat(n)}`), rep('', '-', n, '1'), rep('', '[', n, `1${']'.repeat(n)}`),
    rep('', 'Math.abs(', n, `1${')'.repeat(n)}`), rep('1', '*(1', Math.floor(n / 2), ')'.repeat(Math.floor(n / 2))),
  );
}
add(0, [0], rep('', '-(', 999, `1${')'.repeat(999)}`), rep('', '-(', 1000, `1${')'.repeat(1000)}`),
  rep('', '!-+', 666, '0'), rep('', '!-+', 667, '0'), rep('', '(', 2000, '1'), rep('', '(', 5000, `1${')'.repeat(5000)}`),
  rep('', '-', 30000, '1'), rep('1?', '1?', 1998, `1${':1'.repeat(1999)}`), rep('1?', '1?', 1999, `1${':1'.repeat(2000)}`),
);

// Budgets and depth (exprLang.ts MAX_EVAL_STEPS / MAX_EVAL_DEPTH), in one evaluation.
add(0, [0],
  rep('1', '+1', 200000, ''), rep('1', '+1', 99999, ''), rep('1', '+1', 510, ''), rep('1', '+1', 511, ''), rep('1', '+1', 600, ''),
  rep('', '-', 509, '1'), rep('', '-', 511, '1'), rep('', '(', 1500, `1${')'.repeat(1500)}`), rep('[', '1,', 120000, '1]'),
  rep('[', '1,', 250000, '1]'), rep('', '!', 300, '0'), rep('[', '[1],', 1000, '1].length'),
);

// A generated sweep: every Math function over a spread of arguments.
const MATH1 = ['abs', 'acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'ceil', 'cbrt', 'expm1', 'clz32', 'cos', 'cosh', 'exp',
  'floor', 'fround', 'log', 'log1p', 'log2', 'log10', 'round', 'sign', 'sin', 'sinh', 'sqrt', 'tan', 'tanh', 'trunc'];
const ARGS = ['0.3', '-2.7', '12.5', '1e5', 'time * 3.7 - 1', '"4"', 'null', '[2]', 'true'];
for (const f of MATH1) for (const a of ARGS) add(0, [0.8], `Math.${f}(${a})`);

// ── Run the TypeScript and emit ─────────────────────────────────────────────

const out: string[] = [
  '// GENERATED by native/tests/gen_golden_expr.ts — do not edit by hand.',
  '// Regenerate:  node native/tests/gen_golden_expr.ts',
  `// Reference: Node ${process.version}, V8 ${process.versions.v8}.`,
  '//',
  '// #ifdef MOTION_GOLDEN_EXPR_CONTEXTS: statements that fill `std::vector<GCtx> v`.',
  '// Sources are S(u"…") or R(pre, unit, n, post) = pre + unit×n + post.',
  '// MOTION_EXPR_NUM(ctx, time_bits, src, kind, v0, v1, v2, v3, size, error)  kind 0 null, 1 number, 2 vector',
  '// MOTION_EXPR_TEXT(ctx, time_bits, src, ok, canonical, error)',
  '',
  '#ifdef MOTION_GOLDEN_EXPR_CONTEXTS',
  ...CTXS.map(ctxCpp),
  '#else',
];
let numRows = 0;
let textRows = 0;
for (const c of cases) {
  for (const t of c.times) {
    const ctx = tsContext(CTXS[c.ctx]!, t);
    const compiled = compileExpression(expand(c.src));
    if (c.text) {
      const r = compiled.runText(ctx);
      out.push(`MOTION_EXPR_TEXT(${c.ctx}, ${hex(t)}, ${srcCpp(c.src)}, ${r.result ? 1 : 0}, ${u16(r.result ? canonText(r.result) : '')}, ${u16(r.error ?? '')})`);
      textRows++;
    } else {
      const r = compiled.run(ctx);
      let kind = 0;
      let v = [0, 0, 0, 0];
      let size = 0;
      if (typeof r.value === 'number') { kind = 1; v = [r.value, 0, 0, 0]; size = 1; }
      else if (Array.isArray(r.value)) { kind = 2; size = r.value.length; v = [0, 1, 2, 3].map((i) => r.value[i] ?? 0); }
      out.push(`MOTION_EXPR_NUM(${c.ctx}, ${hex(t)}, ${srcCpp(c.src)}, ${kind}, ${v.map(hex).join(', ')}, ${size}, ${u16(r.error ?? '')})`);
      numRows++;
    }
  }
}
out.push('#endif', '');
writeFileSync(join(here, 'golden_expr.inc'), out.join('\n'));
console.log(`wrote golden_expr.inc: ${numRows} numeric + ${textRows} text samples, ${cases.length} expressions`);

// ── Engine scenario: AnimationEngine.sample over cross-layer chains ─────────

interface ENode { id: string; name: string; props: Array<{ prop: string; kfs?: Kf[]; expr?: Src; enabled?: boolean }> }
const SCENE: ENode[] = [
  { id: 'lead', name: 'Leader', props: [{ prop: 'x', kfs: [{ t: 0, value: 0 }, { t: 2, value: 200 }] }, { prop: 'y', kfs: BEZ }] },
  { id: 'fol', name: 'Follower', props: [
    { prop: 'x', kfs: [{ t: 0, value: 0 }], expr: "layerAt('Leader', 'x', time - 0.5)" },
    { prop: 'y', expr: "layer('Leader', 'y') + wiggle(2, 10)" },
    { prop: 'z', expr: '[1, 2, time]' },
    { prop: 'scaleY', expr: '[10, 20 + time]' },
    { prop: 'rotation', expr: 'wiggle(3, 40)' },
    { prop: 'rotationZ', expr: '[5, 6]' },
  ] },
  { id: 'cy1', name: 'CycleA', props: [{ prop: 'x', kfs: [{ t: 0, value: 11 }], expr: "layer('CycleB', 'x') + 1" }] },
  { id: 'cy2', name: 'CycleB', props: [{ prop: 'x', kfs: [{ t: 0, value: 22 }], expr: "layer('CycleA', 'x') + 1" }] },
  { id: 'self', name: 'Selfie', props: [{ prop: 'x', expr: "layer('Selfie', 'x') + 1" }] },
  { id: 'err', name: 'Broken', props: [{ prop: 'x', kfs: [{ t: 0, value: 5 }, { t: 1, value: 6 }], expr: 'nope + 1' }, { prop: 'y', expr: '"str"' }] },
  { id: 'dis', name: 'Disabled', props: [{ prop: 'x', kfs: [{ t: 0, value: 3 }], expr: 'boom', enabled: false }] },
  { id: 'rd', name: 'Reader', props: [
    { prop: 'x', expr: "layer('Broken', 'x') * 2 + layer('Disabled', 'x') + layer('CycleA', 'x')" },
    { prop: 'y', expr: "layer('Follower', 'z') + layer('Follower', 'scaleY') + layer('#fol', 'rotationZ')" },
    { prop: 'z', expr: rep('[', '1,', 70000, "1].length + layer('Wide', 'x')") },
  ] },
  { id: 'wide', name: 'Wide', props: [{ prop: 'x', expr: rep('[', '1,', 70000, "1].length + layer('Wide2', 'x')") }] },
  { id: 'wide2', name: 'Wide2', props: [{ prop: 'x', kfs: [{ t: 0, value: 1 }], expr: rep('[', '1,', 70000, '1].length') }] },
  // Math.random across a cross-layer read: each expression draws from its OWN
  // seeded stream, and the caller's resumes where it left off.
  { id: 'rnd1', name: 'Rnd1', props: [{ prop: 'x', expr: "Math.random() + layer('Rnd2', 'x') + Math.random()" }, { prop: 'y', expr: 'Math.random()' }] },
  { id: 'rnd2', name: 'Rnd2', props: [{ prop: 'x', expr: 'Math.random() * 10 + random()' }] },
  // valueAtTime() without a time on a one-key track: a stated error, so the track value.
  { id: 'vat', name: 'Vat', props: [{ prop: 'x', kfs: [{ t: 1, value: 4 }], expr: 'valueAtTime() + 1' }, { prop: 'y', kfs: [{ t: 1, value: 4 }], expr: 'valueAtTime(time) + 1' }] },
];
for (let i = 0; i < 20; i++) {
  SCENE.push({ id: `ch${i}`, name: `Chain${i}`, props: [{ prop: 'x', kfs: [{ t: 0, value: i }], expr: i === 19 ? 'time * 3' : `layer('Chain${i + 1}', 'x') + 1` }] });
}
const BASE: Record<string, number> = { 'self:x': 99, 'err:y': 4 };

const engine = new AnimationEngine();
engine.setLayerResolver((name: string) => SCENE.find((n) => n.name === name)?.id ?? null);
engine.setBaseValueProvider((id: string, prop: string) => BASE[`${id}:${prop}`]);
for (const n of SCENE) {
  for (const p of n.props) {
    if (p.kfs) engine.setTrackKeyframes(n.id, p.prop, p.kfs);
    if (p.expr) {
      engine.setExpression(n.id, p.prop, expand(p.expr));
      if (p.enabled === false) engine.setExpressionEnabled(n.id, p.prop, false);
    }
  }
}
const eo: string[] = [
  '// GENERATED by native/tests/gen_golden_expr.ts — do not edit by hand.',
  `// Reference: Node ${process.version}, V8 ${process.versions.v8}.`,
  '//',
  '// #ifdef MOTION_GOLDEN_ENGINE_SCENE: statements filling `std::vector<ENode> scene` and `base`.',
  '// MOTION_ENGINE_SAMPLE(node, prop, time_bits, has_value, value_bits)   AnimationEngine.sample()',
  '',
  '#ifdef MOTION_GOLDEN_ENGINE_SCENE',
];
for (const n of SCENE) {
  eo.push(`  scene.push_back({${u16(n.id)}, ${u16(n.name)}, {${n.props.map((p) =>
    `{${u16(p.prop)}, {${(p.kfs ?? []).map(kfCpp).join(', ')}}, ${srcCpp(p.expr ?? '')}, ${p.expr ? 'true' : 'false'}, ${p.enabled === false ? 'false' : 'true'}}`).join(', ')}}});`);
}
for (const [k, v] of Object.entries(BASE)) eo.push(`  base[${u16(k)}] = ${num(v)};`);
eo.push('#else');
let engRows = 0;
for (const n of SCENE) {
  for (const p of n.props) {
    for (const t of [0, 0.3, 0.75, 1.6, 2.4]) {
      const v = engine.sample(n.id, p.prop, t);
      eo.push(`MOTION_ENGINE_SAMPLE(${u16(n.id)}, ${u16(p.prop)}, ${hex(t)}, ${v === undefined ? 0 : 1}, ${hex(v ?? 0)})`);
      engRows++;
    }
  }
}
eo.push('#endif', '');
writeFileSync(join(here, 'golden_expr_engine.inc'), eo.join('\n'));
console.log(`wrote golden_expr_engine.inc: ${engRows} engine samples`);
