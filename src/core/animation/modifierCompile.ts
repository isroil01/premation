/**
 * MODIFIER STACK → ONE EXPRESSION.
 *
 * This file is the whole reason the stack needs no engine change. A stack is an
 * ordered list of typed, editable operations; the render path only knows about
 * expressions; so the stack is COMPILED to a single expression string and
 * attached to the property with `setExpression`. Sampling, export, the render
 * cache, undo, `convertExpressionToKeyframes` — none of them learn that
 * modifiers exist. That is the same call `spring.ts` makes when it bakes to
 * keyframes instead of adding a second motion evaluator, and for the same
 * reason: two evaluators is how preview and export drift apart.
 *
 * ## THE RUNNING VALUE
 *
 * Each modifier receives the text of the value produced so far — starting at
 * `value`, the property's own keyframed/base value — and returns text that
 * consumes it. Order is therefore literally nesting: `offset` then `multiply`
 * compiles to `((value + 10) * 2)`, the reverse to `((value * 2) + 10)`, and
 * the two differ exactly as a user dragging rows expects.
 *
 * ## THE ONE THING THE LANGUAGE CANNOT DO, AND HOW THIS HANDLES IT
 *
 * Half the interesting intrinsics — `wiggle`, `valueAtTime`, `loopOut`,
 * `velocityAtTime` — are defined against the property's BASE value, not against
 * whatever a preceding modifier computed. `wiggle(2, 30)` returns
 * `value + noise`; it has no way to be told "wiggle around THIS number
 * instead". A stack that wrote `wiggle(2, 30)` in the middle of a chain would
 * therefore silently DISCARD everything above it, which is the worst available
 * failure: the row is visibly there, its parameters visibly work, and the rows
 * above it stop mattering.
 *
 * So those kinds compile BASE-RELATIVE: the intrinsic's own displacement from
 * `value` is added to the running value.
 *
 *     running + (wiggle(2, 30) - value)
 *
 * When the modifier is first in the stack the running value IS `value` and the
 * form collapses to the plain intrinsic, which is emitted directly so the
 * common case reads exactly like hand-written AE. When it is not first, the
 * delta form is the only honest generalisation: `delay` shifts the chain by
 * however much the base moved over that interval, `loop` adds the loop's own
 * excursion on top of what came before.
 *
 * Pure text in, pure text out — no engine, no scene, no DOM. Same stack, same
 * string, always, which is what makes the compiled expression diffable and the
 * tests able to assert on it.
 */

import { compileExpression, tokenizeExpression } from '@motion/animation';
import type { Modifier } from './modifierStack';

/** The identifier the engine binds to the keyframed/base value. */
export const BASE_VALUE = 'value';

/**
 * Format a number for embedding in expression source.
 *
 * Rounded to 1e-6 so a float that arrived from a slider does not print
 * seventeen digits, and negatives are parenthesised so `a + -5` never appears —
 * the parser accepts it, but `(-5)` is what a person reading the compiled text
 * expects to see. Same helper, same reasons, as `audioDriver.ts`'s.
 */
export function num(v: number): string {
  const safe = Number.isFinite(v) ? v : 0;
  const s = String(Math.round(safe * 1e6) / 1e6);
  return safe < 0 ? `(${s})` : s;
}

