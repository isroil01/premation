/**
 * Property expressions.
 *
 * An expression is a small JavaScript formula attached to a numeric property
 * that computes its value each frame from `time`, the property's own `value`,
 * and a curated motion API (wiggle, clamp, linear, random, Math).
 *
 * It is PARSED AND INTERPRETED, not eval'd — see `exprLang.ts` for why. The
 * short version: `new Function` is refused by the app's CSP, so expressions
 * were silently dead in the real renderer; and relaxing the CSP would let any
 * shared project run arbitrary code in a renderer holding the user's auth
 * token. The interpreter can only reach the names bound in `run` below.
 *
 * Compile errors and runtime errors are surfaced as plain-language messages
 * so the editor can highlight them inline. Everything stays editable — an
 * expression is text the user owns, never a locked result.
 */

import { parseExpression, evaluateExpression, type ExprNode } from './exprLang';

/** Loop mode for `loopOut`/`loopIn` (AE semantics). Unknown modes fall back
 *  to `'cycle'` so a typo degrades gracefully instead of erroring. */
export type LoopMode = 'cycle' | 'pingpong' | 'offset';

export interface ExprContext {
  /** Playhead time in seconds. */
  time: number;
  /** The value the property would have from its keyframes/base. */
  value: number;
  /** Audio amplitude at the playhead, 0..1 (0 when no audio / provider). Lets
   *  expressions be audio-reactive, e.g. `value + audio * 200`. */
  audio?: number;
  /** Named slider-control lookup: `ctrl('Speed')` reads a user rig control
   *  anywhere in the scene (0 when absent / no provider). */
  ctrl?: (name: string) => number;
  /** Samples the CURRENT property's KEYFRAMED value at an arbitrary time —
   *  keyframes only, never the expression-adjusted value (so `valueAtTime`
   *  cannot recurse through the expression itself). Backs `valueAtTime` and
   *  the `loopOut`/`loopIn` remapping. Default: ` => value`. */
  selfAt?: (t: number) => number;
  /** First→last keyframe span of the current property's own track, or null
   *  when it has fewer than one keyframe. Backs `loopOut`/`loopIn`. */
  selfSpan?: { start: number; end: number } | null;
  /** Cross-layer read: another layer's value at time `t`.
   *  Capped at depth limit with cycle detection to prevent infinite loops. */
  layerAt?: (name: string, prop: string, t: number) => number | undefined;
  /** Comp info for `thisComp`. */
  comp?: {
    width: number;
    height: number;
    duration: number;
    fps: number;
    numLayers: number;
  };
  /** Layer info for `thisLayer`. */
  layerInfo?: {
    name: string;
    width: number;
    height: number;
  };
  /** Deterministic per-(node, prop) seed mixed into `wiggle`'s noise phase so
   *  x and y wiggle INDEPENDENTLY (AE behaviour) instead of diagonally in
   *  lock-step. Still reproducible: same node+prop ⇒ same motion every run. */
  propSeed?: number;
}

export interface ExprResult {
  /** A finite number, or a small vector (AE-style `[x, y]` returns — the
   *  engine picks the component matching the track: x→0, y→1, z→2). */
  value: number | number[] | null;
  error: string | null;
}

export interface CompiledExpression {
  src: string;
  compileError: string | null;
  run: (ctx: ExprContext) => ExprResult;
}

/** Deterministic hash → 0..1 (no Math.random, so playback is reproducible). */
function hash01(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 1-D value noise in 0..1. */
function smoothNoise(x: number): number {
  const xi = Math.floor(x);
  const xf = x - xi;
  const a = hash01(xi);
  const b = hash01(xi + 1);
  const u = xf * xf * (3 - 2 * xf);
  return a + (b - a) * u;
}

/** Turn a thrown error into a short, human-readable explanation. */
function humanize(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Cycle detected/i.test(msg) || /Maximum cross-layer evaluation depth/i.test(msg)) return msg;
  const ref = /(\w+) is not defined/.exec(msg);
  if (ref) return `Unknown name “${ref[1]}”. Try time, value, audio, wiggle, layer, loopOut, valueAtTime, clamp, linear, ease, thisComp or Math.`;
  if (/is not a function/.test(msg)) return `That isn’t a function — check the name and parentheses.`;
  if (/Unexpected/.test(msg) || /missing/.test(msg)) return `Syntax error: ${msg}`;
  return msg;
}

