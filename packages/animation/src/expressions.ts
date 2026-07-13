/**
 * Property expressions (spec §Expression Editor).
 *
 * An expression is a small JavaScript formula attached to a numeric property
 * that computes its value each frame from `time`, the property's own `value`,
 * and a curated motion API (wiggle, clamp, linear, random, Math). It compiles
 * once via `new Function` — safe here because it is the user's own formula on
 * their own machine (this mirrors After Effects' expression model).
 *
 * Compile errors and runtime errors are surfaced as plain-language messages
 * so the editor can highlight them inline. Everything stays editable — an
 * expression is text the user owns, never a locked result.
 */

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
}

export interface ExprResult {
  value: number | null;
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
  const ref = /(\w+) is not defined/.exec(msg);
  if (ref) return `Unknown name “${ref[1]}”. Try time, value, audio, wiggle, clamp, linear or Math.`;
  if (/is not a function/.test(msg)) return `That isn’t a function — check the name and parentheses.`;
  if (/Unexpected/.test(msg) || /missing/.test(msg)) return `Syntax error: ${msg}`;
  return msg;
}

const API_PARAMS = ['time', 'value', 'audio', 'ctrl', 'wiggle', 'clamp', 'linear', 'random', 'Math'] as const;

export function compileExpression(src: string): CompiledExpression {
  const trimmed = src.trim();
  if (trimmed === '') {
    return { src, compileError: null, run: () => ({ value: null, error: null }) };
  }

  let fn: ((...args: unknown[]) => unknown) | null = null;
  let compileError: string | null = null;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function(...API_PARAMS, `"use strict"; return (${trimmed});`) as (
      ...args: unknown[]
    ) => unknown;
  } catch (e) {
    compileError = humanize(e);
  }

  return {
    src,
    compileError,
    run: (ctx) => {
      if (compileError || !fn) return { value: null, error: compileError };
      const { time, value } = ctx;
      const audio = ctx.audio ?? 0;
      const ctrl = ctx.ctrl ?? ((): number => 0);
      const wiggle = (freq = 2, amp = 30): number =>
        value + (smoothNoise(time * freq) * 2 - 1) * amp;
      const clamp = (v: number, min: number, max: number): number =>
        Math.min(max, Math.max(min, v));
      const linear = (t: number, tMin: number, tMax: number, vMin: number, vMax: number): number => {
        if (tMax === tMin) return vMin;
        const k = Math.min(1, Math.max(0, (t - tMin) / (tMax - tMin)));
        return vMin + (vMax - vMin) * k;
      };
      const random = (seed = time): number => hash01(seed);
      try {
        const out = fn(time, value, audio, ctrl, wiggle, clamp, linear, random, Math);
        if (typeof out === 'number' && Number.isFinite(out)) return { value: out, error: null };
        return { value: null, error: 'Expression must return a number.' };
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

const API_NAMES = new Set(['time', 'value', 'audio', 'ctrl', 'wiggle', 'clamp', 'linear', 'random', 'Math']);

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
  { insert: 'wiggle(2, 30)', label: 'wiggle()', hint: 'smooth random motion' },
  { insert: 'Math.sin(time * 2) * 100', label: 'Math.sin()', hint: 'oscillate' },
  { insert: 'clamp(value, 0, 100)', label: 'clamp()', hint: 'limit range' },
  { insert: 'linear(time, 0, 1, 0, 100)', label: 'linear()', hint: 'remap time→value' },
];