/** A JS string literal for expression source. Single-quoted, like AE idiom. */
function str(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Replace the identifier `value` inside a user fragment with the running value.
 *
 * Token-level, not `String.replace`: the tokenizer the expression EDITOR
 * already uses classifies strings and member chains as single tokens, so
 * `'value'` (a string) and `thisProperty.value` (one word token) are left
 * alone, which a regex over the raw text cannot promise. Re-joining every
 * token's text — whitespace tokens included — reconstructs the source exactly
 * when nothing matches.
 *
 * A fragment that never mentions `value` REPLACES the running value rather than
 * wrapping it. That is not a bug to paper over: `time * 90` means "be this",
 * and silently adding it to whatever came before would invent an intent the
 * user did not express.
 */
export function substituteValue(src: string, running: string): string {
  if (running === BASE_VALUE) return src;
  let out = '';
  for (const tok of tokenizeExpression(src)) {
    out += tok.kind !== 'str' && tok.text === BASE_VALUE ? running : tok.text;
  }
  return out;
}

/**
 * The intrinsic form of a base-relative modifier — the expression it would be
 * if it were the only thing on the property.
 *
 * Every branch returns an ATOM (a call, or parenthesised), so the caller can
 * subtract `value` from it without adding brackets of its own.
 */
function baseRelativeForm(m: Modifier): string | null {
  switch (m.kind) {
    case 'wiggle': {
      // `wiggle(freq, amp, octaves, ampMult, t)`. The SEED is not a parameter
      // the engine exposes — it is `ctx.propSeed`, mixed in per (node, prop) by
      // the host — so a per-modifier seed is expressed as a PHASE OFFSET into
      // the same noise field via the time argument. That keeps the two
      // properties this file cares about: two wiggle rows on one property
      // decorrelate, and the result is identical on every run.
      const octaves = Math.max(1, Math.round(m.octaves));
      if (m.seed === 0 && octaves === 1) return `wiggle(${num(m.freq)}, ${num(m.amp)})`;
      if (m.seed === 0) return `wiggle(${num(m.freq)}, ${num(m.amp)}, ${num(octaves)})`;
      return `wiggle(${num(m.freq)}, ${num(m.amp)}, ${num(octaves)}, 0.5, time + ${num(m.seed)})`;
    }
    case 'smooth': {
      // A three-tap box filter over the property's own keyframed value. The
      // engine has no smoothing helper reachable from an expression (checked:
      // nothing in the bound scope averages neighbouring samples), so this is
      // the average the task specifies, written out.
      const w = num(Math.max(0, m.windowSec));
      return `((valueAtTime(time - ${w}) + value + valueAtTime(time + ${w})) / 3)`;
    }
    case 'spring': {
      // CLOSED FORM, from `packages/ai-tools/src/spring.ts`.
      //
      // That solver's under-damped branch is
      //   x(t) = e^(-ζωn·t) · (x0·cos(ωd·t) + ((v0 + ζωn·x0)/ωd)·sin(ωd·t))
      // measured from the target. A property that has just finished its
      // keyframes is AT the target, so x0 = 0 and the whole thing collapses to
      //   x(t) = (v0/ωd) · e^(-ζωn·t) · sin(ωd·t)
      // — one term, driven entirely by the velocity it arrived with. `decay`
      // is ζωn and `frequency` is ωd/2π, so the two parameters are exactly the
      // two the solver needs and nothing is approximated except x0 = 0.
      //
      // `v0` is read one millisecond BEFORE the last keyframe, matching the
      // `loopOut('continue')` trick in expressions.ts: at the key itself a
      // hold-clamped `selfAt` has zero finite-difference velocity, so sampling
      // on the key would produce no overshoot at all.
      const omega = Math.max(1e-3, m.frequency * 2 * Math.PI);
      const t0 = 'key(numKeys).time';
      const drive = `velocityAtTime(${t0} - 0.001)`;
      const dt = `(time - ${t0})`;
      return (
        `(time <= ${t0} ? value : value + ${drive} / ${num(omega)}` +
        ` * Math.sin(${dt} * ${num(omega)}) * Math.exp(-${dt} * ${num(m.decay)}))`
      );
    }
    case 'loop':
      return `loopOut(${str(m.mode)})`;
    case 'delay':
      return `valueAtTime(time - ${num(m.seconds)})`;
    default:
      return null;
  }
}

/** Compile ONE modifier against the running value's text. */
export function compileModifier(m: Modifier, running: string): string {
  const relative = baseRelativeForm(m);
  if (relative !== null) {
    // First in the stack: the delta form is algebraically the intrinsic, so
    // emit the intrinsic and keep the text readable.
    return running === BASE_VALUE ? relative : `(${running} + (${relative} - ${BASE_VALUE}))`;
  }

  switch (m.kind) {
    case 'offset':
      return `(${running} + ${num(m.amount)})`;
    case 'multiply':
      return `(${running} * ${num(m.factor)})`;
    case 'clamp':
      return `clamp(${running}, ${num(m.min)}, ${num(m.max)})`;
    case 'audio':
      // `audio` is 0..1 broadband; `linear` with five arguments IS the remap
      // into [min, max], so the range the user typed appears verbatim in the
      // compiled text instead of being pre-multiplied into a magic constant.
      return `(${running} + linear(clamp(audio, 0, 1), 0, 1, ${num(m.min)}, ${num(m.max)}))`;
    case 'oscillate': {
      const omega = m.freq * 2 * Math.PI;
      const phase = m.phase === 0 ? '' : ` + ${num(m.phase)}`;
      return `(${running} + Math.sin(time * ${num(omega)}${phase}) * ${num(m.amp)})`;
    }
    case 'expression': {
      const body = m.src.trim();
      if (body === '') return running;
      return `(${substituteValue(body, running)})`;
    }
    default:
      return running;
  }
}

/**
 * Compile a whole stack. Disabled rows are SKIPPED, not compiled-and-ignored —
 * an unevaluated row costs nothing per frame and cannot raise an error from a
 * formula nobody switched on.
 *
 * An empty (or entirely disabled) stack compiles to `value`, the identity. Not
 * to the empty string: `setExpression('')` REMOVES the expression, and a stack
 * whose last row was toggled off would then delete the expression it is
 * supposed to own and take the stored `previous` restore path with it.
 */
export function compileModifierStack(modifiers: readonly Modifier[]): string {
  let running = BASE_VALUE;
  for (const m of modifiers) {
    if (!m.enabled) continue;
    running = compileModifier(m, running);
  }
  return running;
}

/**
 * The compile error the ENGINE would report for this stack, or null.
 *
 * Uses the real `compileExpression`, not a private validator — a second
 * grammar would agree with the parser on everything except the cases that
 * matter. The only way a built-in kind reaches this is a user's raw
 * `expression` fragment, which is exactly what it is for.
 */
export function modifierCompileError(modifiers: readonly Modifier[]): string | null {
  return compileExpression(compileModifierStack(modifiers)).compileError;
}

/**
 * Why a modifier will not do quite what its parameters say, or null.
 *
 * SHOWN next to the row rather than thrown: "it quietly did something else" is
 * the version of this feature that generates support questions. Same call
 * `expressionBlocker` makes in `audioDriver.ts`, and for the same identifier.
 */
export function modifierWarning(m: Modifier): string | null {
  if (m.kind === 'audio' && m.band !== 'full') {
    return 'the `audio` identifier is broadband — a frequency band needs the baked FFT, so use the Audio Driver section for that';
  }
  if (m.kind === 'wiggle' && m.octaves > 8) {
    return 'the engine caps wiggle at 8 octaves';
  }
  if (m.kind === 'spring' && m.frequency <= 0) {
    return 'a spring needs a frequency above zero to oscillate';
  }
  return null;
}