/**
 * The complete set of names an expression can see. Was the parameter list for
 * `new Function`; now the contract for the scope built in `run` (and the source
 * of truth for the "Unknown name" hint below and API_NAMES highlighting).
 */
export const API_PARAMS = [
  'time', 'value', 'audio', 'ctrl', 'wiggle', 'clamp', 'linear', 'ease', 'easeIn', 'easeOut',
  'timeToFrames', 'framesToTime', 'random', 'Math', 'valueAtTime', 'velocity', 'speed',
  'velocityAtTime', 'layer', 'layerAt', 'loopOut', 'loopIn', 'thisComp', 'thisLayer', 'thisProperty',
] as const;

function resolveRange(t: number, a: number, b: number, c?: number, d?: number): { k: number; vMin: number; vMax: number } {
  let tMin: number, tMax: number, vMin: number, vMax: number;
  if (c !== undefined && d !== undefined) {
    tMin = a; tMax = b; vMin = c; vMax = d;
  } else {
    tMin = 0; tMax = 1; vMin = a; vMax = b;
  }
  if (tMax === tMin) return { k: 0, vMin, vMax };
  const k = Math.min(1, Math.max(0, (t - tMin) / (tMax - tMin)));
  return { k, vMin, vMax };
}

export function compileExpression(src: string): CompiledExpression {
  const trimmed = src.trim();
  if (trimmed === '') {
    return { src, compileError: null, run: () => ({ value: null, error: null }) };
  }

  // Parsed, not eval'd. `new Function` is refused by the app's CSP
  // (script-src 'self'), which made every expression silently evaluate to null
  // in the real renderer while jsdom-based tests passed. See exprLang.ts.
  let ast: ExprNode | null = null;
  let compileError: string | null = null;
  try {
    ast = parseExpression(trimmed);
  } catch (e) {
    compileError = humanize(e);
  }

  return {
    src,
    compileError,
    run: (ctx) => {
      if (compileError || !ast) return { value: null, error: compileError };
      const { time, value } = ctx;
      const audio = ctx.audio ?? 0;
      const ctrl = ctx.ctrl ?? ((): number => 0);
      const wiggleSeed = ctx.propSeed ?? 0;
      const wiggle = (freq = 2, amp = 30, octaves = 1, ampMult = 0.5, tt = time): number => {
        let total = 0;
        let f = freq;
        let a = amp;
        let maxA = 0;
        const n = Math.max(1, Math.floor(octaves));
        for (let i = 0; i < n; i++) {
          total += (smoothNoise(tt * f + wiggleSeed) * 2 - 1) * a;
          maxA += a;
          f *= 2;
          a *= ampMult;
        }
        return value + (maxA > 0 ? (total / maxA) * amp : 0);
      };
      const clamp = (v: number, min: number, max: number): number =>
        Math.min(max, Math.max(min, v));
      const linear = (t: number, a: number, b: number, c?: number, d?: number): number => {
        const { k, vMin, vMax } = resolveRange(t, a, b, c, d);
        return vMin + (vMax - vMin) * k;
      };
      const ease = (t: number, a: number, b: number, c?: number, d?: number): number => {
        const { k, vMin, vMax } = resolveRange(t, a, b, c, d);
        const u = k * k * (3 - 2 * k); // smoothstep
        return vMin + (vMax - vMin) * u;
      };
      const easeIn = (t: number, a: number, b: number, c?: number, d?: number): number => {
        const { k, vMin, vMax } = resolveRange(t, a, b, c, d);
        const u = k * k; // quadratic ease in
        return vMin + (vMax - vMin) * u;
      };
      const easeOut = (t: number, a: number, b: number, c?: number, d?: number): number => {
        const { k, vMin, vMax } = resolveRange(t, a, b, c, d);
        const u = k * (2 - k); // quadratic ease out
        return vMin + (vMax - vMin) * u;
      };
      const compInfo = ctx.comp ?? { width: 1920, height: 1080, duration: 10, fps: 60, numLayers: 1 };
      const timeToFrames = (t = time, fps = compInfo.fps): number => Math.round(t * fps);
      const framesToTime = (f: number, fps = compInfo.fps): number => f / fps;
      const random = (seed = time): number => hash01(seed);

      const selfAt = ctx.selfAt ?? ((): number => value);
      const valueAtTime = (t: number): number => selfAt(t);
      const velocityAtTime = (t: number): number => {
        const dt = 0.001;
        const v1 = selfAt(t - dt);
        const v2 = selfAt(t + dt);
        return (v2 - v1) / (2 * dt);
      };
      const velocity = velocityAtTime(time);
      const speed = Math.abs(velocity);
      const layerAt = (name: string, prop: string, t: number): number => {
        const res = ctx.layerAt?.(name, prop, t);
        if (typeof res === 'number') return res;
        return 0;
      };
      const layer = (name: string, prop: string): number => layerAt(name, prop, time);

      const span = ctx.selfSpan ?? null;
      const loopOut = (mode: LoopMode | string = 'cycle'): number => {
        if (!span || span.end <= span.start || time <= span.end) return value;
        const { start, end } = span;
        const dur = end - start;
        const rel = time - start;
        if (mode === 'pingpong') {
          let ph = rel % (2 * dur);
          if (ph > dur) ph = 2 * dur - ph;
          return selfAt(start + ph);
        }
        if (mode === 'offset') {
          const n = Math.floor(rel / dur);
          const delta = selfAt(end) - selfAt(start);
          return selfAt(start + (rel - n * dur)) + n * delta;
        }
        return selfAt(start + (rel % dur));
      };
      const loopIn = (mode: LoopMode | string = 'cycle'): number => {
        if (!span || span.end <= span.start || time >= span.start) return value;
        const { start, end } = span;
        const dur = end - start;
        const rel = time - start;
        if (mode === 'pingpong') {
          let ph = ((rel % (2 * dur)) + 2 * dur) % (2 * dur);
          if (ph > dur) ph = 2 * dur - ph;
          return selfAt(start + ph);
        }
        if (mode === 'offset') {
          const n = Math.floor(rel / dur);
          const delta = selfAt(end) - selfAt(start);
          return selfAt(start + (rel - n * dur)) + n * delta;
        }
        return selfAt(start + (((rel % dur) + dur) % dur));
      };

      const thisComp = {
        width: compInfo.width,
        height: compInfo.height,
        duration: compInfo.duration,
        frameDuration: 1 / Math.max(1, compInfo.fps),
        fps: compInfo.fps,
        numLayers: compInfo.numLayers,
        layer: (name: string, prop?: string) => prop ? layer(name, prop) : {
          width: compInfo.width,
          height: compInfo.height,
          name,
        },
      };
      const thisLayer = ctx.layerInfo ?? {
        name: 'Layer',
        width: compInfo.width,
        height: compInfo.height,
      };
      const thisProperty = {
        value,
        valueAtTime,
        velocity,
        speed,
        velocityAtTime,
        loopOut,
        loopIn,
      };

      // The evaluator can only see these names — there is no `window`, no
      // `fetch`, no prototype chain to climb. Keep in sync with API_PARAMS
      // (the tokenizer's API_NAMES drives editor highlighting off the same set).
      const scope = new Map<string, unknown>([
        ['time', time], ['value', value], ['audio', audio], ['ctrl', ctrl],
        ['wiggle', wiggle], ['clamp', clamp], ['linear', linear],
        ['ease', ease], ['easeIn', easeIn], ['easeOut', easeOut],
        ['timeToFrames', timeToFrames], ['framesToTime', framesToTime],
        ['random', random], ['Math', Math],
        ['valueAtTime', valueAtTime], ['velocity', velocity], ['speed', speed],
        ['velocityAtTime', velocityAtTime],
        ['layer', layer], ['layerAt', layerAt],
        ['loopOut', loopOut], ['loopIn', loopIn],
        ['thisComp', thisComp], ['thisLayer', thisLayer], ['thisProperty', thisProperty],
      ]);

      try {
        const out = evaluateExpression(ast, scope);
        if (typeof out === 'number' && Number.isFinite(out)) return { value: out, error: null };
        // AE-style vector returns: `[x, y]` (or [x,y,z]/[x,y,z,w]). The engine
        // selects the component matching the decomposed track (x→0, y→1, z→2),
        // so one expression drives Position instead of erroring out.
        if (
          Array.isArray(out) && out.length >= 1 && out.length <= 4 &&
          out.every((v) => typeof v === 'number' && Number.isFinite(v))
        ) {
          return { value: out as number[], error: null };
        }
        return { value: null, error: 'Expression must return a number (or a [x, y] array).' };
      } catch (e) {
        return { value: null, error: humanize(e) };
      }
    },
  };
}

