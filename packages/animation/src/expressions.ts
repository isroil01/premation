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

/**
 * Ceiling on `wiggle`'s octave count.
 *
 * The one loop in this file whose iteration count is chosen by expression
 * source rather than by the document. See the note at the call site.
 */
export const MAX_WIGGLE_OCTAVES = 8;

/** Loop mode for `loopOut`/`loopIn` (AE semantics). Unknown modes fall back
 *  to `'cycle'` so a typo degrades gracefully instead of erroring. */
export type LoopMode = 'cycle' | 'pingpong' | 'offset' | 'continue';

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
  /**
   * The layer's CONTENT bounds at time `t`, in layer space — backs
   * `sourceRectAtTime`.
   *
   * `t` is a real parameter, not decoration: a text layer's bounds change when
   * its size, tracking or source text animate, and an auto-sizing plate reading
   * the bounds at the wrong time lags its subject by a frame. The provider is
   * expected to evaluate the node's props at `t` before measuring.
   *
   * `extents` asks for the looser box. For text that is the FONT box (stable
   * per font and line count) rather than the glyph INK box (tight, changes as
   * you type) — see the note on `sourceRectAtTime` in `run` for why that is the
   * closest honest mapping of AE's flag rather than an exact one.
   */
  sourceRectAt?: (t: number, extents: boolean) => SourceRect | undefined;
  /** The current property's own keyframe times, ascending — backs `numKeys`,
   *  `key(n)` and `nearestKey()`. Empty when the property has no track. */
  keyTimes?: ReadonlyArray<number>;
  /**
   * The layer's LAYER-LOCAL → COMPOSITION placement at time `t` — backs
   * `toComp` / `toWorld` / `fromComp` / `fromWorld`.
   *
   * `name` is null for the current layer, or another layer's name, matching
   * how `layerAt` addresses layers. Undefined when there is no provider or no
   * such layer, which the host turns into a STATED error rather than a silent
   * identity: a coordinate conversion that quietly returns its input is
   * indistinguishable from one that worked.
   */
  spaceAt?: (name: string | null, t: number) => LayerSpace | undefined;
  /**
   * Markers for one scope, ascending by time — backs `marker.*`.
   *
   * `'layer'` means the CURRENT layer's markers, already converted to comp
   * seconds by the host. `'comp'` means the composition's. Absent or empty
   * yields `numKeys === 0`, which every accessor handles, so an unwired
   * provider degrades to "no markers" rather than throwing — the opposite call
   * from `spaceAt`, and for a different reason: no markers is a perfectly
   * ordinary state that an expression must survive, whereas no coordinate
   * conversion is not.
   *
   * Order is not required of the host; see {@link ExprMarker}.
   */
  markersAt?: (scope: 'comp' | 'layer') => readonly ExprMarkerData[];
}

/**
 * A layer's placement, as the coordinate-space functions need it.
 *
 * ── Why this is FUNCTIONS and not a matrix ─────────────────────────────
 *
 * A 2×3 affine would cover 2D layers and nothing else. A 3D layer's
 * layer→comp conversion passes through the camera, which is a perspective
 * DIVIDE, and its comp→layer conversion is a ray/plane intersection. Neither is
 * a matrix, so a matrix contract would have forced the host to reimplement the
 * app's projection — a second copy of "where does this point land", kept in
 * step by attention. That is the §2·0 shape this codebase keeps paying for.
 *
 * So the arithmetic stays where the matrices already live (the app installs the
 * provider over the SAME `parentWorld3d` / `worldMatrixOf` the renderer uses)
 * and this package only marshals arguments and reports errors.
 */
export interface LayerSpace {
  /** Layer-local (x, y) → composition (x, y). */
  toComp(p: readonly [number, number]): [number, number];
  /** Composition (x, y) → layer-local (x, y). */
  fromComp(p: readonly [number, number]): [number, number];
  /**
   * Layer-local (x, y) → WORLD (x, y, z).
   *
   * For a 2D layer the composition is the world plane, so this returns the same
   * x/y as `toComp` with z = 0 — as in AE. They stay separate functions rather
   * than one aliased to the other, because for a 3D layer they genuinely differ:
   * world is before the camera, comp is after it.
   */
  toWorld(p: readonly [number, number]): [number, number, number];
  /** WORLD (x, y, z) → layer-local (x, y). */
  fromWorld(p: readonly [number, number, number]): [number, number];
}