/**
 * AI-assist: map a natural-language intent to a starting expression the user
 * can then edit. This is a small local heuristic (not a hosted model), but it
 * honors the spec rule: the result is always editable text, never locked.
 */
export function suggestExpression(intent: string): string {
  const s = intent.toLowerCase();
  if (/wiggle|shake|jitter|random|noise/.test(s)) return 'wiggle(2, 30)';
  if (/spin|rotate|rotation/.test(s)) return 'time * 90';
  if (/oscillate|sine|sin|wave|pulse|bounce/.test(s)) return 'value + Math.sin(time * 3) * 40';
  if (/fade|ramp|grow|rise/.test(s)) return 'linear(time, 0, 2, 0, 100)';
  if (/clamp|limit|cap/.test(s)) return 'clamp(value, 0, 100)';
  if (/loop|repeat|cycle/.test(s)) return 'value + Math.sin(time * 6.283) * 50';
  return 'value';
}

// ── Syntax tokenizing (for the editor's highlighting + bracket matching) ──

export type TokenKind = 'num' | 'str' | 'api' | 'ident' | 'op' | 'paren' | 'ws';
export interface SyntaxToken {
  text: string;
  kind: TokenKind;
  /** Char offset of this token's start in the source. */
  start: number;
}

const API_NAMES = new Set([
  'time', 'value', 'audio', 'ctrl', 'wiggle', 'clamp', 'linear', 'random', 'Math',
  'valueAtTime', 'layer', 'layerAt', 'loopOut', 'loopIn', 'ease', 'easeIn', 'easeOut',
  'timeToFrames', 'framesToTime', 'thisComp', 'thisLayer', 'thisProperty', 'velocity', 'speed', 'velocityAtTime',
]);

/** Split an expression into colored syntax tokens. Never throws. */
export function tokenizeExpression(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let i = 0;
  const push = (text: string, kind: TokenKind): void => { out.push({ text, kind, start: i }); i += text.length; };
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { let j = i; while (j < src.length && /\s/.test(src[j]!)) j++; push(src.slice(i, j), 'ws'); continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j++;
      push(src.slice(i, Math.min(src.length, j + 1)), 'str');
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i; let dot = false;
      while (j < src.length && ((src[j]! >= '0' && src[j]! <= '9') || (src[j] === '.' && !dot))) { if (src[j] === '.') dot = true; j++; }
      push(src.slice(i, j), 'num');
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < src.length && /[A-Za-z0-9_$.]/.test(src[j]!)) j++;
      const word = src.slice(i, j);
      push(word, API_NAMES.has(word.split('.')[0]!) ? 'api' : 'ident');
      continue;
    }
    if (c === '(' || c === ')' || c === '[' || c === ']') { push(c, 'paren'); continue; }
    push(c, 'op');
  }
  return out;
}

/**
 * Given a caret position, find the indices of the bracket under/next to it and
 * its match (`[open, close]`), or null. Used to highlight matching brackets.
 */
export function matchBracket(src: string, caret: number): [number, number] | null {
  const pairs: Record<string, string> = { '(': ')', '[': ']' };
  const closers: Record<string, string> = { ')': '(', ']': '[' };
  const tryAt = (pos: number): [number, number] | null => {
    const ch = src[pos];
    if (ch && pairs[ch]) {
      let depth = 0;
      for (let k = pos; k < src.length; k++) {
        if (src[k] === ch) depth++;
        else if (src[k] === pairs[ch]) { depth--; if (depth === 0) return [pos, k]; }
      }
    }
    if (ch && closers[ch]) {
      let depth = 0;
      for (let k = pos; k >= 0; k--) {
        if (src[k] === ch) depth++;
        else if (src[k] === closers[ch]) { depth--; if (depth === 0) return [k, pos]; }
      }
    }
    return null;
  };
  return tryAt(caret) ?? tryAt(caret - 1);
}