/** AE's `sourceRectAtTime` return shape. */
export interface SourceRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * One marker, as an expression sees it — backs `marker.key(n)`.
 *
 * `time` is COMPOSITION seconds for both scopes, including layer markers,
 * which the model stores layer-relative. That conversion is deliberate and it
 * is the whole reason this type exists rather than passing `MarkerData`
 * through: the overwhelmingly common expression is
 * `marker.nearestKey(time).time`, and `time` in an expression is comp seconds.
 * Handing back a layer-relative number there would compare two different
 * clocks and be wrong by the layer's start offset — correct-looking on any
 * layer starting at 0, which is most of them while you are testing.
 *
 * `duration` is NOT converted, because it is a length rather than an instant.
 */
export interface ExprMarkerData {
  /** Composition seconds. */
  time: number;
  /** Span length in seconds; 0 for a point marker. */
  duration: number;
  /** The marker's label. */
  name: string;
  /** The marker's note — AE's `.comment`. */
  comment: string;
}

/**
 * A marker with its AE index. `index` is assigned HERE, by position after
 * sorting, rather than supplied by the host — so the 1-based numbering that
 * `key(n)` depends on has exactly one author. A host that returned markers in
 * insertion order (which `MarkerList` does) would otherwise make `key(1)` mean
 * "the first one added" in one scope and "the earliest" in another.
 */
export interface ExprMarker extends ExprMarkerData {
  /** 1-based, matching AE's `key(n)` numbering. 0 when there are no markers. */
  index: number;
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

// `API_PARAMS` lived here: a fourth hand-written list of the same names, left
// over from when this API was compiled with `new Function` and the array was
// its parameter list. It had NO consumers anywhere in src/ or packages/ — the
// tokenizer reads its own set, and the "Unknown name" hint below hardcodes its
// suggestions — so it was a stale description of the scope that nothing could
// notice going wrong. Deleted rather than updated, per the no-dual-shape rule.

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

/** Filled on the first `run`; see {@link boundScopeNames}. */
let boundNames: string[] = [];

/**
 * The names `run` actually binds — for the §2·0 discoverability guard.
 *
 * This is a REFLECTION of the scope Map, not a fourth list to keep in step.
 * The guard it exists for previously probed a hand-written array of names,
 * which meant the scope→table direction only covered names someone had
 * remembered to add to it: a function bound in scope and missing from the
 * autocomplete table worked perfectly, was undiscoverable, and failed nothing.
 * Enumerating the Map itself is what makes that assertion complete.
 *
 * Empty until the first expression is evaluated, because the Map is built
 * inside `run` where its closures live.
 */
export function boundScopeNames(): readonly string[] {
  return boundNames;
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
        // CLAMPED AT BOTH ENDS. This loop count comes straight out of expression
        // source, and expression source is written by plugins and persists in
        // saved documents — so `wiggle(2, 30, 1e9)` was a billion iterations on
        // the main thread, per property, per frame, arriving on the machine of
        // whoever opened the project. Nothing downstream could catch it: the
        // worker heartbeat supervises plugin workers, and this runs in the
        // renderer.
        //
        // 8 is not arbitrary. Amplitude is multiplied by `ampMult` (0.5 by
        // default) every octave, so the eighth contributes 1/256 of the first;
        // past that the loop buys nothing a viewer could see.
        const n = Math.min(MAX_WIGGLE_OCTAVES, Math.max(1, Math.floor(octaves) || 1));
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
      /**
       * AE's randomness model, which is a SEQUENCE and not a pure function.
       *
       * `random()` with no argument must return a different value on each call
       * within one evaluation — `[random(), random()]` is meant to be a random
       * point, not the same number twice. But it must also be identical on
       * every re-evaluation of the same frame, or scrubbing would shimmer and
       * export would not match preview.
       *
       * Both hold by making the sequence a pure function of (seed, call index):
       * the counter resets per evaluation, so call N of frame F always gets the
       * same value. `seedRandom(s)` re-bases it; AE's `timeless` second
       * argument is honoured by simply not mixing time in, which is what this
       * already does — the seed is the only input.
       *
       * The previous `random(seed = time)` was a pure hash of the time, so
       * every call in a frame returned the SAME number. That is not AE's
       * behaviour and quietly broke the commonest use.
       */
      let randomSeed = ctx.propSeed ?? 0;
      let randomCounter = 0;
      const seedRandom = (seed: number, _timeless = false): number => {
        randomSeed = seed;
        randomCounter = 0;
        return 0; // AE returns undefined; 0 keeps the expression numeric.
      };
      const nextRandom = (): number => hash01(randomSeed * 1013.7 + (randomCounter += 1) * 71.3);
      /** `random()` → 0..1 · `random(max)` → 0..max · `random(min, max)`. */
      const random = (a?: number, b?: number): number => {
        const u = nextRandom();
        if (a === undefined) return u;
        if (b === undefined) return u * a;
        return a + u * (b - a);
      };
      /**
       * Gaussian random, mean 0 and standard deviation 1 — Box–Muller over two
       * draws from the same sequence.
       *
       * Worth having distinct from `random`: a uniform jitter looks mechanical
       * because extreme values are exactly as likely as central ones, which is
       * why AE rigs reach for this for natural-looking variation.
       */
      const gaussRandom = (): number => {
        const u1 = Math.max(1e-9, nextRandom());
        const u2 = nextRandom();
        return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      };
      /**
       * Coherent noise, −1..1 — smooth in its argument, unlike `random`.
       *
       * The distinction that matters: nearby inputs give nearby outputs, so
       * `noise(time)` drifts where `random()` jitters. That is the whole reason
       * both exist.
       */
      const noise = (x: number, y = 0): number => (smoothNoise(x * 1.7 + y * 31.4) - 0.5) * 2;

      /**
       * `sourceRectAtTime(t, includeExtents)` — the layer's content bounds.
       *
       * The single most-reached-for expression in AE, because an auto-sizing
       * background behind text is impossible without it, and the reason it is
       * worth the provider plumbing the rest of this API does not need.
       *
       * ── One honest divergence from AE ───────────────────────────────────
       *
       * AE's `includeExtents` adds the box-text extents (and, for shapes, the
       * stroke). Here it selects the FONT box instead of the glyph INK box.
       * They are not the same flag, but they are the same *choice*: tight to
       * the pixels drawn, or loose and stable while the text changes. The tight
       * box is the default because that is what a plate behind text wants; the
       * loose one stops the plate twitching as the caret moves, which is what
       * people actually reach for `includeExtents` to fix.
       *
       * Returns a plain object, so `sourceRectAtTime().width` reads naturally.
       * Falls back to the layer box when there is no provider — never
       * undefined, because a missing rect in the middle of an arithmetic
       * expression surfaces as a confusing NaN rather than a useful error.
       */
      const sourceRectAtTime = (t = time, includeExtents = false): SourceRect =>
        ctx.sourceRectAt?.(t, includeExtents)
        ?? {
          top: 0,
          left: 0,
          width: ctx.layerInfo?.width ?? compInfo.width,
          height: ctx.layerInfo?.height ?? compInfo.height,
        };

      // ── Coordinate spaces ──────────────────────────────────────────
      //
      // `toComp` / `toWorld` / `fromComp` / `fromWorld`, AE's four. What they
      // are FOR is attaching one thing to a point on another: the corner of a
      // rotated, scaled, PARENTED layer, expressed in composition coordinates.
      // That is exactly the case a naive implementation gets wrong, because
      // adding the layer's position to the point is right only while the layer
      // is unrotated, unscaled and unparented.
      //
      // The conversion itself comes from a PROVIDER (`ctx.spaceAt`) rather than
      // being rebuilt here — see `LayerSpace` for why it is functions and not a
      // matrix. This block only marshals arguments and reports failures.
      const asPoint2 = (p: unknown, fn: string): [number, number] => {
        if (Array.isArray(p) && p.length >= 2 &&
            typeof p[0] === 'number' && typeof p[1] === 'number' &&
            Number.isFinite(p[0]) && Number.isFinite(p[1])) {
          return [p[0], p[1]];
        }
        throw new Error(`${fn}() needs a point, e.g. ${fn}([0, 0]).`);
      };
      /** A world point. `[x, y]` is accepted with z = 0, as AE does. */
      const asPoint3 = (p: unknown, fn: string): [number, number, number] => {
        const [x, y] = asPoint2(p, fn);
        const z = Array.isArray(p) && typeof p[2] === 'number' && Number.isFinite(p[2]) ? p[2] : 0;
        return [x, y, z];
      };

      /**
       * The layer's placement, or a STATED error.
       *
       * Never a silent identity: a coordinate conversion that returns its input
       * looks correct for a layer sitting at the origin and is wrong for every
       * other one, which is the failure this whole API exists to remove.
       */
      const spaceOf = (name: string | null, t: number, fn: string): LayerSpace => {
        const sp = ctx.spaceAt?.(name, t);
        if (!sp) {
          throw new Error(
            name === null
              ? `${fn}() cannot see this layer’s transform here.`
              : `${fn}(): no layer named “${name}”.`,
          );
        }
        return sp;
      };

      const spaceFns = (name: string | null): {
        toComp: (p: unknown, t?: number) => [number, number];
        toWorld: (p: unknown, t?: number) => [number, number, number];
        fromComp: (p: unknown, t?: number) => [number, number];
        fromWorld: (p: unknown, t?: number) => [number, number];
      } => ({
        toComp: (p, t = time) => spaceOf(name, t, 'toComp').toComp(asPoint2(p, 'toComp')),
        toWorld: (p, t = time) => spaceOf(name, t, 'toWorld').toWorld(asPoint2(p, 'toWorld')),
        fromComp: (p, t = time) => spaceOf(name, t, 'fromComp').fromComp(asPoint2(p, 'fromComp')),
        fromWorld: (p, t = time) => spaceOf(name, t, 'fromWorld').fromWorld(asPoint3(p, 'fromWorld')),
      });

      const ownSpace = spaceFns(null);

      // ── Keyframe access ────────────────────────────────────────────
      const keyTimes = ctx.keyTimes ?? [];
      const numKeys = keyTimes.length;
      /**
       * `key(n)` — the nth keyframe, ONE-BASED, as AE numbers them.
       *
       * Out-of-range clamps rather than throwing: `key(numKeys)` is the
       * commonest call and an off-by-one there would otherwise take down the
       * whole property rather than degrading.
       */
      const key = (n: number): { index: number; time: number; value: number } => {
        const i = Math.max(1, Math.min(numKeys, Math.round(n)));
        const t = keyTimes[i - 1] ?? 0;
        return { index: i, time: t, value: selfAt(t) };
      };
      /** `nearestKey(t)` — the keyframe closest in time to `t`. */
      const nearestKey = (t = time): { index: number; time: number; value: number } => {
        if (numKeys === 0) return { index: 0, time: 0, value };
        let best = 0;
        for (let i = 1; i < numKeys; i++) {
          if (Math.abs(keyTimes[i]! - t) < Math.abs(keyTimes[best]! - t)) best = i;
        }
        return key(best + 1);
      };

      // ── Marker access ──────────────────────────────────────────────
      /**
       * `marker.*` for one scope, deliberately the same shape as the keyframe
       * accessors above — `numKeys`, `key(n)`, `nearestKey(t)` — because in AE
       * they ARE the same shape, and someone who has learned one should not
       * have to learn the other.
       *
       * The empty case returns a zero marker rather than null or undefined.
       * `marker.nearestKey(time).time` is the canonical use, and on a comp
       * with no markers the null version would throw on `.time` and take the
       * whole property down; 0 degrades to "the start", which is wrong but
       * survivable and visible.
       */
      const buildMarkers = (which: 'comp' | 'layer') => {
        const sorted = [...(ctx.markersAt?.(which) ?? [])]
          .sort((a, b) => a.time - b.time)
          .map((m, i): ExprMarker => ({ ...m, index: i + 1 }));
        const EMPTY: ExprMarker = { time: 0, duration: 0, name: '', comment: '', index: 0 };
        /**
         * `key(n)` — 1-based by position, or by NAME/comment when given a
         * string, which is AE's other form (`marker.key("Chorus")`).
         *
         * Comment is matched before name because that is the field AE's
         * string form addresses; name is accepted too since our markers carry
         * a label as well and `addMarkerAtPlayhead` fills the label, not the
         * comment — so matching only AE's field would make the string form
         * useless on every marker this app creates.
         */
        const mKey = (n: number | string): ExprMarker => {
          if (typeof n === 'string') {
            return sorted.find((m) => m.comment === n)
              ?? sorted.find((m) => m.name === n)
              ?? EMPTY;
          }
          if (sorted.length === 0) return EMPTY;
          const i = Math.max(1, Math.min(sorted.length, Math.round(n)));
          return sorted[i - 1]!;
        };
        const mNearest = (t = time): ExprMarker => {
          if (sorted.length === 0) return EMPTY;
          let best = 0;
          for (let i = 1; i < sorted.length; i++) {
            if (Math.abs(sorted[i]!.time - t) < Math.abs(sorted[best]!.time - t)) best = i;
          }
          return sorted[best]!;
        };
        return { numKeys: sorted.length, key: mKey, nearestKey: mNearest };
      };
      /**
       * LAZY, and that is not premature. `run` is called per property per
       * frame, so building and sorting two marker lists eagerly would charge
       * every expression in the project for a feature almost none of them use.
       * The getter defers to first access and the memo keeps one build per
       * evaluation, which is what a marker expression actually needs.
       *
       * `readMember` (exprLang.ts) does a plain property read, so a getter is
       * indistinguishable from a field to the evaluator — checked, not assumed.
       */
      const markerScope = (which: 'comp' | 'layer') => {
        let api: ReturnType<typeof buildMarkers> | null = null;
        const get = () => (api ??= buildMarkers(which));
        return {
          get numKeys() { return get().numKeys; },
          key: (n: number | string) => get().key(n),
          nearestKey: (t?: number) => get().nearestKey(t),
        };
      };
      /**
       * Bare `marker` is the LAYER's markers, matching AE — comp markers are
       * `thisComp.marker`. Worth stating because the reverse is the natural
       * guess, and the two silently differ: a bare `marker` reading comp
       * markers would work fine until someone put a marker on a layer.
       */
      const markerLayer = markerScope('layer');
      const markerComp = markerScope('comp');

      /**
       * `posterizeTime(fps)` — quantise the clock this expression sees.
       *
       * Returns the stepped time rather than mutating anything, because an
       * interpreted expression has no way to re-enter itself with a different
       * `time`. `wiggle(3, 40, 1, 0.5, posterizeTime(8))` is the idiomatic use
       * and reads the same as AE's, even though AE's version is a statement and
       * this is a value.
       */
      const posterizeTime = (fps: number, t = time): number =>
        fps > 0 ? Math.floor(t * fps) / fps : t;

      // ── Vector maths ───────────────────────────────────────────────
      // AE treats a 1-element vector and a scalar interchangeably, so each of
      // these coerces a bare number to [n] rather than erroring.
      const vec = (v: number | number[]): number[] => (Array.isArray(v) ? v : [v]);
      const zip = (a: number | number[], b: number | number[], f: (x: number, y: number) => number): number[] => {
        const va = vec(a); const vb = vec(b);
        const n = Math.max(va.length, vb.length);
        // The SHORTER operand extends with its last component, not with zero:
        // `add([10,20], 5)` means "add 5 to both", which is how AE's scalar
        // broadcast behaves. Padding with 0 would silently drop the second.
        const at = (v: number[], i: number): number => v[i] ?? v[v.length - 1] ?? 0;
        return Array.from({ length: n }, (_, i) => f(at(va, i), at(vb, i)));
      };
      const add = (a: number | number[], b: number | number[]): number[] => zip(a, b, (x, y) => x + y);
      const sub = (a: number | number[], b: number | number[]): number[] => zip(a, b, (x, y) => x - y);
      const mul = (a: number | number[], b: number | number[]): number[] => zip(a, b, (x, y) => x * y);
      const div = (a: number | number[], b: number | number[]): number[] =>
        zip(a, b, (x, y) => (y === 0 ? 0 : x / y));
      const dot = (a: number | number[], b: number | number[]): number =>
        zip(a, b, (x, y) => x * y).reduce((s, v) => s + v, 0);
      /** 3D cross product. 2-vectors are treated as z=0, which is what makes
       *  `cross([1,0],[0,1])` give [0,0,1] as expected rather than erroring. */
      const cross = (a: number | number[], b: number | number[]): number[] => {
        const [ax = 0, ay = 0, az = 0] = vec(a);
        const [bx = 0, by = 0, bz = 0] = vec(b);
        return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
      };
      const length = (a: number | number[], b?: number | number[]): number =>
        b === undefined
          ? Math.hypot(...vec(a))
          : Math.hypot(...sub(a, b)); // AE's two-argument form: distance between points
      const normalize = (a: number | number[]): number[] => {
        const len = Math.hypot(...vec(a));
        return len === 0 ? vec(a).map(() => 0) : vec(a).map((v) => v / len);
      };

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
        if (mode === 'continue') {
          // AE: keep the last segment's speed. Sample just inside the span —
          // at `end` a hold-clamped selfAt has zero finite-difference velocity.
          const tip = end - Math.min(0.001, dur / 2);
          return selfAt(end) + velocityAtTime(tip) * (time - end);
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
        if (mode === 'continue') {
          const tip = start + Math.min(0.001, dur / 2);
          return selfAt(start) + velocityAtTime(tip) * (time - start);
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
        // Without a prop this is a LAYER OBJECT, and the coordinate-space
        // functions are bound to THAT layer — `thisComp.layer('Target').toComp`
        // must convert in the target's space, not in this one's, which is the
        // whole reason to reach for it.
        layer: (name: string, prop?: string) => prop ? layer(name, prop) : {
          width: compInfo.width,
          height: compInfo.height,
          name,
          ...spaceFns(name),
        },
        marker: markerComp,
      };
      const thisLayer = {
        ...(ctx.layerInfo ?? {
          name: 'Layer',
          width: compInfo.width,
          height: compInfo.height,
        }),
        // AE spells these as layer methods, so `thisLayer.toComp([0,0])` is the
        // form people already know. The bare `toComp([0,0])` is bound too, the
        // same way `sourceRectAtTime` is — one shorter to type, identical.
        ...ownSpace,
        marker: markerLayer,
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
      // `fetch`, no prototype chain to climb.
      //
      // §2·0 NOTE. This Map is the AUTHORITY on what exists. Two other lists
      // describe the same set — `API_NAMES` (editor highlighting) and
      // `EXPRESSION_API` (autocomplete + docs) — and nothing forced the three to
      // agree, so a function added here alone would work but be invisible and
      // undiscoverable: a model with no UI. `API_NAMES` is now DERIVED from
      // `EXPRESSION_API` below, and `expressionApi.test.ts` asserts this Map and
      // that table hold the same names, which closes the loop.
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
        // ── Round two ──
        ['sourceRectAtTime', sourceRectAtTime],
        ['toComp', ownSpace.toComp], ['toWorld', ownSpace.toWorld],
        ['fromComp', ownSpace.fromComp], ['fromWorld', ownSpace.fromWorld],
        ['seedRandom', seedRandom], ['gaussRandom', gaussRandom], ['noise', noise],
        ['numKeys', numKeys], ['key', key], ['nearestKey', nearestKey],
        ['marker', markerLayer],
        ['posterizeTime', posterizeTime],
        ['add', add], ['sub', sub], ['mul', mul], ['div', div],
        ['dot', dot], ['cross', cross], ['length', length], ['normalize', normalize],
      ]);
      // Reflect the REAL Map for the discoverability guard. Captured once
      // (first evaluation) rather than per run, because `run` is called per
      // property per frame and this exists only so a test can enumerate what
      // is actually bound — see `boundScopeNames`.
      if (boundNames.length === 0) boundNames = [...scope.keys()];

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
  // Bounce before generic sine — "bounce" used to map to Math.sin and train
  // the wrong muscle memory for the AE post-key decay idiom. One expression
  // (no statements): the language is expression-only, not AE ExtendScript.
  if (/bounce/.test(s)) {
    return 'time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * 0.05 * Math.sin((time - key(numKeys).time) * 12) / Math.exp((time - key(numKeys).time) * 4)';
  }
  // Inertia / coast — exponential velocity decay after the last key (no sine).
  // Distinct from bounce so "add inertia" does not ship an oscillating tip.
  if (/inertia|coast|overshoot/.test(s)) {
    return 'time <= key(numKeys).time ? value : value + velocityAtTime(key(numKeys).time - 0.001) * Math.exp(-(time - key(numKeys).time) * 5)';
  }
  if (/oscillate|sine|sin|wave|pulse/.test(s)) return 'value + Math.sin(time * 3) * 40';
  if (/fade|ramp|grow|rise/.test(s)) return 'linear(time, 0, 2, 0, 100)';
  if (/clamp|limit|cap/.test(s)) return 'clamp(value, 0, 100)';
  // Pingpong before generic loop — otherwise "pingpong loop" matched cycle.
  if (/pingpong|ping.?pong/.test(s)) return "loopOut('pingpong')";
  if (/loop|repeat|cycle/.test(s)) return "loopOut('cycle')";
  if (/follow|delay|lag/.test(s)) return "layerAt('Leader', 'x', time - 0.2)";
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

/**
 * Names the editor highlights as API — DERIVED from `EXPRESSION_API`, not
 * maintained beside it.
 *
 * These were two hand-written lists (this one and the autocomplete table) plus
 * the `scope` Map in `run`, three descriptions of one set with nothing forcing
 * agreement. §2·0, and a costly one for this API in particular: a function
 * present in `scope` alone works perfectly and is invisible — no highlight, no
 * autocomplete entry, nothing to discover it by. That is a model with no UI,
 * which is the exact failure the project standard exists to prevent.
 *
 * Derivation collapses two of the three. `expressionApi.test.ts` closes the
 * third by asserting `scope` and this table name the same set.
 *
 * Computed lazily because `EXPRESSION_API` is declared further down the file
 * and `const` does not hoist its initialiser — deriving eagerly here throws at
 * module load.
 */
let apiNamesCache: Set<string> | null = null;
function apiNames(): Set<string> {
  // The ROOT of each label, because the tokenizer looks up `word.split('.')[0]`
  // — `Math.sin()` must register the name `Math`. Deriving the full label
  // instead silently un-highlighted `Math`, which the API test caught.
  apiNamesCache ??= new Set(
    EXPRESSION_API.map((a) => a.label.replace(/\(\)$/, '').split('.')[0]!),
  );
  return apiNamesCache;
}

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
      push(word, apiNames().has(word.split('.')[0]!) ? 'api' : 'ident');
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
  // These three were bound in scope from the start and documented nowhere, so
  // they worked and could not be found — the exact defect this table exists to
  // prevent. Surfaced by the scope-wide discoverability assertion in
  // `expressionApi.test.ts`, which the previous hand-written list could not see.
  { insert: 'framesToTime(12)', label: 'framesToTime()', hint: 'convert a frame number to seconds' },
  { insert: 'value + audio * 200', label: 'audio', hint: 'audio amplitude 0..1 at the playhead — audio-reactive motion' },
  { insert: "ctrl('Speed')", label: 'ctrl()', hint: 'read a named slider control from anywhere in the scene' },
  { insert: 'thisComp.width', label: 'thisComp', hint: 'composition properties and layer access' },
  { insert: 'thisLayer.name', label: 'thisLayer', hint: 'current layer properties' },
  { insert: 'thisProperty.valueAtTime(time - 0.5)', label: 'thisProperty', hint: 'current property accessors' },
  { insert: 'valueAtTime(time - 0.5)', label: 'valueAtTime()', hint: 'own keyframed value at any time' },
  { insert: "layer('Layer 1', 'x')", label: 'layer()', hint: "another layer's value (keyframed/base)" },
  { insert: "layerAt('Layer 1', 'x', time - 0.5)", label: 'layerAt()', hint: "another layer's value at a time" },
  { insert: "loopOut('cycle')", label: 'loopOut()', hint: 'repeat keyframes after the last (cycle · pingpong · offset · continue)' },
  { insert: "loopIn('cycle')", label: 'loopIn()', hint: 'repeat keyframes before the first (cycle · pingpong · offset · continue)' },
  // ── Round two ──
  { insert: 'sourceRectAtTime().width', label: 'sourceRectAtTime()', hint: 'content bounds {top,left,width,height} — auto-sizing plates' },
  // Coordinate spaces. The hints name the DIRECTION, because that is the only
  // thing anyone gets wrong about these four.
  { insert: 'toComp([0, 0])', label: 'toComp()', hint: 'layer point → composition coords (honours parenting, rotation, scale)' },
  { insert: 'fromComp([960, 540])', label: 'fromComp()', hint: 'composition point → this layer’s coords' },
  { insert: 'toWorld([0, 0])', label: 'toWorld()', hint: 'layer point → world coords (same as toComp for a 2D layer)' },
  { insert: 'fromWorld([960, 540])', label: 'fromWorld()', hint: 'world point → this layer’s coords' },
  { insert: 'numKeys', label: 'numKeys', hint: "this property's keyframe count" },
  { insert: 'key(1).time', label: 'key()', hint: 'nth keyframe (1-based): .index .time .value' },
  { insert: 'nearestKey(time).time', label: 'nearestKey()', hint: 'keyframe closest to a time' },
  { insert: 'marker.nearestKey(time).time', label: 'marker', hint: 'THIS LAYER’s markers: .numKeys .key(n|"name") .nearestKey(t) → {time,duration,name,comment,index}' },
  { insert: 'seedRandom(7)', label: 'seedRandom()', hint: 'rebase the random sequence' },
  { insert: 'random(100)', label: 'random()', hint: 'random 0..1, 0..max, or min..max — advances per call' },
  { insert: 'gaussRandom()', label: 'gaussRandom()', hint: 'normal distribution, mean 0 sd 1' },
  { insert: 'noise(time)', label: 'noise()', hint: 'coherent noise −1..1 — drifts, unlike random()' },
  { insert: 'posterizeTime(8)', label: 'posterizeTime()', hint: 'stepped time, e.g. wiggle(…, posterizeTime(8))' },
  { insert: 'add(value, [10, 0])', label: 'add()', hint: 'vector add (scalars broadcast)' },
  { insert: 'sub(value, [10, 0])', label: 'sub()', hint: 'vector subtract' },
  { insert: 'mul(value, 2)', label: 'mul()', hint: 'vector multiply' },
  { insert: 'div(value, 2)', label: 'div()', hint: 'vector divide (÷0 → 0)' },
  { insert: 'dot([1, 0], [0, 1])', label: 'dot()', hint: 'dot product → scalar' },
  { insert: 'cross([1, 0], [0, 1])', label: 'cross()', hint: '3D cross product (2-vectors take z=0)' },
  { insert: 'length(value)', label: 'length()', hint: 'magnitude, or distance between two points' },
  { insert: 'normalize(value)', label: 'normalize()', hint: 'unit vector' },
];