/** API tokens offered for autocomplete / quick-insert in the editor. */
export const EXPRESSION_API: { insert: string; label: string; hint: string }[] = [
  { insert: 'time', label: 'time', hint: 'playhead seconds' },
  { insert: 'value', label: 'value', hint: 'the keyframed value' },
  { insert: 'velocity', label: 'velocity', hint: 'rate of change per second' },
  { insert: 'speed', label: 'speed', hint: 'magnitude of rate of change' },
  { insert: 'velocityAtTime(time - 0.1)', label: 'velocityAtTime()', hint: 'rate of change at specified time' },
  { insert: 'wiggle(2, 30)', label: 'wiggle()', hint: 'smooth random motion' },
  { insert: 'Math.sin(time * 2) * 100', label: 'Math.sin()', hint: 'oscillate' },
  { insert: 'clamp(value, 0, 100)', label: 'clamp()', hint: 'limit range' },
  { insert: 'linear(time, 0, 1, 0, 100)', label: 'linear()', hint: 'remap time→value' },
  { insert: 'ease(time, 0, 1, 0, 100)', label: 'ease()', hint: 'smooth S-curve interpolation' },
  { insert: 'easeIn(time, 0, 1, 0, 100)', label: 'easeIn()', hint: 'smooth start interpolation' },
  { insert: 'easeOut(time, 0, 1, 0, 100)', label: 'easeOut()', hint: 'smooth end interpolation' },
  { insert: 'timeToFrames(time)', label: 'timeToFrames()', hint: 'convert seconds to frame number' },
  { insert: 'thisComp.width', label: 'thisComp', hint: 'composition properties and layer access' },
  { insert: 'thisLayer.name', label: 'thisLayer', hint: 'current layer properties' },
  { insert: 'thisProperty.valueAtTime(time - 0.5)', label: 'thisProperty', hint: 'current property accessors' },
  { insert: 'valueAtTime(time - 0.5)', label: 'valueAtTime()', hint: 'own keyframed value at any time' },
  { insert: "layer('Layer 1', 'x')", label: 'layer()', hint: "another layer's value (keyframed/base)" },
  { insert: "layerAt('Layer 1', 'x', time - 0.5)", label: 'layerAt()', hint: "another layer's value at a time" },
  { insert: "loopOut('cycle')", label: 'loopOut()', hint: 'repeat keyframes after the last (cycle · pingpong · offset)' },
  { insert: "loopIn('cycle')", label: 'loopIn()', hint: 'repeat keyframes before the first (cycle · pingpong · offset)' },
];
