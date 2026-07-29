/**
 * CSS `@keyframes` inside an SVG → normalised animation tracks.
 *
 * SMIL (`<animate>`) is only one of the two ways an SVG animates, and it is the
 * RARER one. Most "animated SVG" files — icon spinners, loaders, anything a
 * designer exported from a web tool — carry a `<style>` block instead:
 *
 *     @keyframes spin { to { transform: rotate(360deg) } }
 *.ring { animation: spin 1s linear infinite; transform-origin: center }
 *
 * That markup animates in an `<img>` (which is why an asset thumbnail moves),
 * but the SMIL scanner sees nothing in it, so the same file imported into the
 * scene as motionless shapes.
 *
 * This module reads those rules and hands `svgAnimation.ts` the same shape it
 * already gets from SMIL, so both kinds flow through one sampling pipeline.
 *
 * Deliberately NOT covered — reported by name rather than silently dropped:
 * animation of colour/paint, geometry (`r`, `d`, `stroke-dashoffset`), and
 * anything driven by `:hover`/`:active` (an interaction, not a timeline).
 */

import { parseSvgPathEx } from './svgParser';

/**
 * One CSS animation resolved onto one element.
 *
 * `transform` values are the canonical 5-tuple `[tx, ty, rotationDeg, sx, sy]`
 * rather than a matrix, because a matrix cannot represent a full turn: a 360°
 * spin and no rotation at all decompose identically.
 */
export interface CssAnimation {
  target: Element;
  kind: 'transform' | 'opacity' | 'dashoffset';
  /** Seconds. */
  begin: number;
  /** One iteration, seconds. */
  dur: number;
  /** Total active duration, seconds. */
  active: number;
  /** Per-keyframe values: 5-wide for `transform`, 1-wide for `opacity`. */
  values: number[][];
  /** Normalised 0..1 offsets, same length as `values`. */
  keyTimes: number[];
  /** Rotation/scale centre in the element's own user space. */
  origin: { x: number; y: number };
  alternate: boolean;
  reverse: boolean;
  /** `animation-iteration-count: infinite` — `active` is only the unroll span. */
  infinite: boolean;
  /** `steps` timing — step between values instead of gliding. */
  discrete: boolean;
  /** `animation-fill-mode: forwards | both` — hold the final value. */
  freeze: boolean;
  /** Timing function, as a 0..1 → 0..1 progress map. */
  ease?: (f: number) => number;
}

/** How long an `infinite` animation is unrolled for, matching the SMIL path. */
const MAX_UNROLL_SECONDS = 60;

type Decls = Map<string, string>;

interface StyleRule {
  selector: string;
  decls: Decls;
  /**
   * The rule declares something this module reads.
   *
   * Icon stylesheets are mostly `fill`/`stroke`; matching those against the
   * document is work with no possible outcome.
   */
  animationRelevant: boolean;
}

/** Does this declaration block say anything about animation or its origin? */
function hasAnimationDecl(decls: Decls): boolean {
  for (const key of decls.keys()) {
    if (key.startsWith('animation') || key === '-webkit-animation') return true;
    if (key === 'transform-origin' || key === 'transform-box') return true;
  }
  return false;
}

interface KeyframeBlock {
  offset: number;
  decls: Decls;
}

// ---------------------------------------------------------------------------
// CSS text → rules
// ---------------------------------------------------------------------------

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

interface RawRule {
  prelude: string;
  body: string;
}

/**
 * Split a stylesheet into its top-level rules by brace depth.
 *
 * Depth-counting rather than a regex because `@keyframes` and `@media` nest a
 * whole block of rules inside their own braces — a non-greedy `\{([^}]*)\}`
 * stops at the first inner `}` and shreds them.
 */
function splitRules(css: string): RawRule[] {
  const out: RawRule[] = [];
  let depth = 0;
  let start = 0;
  let bodyStart = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        out.push({
          prelude: css.slice(start, bodyStart).trim(),
          body: css.slice(bodyStart + 1, i),
        });
        start = i + 1;
      } else if (depth < 0) {
        depth = 0;
        start = i + 1;
      }
    }
  }
  return out;
}

function parseDecls(body: string): Decls {
  const out: Decls = new Map();
  for (const part of splitTopLevel(body, ';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (prop) out.set(prop, value);
  }
  return out;
}

/** Split on a separator that is not inside parentheses (`cubic-bezier(a, b…)`). */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** `0%`, `from`, `to`, and comma lists like `0%, 100%` → normalised offsets. */
function keyframeOffsets(prelude: string): number[] {
  const out: number[] = [];
  for (const part of splitTopLevel(prelude, ',')) {
    const p = part.trim().toLowerCase();
    if (p === 'from') out.push(0);
    else if (p === 'to') out.push(1);
    else {
      const m = /^(-?[\d.]+)%$/.exec(p);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) out.push(Math.max(0, Math.min(1, n / 100)));
      }
    }
  }
  return out;
}

interface Stylesheet {
  rules: StyleRule[];
  keyframes: Map<string, KeyframeBlock[]>;
}

function collectStylesheet(css: string): Stylesheet {
  const rules: StyleRule[] = [];
  const keyframes = new Map<string, KeyframeBlock[]>();

  const visit = (text: string): void => {
    for (const rule of splitRules(text)) {
      const at = /^@(-webkit-|-moz-|-o-)?keyframes\s+(.+)$/i.exec(rule.prelude);
      if (at) {
        // Names may be quoted (`@keyframes "spin"`).
        const name = at[2]!.trim().replace(/^["']|["']$/g, '');
        const blocks: KeyframeBlock[] = [];
        for (const kf of splitRules(rule.body)) {
          const decls = parseDecls(kf.body);
          for (const offset of keyframeOffsets(kf.prelude)) blocks.push({ offset, decls });
        }
        blocks.sort((a, b) => a.offset - b.offset);
        if (blocks.length > 0) keyframes.set(name, blocks);
        continue;
      }
      // Conditional groups wrap more rules; their contents still apply here
      // (we cannot evaluate the condition, so we take them).
      if (/^@(media|supports|layer)\b/i.test(rule.prelude)) {
        visit(rule.body);
        continue;
      }
      if (rule.prelude.startsWith('@')) continue; // @font-face, @import…
      const decls = parseDecls(rule.body);
      const animationRelevant = hasAnimationDecl(decls);
      for (const selector of splitTopLevel(rule.prelude, ',')) {
        rules.push({ selector, decls, animationRelevant });
      }
    }
  };

  visit(stripComments(css));
  return { rules, keyframes };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function parseTime(v: string): number | null {
  const m = /^(-?[\d.]+)(ms|s)$/.exec(v.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return m[2] === 'ms' ? n / 1000 : n;
}

/** Solve a cubic-bezier timing function for y at x, by bisection. */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (f: number) => number {
  const curve = (a: number, b: number, t: number): number => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (f: number) => {
    if (f <= 0) return 0;
    if (f >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let t = f;
    for (let i = 0; i < 24; i++) {
      const x = curve(x1, x2, t);
      if (Math.abs(x - f) < 1e-5) break;
      if (x < f) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return curve(y1, y2, t);
  };
}

const NAMED_EASINGS: Record<string, (f: number) => number> = {
  linear: (f) => f,
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  'ease-in': cubicBezier(0.42, 0, 1, 1),
  'ease-out': cubicBezier(0, 0, 0.58, 1),
  'ease-in-out': cubicBezier(0.42, 0, 0.58, 1),
};

interface Timing {
  ease?: (f: number) => number;
  discrete: boolean;
}

function parseTiming(raw: string | undefined): Timing {
  const v = (raw ?? 'ease').trim().toLowerCase();
  if (v.startsWith('steps(') || v === 'step-start' || v === 'step-end') return { discrete: true };
  const cb = /^cubic-bezier\(([^)]*)\)$/.exec(v);
  if (cb) {
    const n = cb[1]!.split(',').map((s) => Number(s.trim()));
    if (n.length === 4 && n.every((x) => Number.isFinite(x))) {
      return { ease: cubicBezier(n[0]!, n[1]!, n[2]!, n[3]!), discrete: false };
    }
  }
  const named = NAMED_EASINGS[v];
  // `linear` needs no remap; leaving `ease` undefined keeps the sampler cheap.
  return { ease: named && v !== 'linear' ? named : undefined, discrete: false };
}

const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILL_MODES = new Set(['none', 'forwards', 'backwards', 'both']);
const PLAY_STATES = new Set(['running', 'paused']);

interface AnimationSpec {
  name: string;
  dur: number;
  delay: number;
  iterations: number;
  direction: string;
  fillMode: string;
  timing: string;
}

/**
 * Resolve the `animation` shorthand and longhands into one spec per animation.
 *
 * The shorthand is positional only for its two <time> values (duration first,
 * delay second); everything else is identified by what it looks like, which is
 * exactly how the CSS grammar defines it.
 */
function readAnimationSpecs(decls: Decls, knownNames: ReadonlySet<string>): AnimationSpec[] {
  const specs: AnimationSpec[] = [];

  const shorthand = decls.get('animation') ?? decls.get('-webkit-animation');
  if (shorthand) {
    for (const one of splitTopLevel(shorthand, ',')) {
      const spec: AnimationSpec = { name: '', dur: 0, delay: 0, iterations: 1, direction: 'normal', fillMode: 'none', timing: 'ease' };
      let timesSeen = 0;
      for (const tok of one.split(/\s+/).filter(Boolean)) {
        const low = tok.toLowerCase();
        const time = parseTime(low);
        if (time !== null) {
          if (timesSeen === 0) spec.dur = time;
          else if (timesSeen === 1) spec.delay = time;
          timesSeen++;
          continue;
        }
        if (low === 'infinite') { spec.iterations = Infinity; continue; }
        if (/^[\d.]+$/.test(low)) { spec.iterations = Number(low); continue; }
        if (DIRECTIONS.has(low)) { spec.direction = low; continue; }
        if (FILL_MODES.has(low) && low !== 'none') { spec.fillMode = low; continue; }
        if (PLAY_STATES.has(low)) continue;
        if (NAMED_EASINGS[low] || low.startsWith('cubic-bezier(') || low.startsWith('steps(') || low.startsWith('step-')) {
          spec.timing = low;
          continue;
        }
        if (knownNames.has(tok)) spec.name = tok;
      }
      if (spec.name) specs.push(spec);
    }
  }

  // Longhands override / stand alone. Only the first name is honoured — a
  // comma list of longhands pairing up positionally is vanishingly rare in SVG.
  const nameLong = decls.get('animation-name');
  if (nameLong) {
    const name = splitTopLevel(nameLong, ',')[0] ?? '';
    if (name && name !== 'none' && knownNames.has(name)) {
      let spec = specs.find((s) => s.name === name);
      if (!spec) {
        spec = { name, dur: 0, delay: 0, iterations: 1, direction: 'normal', fillMode: 'none', timing: 'ease' };
        specs.push(spec);
      }
    }
  }
  for (const spec of specs) {
    const d = decls.get('animation-duration');
    if (d) spec.dur = parseTime(splitTopLevel(d, ',')[0] ?? '') ?? spec.dur;
    const delay = decls.get('animation-delay');
    if (delay) spec.delay = parseTime(splitTopLevel(delay, ',')[0] ?? '') ?? spec.delay;
    const it = decls.get('animation-iteration-count');
    if (it) {
      const first = (splitTopLevel(it, ',')[0] ?? '').toLowerCase();
      spec.iterations = first === 'infinite' ? Infinity : (Number(first) || spec.iterations);
    }
    const dir = decls.get('animation-direction');
    if (dir) spec.direction = (splitTopLevel(dir, ',')[0] ?? 'normal').toLowerCase();
    const fm = decls.get('animation-fill-mode');
    if (fm) spec.fillMode = (splitTopLevel(fm, ',')[0] ?? 'none').toLowerCase();
    const tf = decls.get('animation-timing-function');
    if (tf) spec.timing = (splitTopLevel(tf, ',')[0] ?? 'ease').toLowerCase();
  }
  return specs.filter((s) => s.dur > 0);
}

// ---------------------------------------------------------------------------
// transform / transform-origin
// ---------------------------------------------------------------------------

/** `[tx, ty, rotationDeg, scaleX, scaleY]` — the identity. */
const IDENTITY: number[] = [0, 0, 0, 1, 1];

function lengthPx(v: string): number {
  const m = /^(-?[\d.]+)(px|)$/.exec(v.trim());
  return m ? Number(m[1]) || 0 : 0;
}

function angleDeg(v: string): number {
  const m = /^(-?[\d.]+)(deg|grad|rad|turn)?$/.exec(v.trim().toLowerCase());
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  switch (m[2]) {
    case 'rad': return n * (180 / Math.PI);
    case 'grad': return n * 0.9;
    case 'turn': return n * 360;
    default: return n;
  }
}

/**
 * A CSS `transform` list → the canonical 5-tuple.
 *
 * Accumulated per function rather than multiplied into a matrix, so a
 * `rotate(360deg)` survives as 360 instead of collapsing to the identity. The
 * cost is that a list mixing rotation with a later translation is treated as
 * translate-then-rotate; the ordered form is what authored SVG animation
 * overwhelmingly uses, and the alternative loses whole spins.
 */
function parseTransformList(value: string): number[] {
  const out = [...IDENTITY];
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const fn = m[1]!.toLowerCase();
    const args = m[2]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const a0 = args[0] ?? '';
    const a1 = args[1] ?? '';
    switch (fn) {
      case 'translate':
        out[0]! += lengthPx(a0);
        out[1]! += lengthPx(a1);
        break;
      case 'translatex': out[0]! += lengthPx(a0); break;
      case 'translatey': out[1]! += lengthPx(a0); break;
      case 'rotate':
      case 'rotatez': out[2]! += angleDeg(a0); break;
      case 'scale': {
        const sx = Number(a0);
        const sy = a1 === '' ? sx : Number(a1);
        if (Number.isFinite(sx)) out[3]! *= sx;
        if (Number.isFinite(sy)) out[4]! *= sy;
        break;
      }
      case 'scalex': { const s = Number(a0); if (Number.isFinite(s)) out[3]! *= s; break; }
      case 'scaley': { const s = Number(a0); if (Number.isFinite(s)) out[4]! *= s; break; }
      default: break; // matrix()/skew()/3-D — left at identity
    }
  }
  return out;
}

interface Box { x: number; y: number; w: number; h: number }

function viewBoxOf(doc: Document): Box {
  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n));
  if (vb.length === 4) return { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]! };
  const w = Number(svg.getAttribute('width')) || 100;
  const h = Number(svg.getAttribute('height')) || 100;
  return { x: 0, y: 0, w, h };
}

/**
 * The element's own bounding box in its local user space, for
 * `transform-box: fill-box`. Approximate for paths (control points are
 * included), which only shifts a rotation centre by a hair.
 */
function localBox(el: Element): Box | null {
  const num = (name: string): number => Number(el.getAttribute(name)) || 0;
  switch (el.tagName.toLowerCase().replace(/^svg:/, '')) {
    case 'rect':
      return { x: num('x'), y: num('y'), w: num('width'), h: num('height') };
    case 'circle': {
      const r = num('r');
      return { x: num('cx') - r, y: num('cy') - r, w: r * 2, h: r * 2 };
    }
    case 'ellipse': {
      const rx = num('rx');
      const ry = num('ry');
      return { x: num('cx') - rx, y: num('cy') - ry, w: rx * 2, h: ry * 2 };
    }
    case 'line': {
      const x1 = num('x1'); const y1 = num('y1'); const x2 = num('x2'); const y2 = num('y2');
      return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    }
    case 'polygon':
    case 'polyline': {
      const n = (el.getAttribute('points') ?? '').split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
      if (n.length < 2) return null;
      const xs: number[] = []; const ys: number[] = [];
      for (let i = 0; i + 1 < n.length; i += 2) { xs.push(n[i]!); ys.push(n[i + 1]!); }
      return boxOf(xs, ys);
    }
    case 'path': {
      const d = el.getAttribute('d');
      if (!d) return null;
      const { points } = parseSvgPathEx(d);
      if (points.length === 0) return null;
      return boxOf(points.map((p) => p.x), points.map((p) => p.y));
    }
    case 'g': {
      let box: Box | null = null;
      for (const child of Array.from(el.children)) {
        const b = localBox(child);
        if (!b) continue;
        box = box ? union(box, b) : b;
      }
      return box;
    }
    default:
      return null;
  }
}

function boxOf(xs: number[], ys: number[]): Box {
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

const ORIGIN_KEYWORDS: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };

function originComponent(token: string, size: number, start: number): number | null {
  const t = token.trim().toLowerCase();
  const kw = ORIGIN_KEYWORDS[t];
  if (kw !== undefined) return start + size * kw;
  const pct = /^(-?[\d.]+)%$/.exec(t);
  if (pct) return start + size * (Number(pct[1]) / 100);
  const px = /^(-?[\d.]+)(px)?$/.exec(t);
  if (px) return start + Number(px[1]);
  return null;
}

/**
 * Resolve `transform-origin` against the right reference box.
 *
 * The default matters more than it looks: for SVG elements `transform-box`
 * initially resolves to the VIEW BOX, so an unqualified `transform-origin`
 * rotates about the middle of the artboard, not the middle of the shape. Files
 * that spin a shape in place say `transform-box: fill-box` for exactly that
 * reason, and getting this wrong makes a spinner orbit instead of turn.
 */
function resolveOrigin(el: Element, decls: Decls, viewBox: Box): { x: number; y: number } {
  const box = (decls.get('transform-box') ?? 'view-box').trim().toLowerCase() === 'fill-box'
    ? (localBox(el) ?? viewBox)
    : viewBox;
  const raw = (decls.get('transform-origin') ?? '50% 50%').trim();
  const parts = raw.split(/\s+/);
  // A single vertical keyword (`top`) sets Y, not X.
  const vertical = new Set(['top', 'bottom']);
  let xTok = parts[0] ?? '50%';
  let yTok = parts[1] ?? '50%';
  if (parts.length === 1 && vertical.has(xTok.toLowerCase())) {
    yTok = xTok;
    xTok = 'center';
  }
  if (parts.length >= 2 && vertical.has(xTok.toLowerCase())) {
    const swap = xTok; xTok = yTok; yTok = swap;
  }
  const x = originComponent(xTok, box.w, box.x);
  const y = originComponent(yTok, box.h, box.y);
  return {
    x: x ?? box.x + box.w / 2,
    y: y ?? box.y + box.h / 2,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Properties a keyframe block may animate that we cannot express. */
const IGNORED_PROPS = new Set(['animation-timing-function', 'transform-origin', 'transform-box']);

export interface CssAnimationScan {
  anims: CssAnimation[];
  /** Property/feature names that were recognised but not translated. */
  unsupported: Set<string>;
}

/**
 * Read every CSS animation in the document and resolve it onto its elements.
 *
 * Cascade handling is source order, not specificity — a stylesheet inside an
 * SVG icon is a handful of flat class rules, and full cascade resolution would
 * buy nothing for it.
 */
export function readCssAnimations(doc: Document, unrollSeconds = MAX_UNROLL_SECONDS): CssAnimationScan {
  const unroll = Math.min(Math.max(unrollSeconds, 0.1), MAX_UNROLL_SECONDS);
  const unsupported = new Set<string>();
  const anims: CssAnimation[] = [];

  const css = Array.from(doc.getElementsByTagName('style'))
    .map((s) => s.textContent ?? '')
    .join('\n');
  const inlineAnimated = Array.from(doc.querySelectorAll('[style*="animation"]'));
  if (!css.trim() && inlineAnimated.length === 0) return { anims, unsupported };

  const sheet = collectStylesheet(css);
  if (sheet.keyframes.size === 0) {
    // `animation:` naming a `@keyframes` we never saw (an external sheet, or a
    // name defined outside this file) is unresolvable, not absent.
    if (/animation\s*[:-]/i.test(css)) unsupported.add('CSS animation (no @keyframes found)');
    return { anims, unsupported };
  }
  if (/:hover|:active|:focus/i.test(css)) unsupported.add('CSS :hover/:active animation');

  const viewBox = viewBoxOf(doc);
  const knownNames = new Set(sheet.keyframes.keys());

  // Resolve the cascade RULE-first, and only for rules that could matter.
  //
  // Asking every element whether it matches every rule is the obvious shape and
  // the wrong one: it is one scripted `matches` call per pair, so a 200-path
  // icon with 200 class rules was 40,000 of them. Running each selector once
  // through `querySelectorAll` pushes the same work into the DOM's own matcher
  // and visits only elements a rule actually reached. Source order is preserved
  // because the rules are still applied in order.
  const declsFor = new Map<Element, Decls>();
  const declsOf = (el: Element): Decls => {
    let d = declsFor.get(el);
    if (!d) { d = new Map(); declsFor.set(el, d); }
    return d;
  };
  for (const rule of sheet.rules) {
    if (!rule.animationRelevant) continue;
    let matched: ArrayLike<Element>;
    try {
      matched = doc.querySelectorAll(rule.selector);
    } catch {
      continue; // unsupported selector syntax — skip it, don't crash the import
    }
    for (let i = 0; i < matched.length; i++) {
      const decls = declsOf(matched[i]!);
      for (const [k, v] of rule.decls) decls.set(k, v);
    }
  }
  // Inline styles win over any rule, and can declare an animation on their own.
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const inline = parseDecls(el.getAttribute('style') ?? '');
    if (!hasAnimationDecl(inline) && !declsFor.has(el)) continue;
    const decls = declsOf(el);
    for (const [k, v] of inline) decls.set(k, v);
  }

  for (const [el, decls] of declsFor) {
    for (const spec of readAnimationSpecs(decls, knownNames)) {
      const blocks = sheet.keyframes.get(spec.name);
      if (!blocks) continue;
      const timing = parseTiming(spec.timing);
      const active = Math.min(
        Number.isFinite(spec.iterations) ? spec.dur * spec.iterations : unroll,
        unroll,
      );
      const base = {
        target: el,
        begin: Math.max(0, spec.delay),
        dur: spec.dur,
        active,
        origin: resolveOrigin(el, decls, viewBox),
        alternate: spec.direction.startsWith('alternate'),
        reverse: spec.direction.endsWith('reverse'),
        infinite: !Number.isFinite(spec.iterations),
        discrete: timing.discrete,
        freeze: spec.fillMode === 'forwards' || spec.fillMode === 'both',
        ...(timing.ease ? { ease: timing.ease } : {}),
      };

      for (const [prop, kind] of [
        ['transform', 'transform'],
        ['opacity', 'opacity'],
        ['stroke-dashoffset', 'dashoffset'],
      ] as const) {
        const track = buildTrack(blocks, prop);
        if (track) anims.push({ ...base, kind, values: track.values, keyTimes: track.keyTimes });
      }

      for (const block of blocks) {
        for (const prop of block.decls.keys()) {
          if (prop === 'transform' || prop === 'opacity' || prop === 'stroke-dashoffset' || IGNORED_PROPS.has(prop)) continue;
          unsupported.add(`CSS ${prop}`);
        }
      }
    }
  }

  return { anims, unsupported };
}

/**
 * Values for one property across a `@keyframes` block list.
 *
 * A property missing from an offset does not freeze there — CSS falls back to
 * the element's base value — so an absent `0%`/`100%` is filled with the
 * identity rather than by extending the neighbouring keyframe.
 */
function buildTrack(
  blocks: readonly KeyframeBlock[],
  prop: 'transform' | 'opacity' | 'stroke-dashoffset',
): { values: number[][]; keyTimes: number[] } | null {
  // `stroke-dashoffset`'s neutral value is 0 (nothing hidden) — the draw-on
  // convention keyframes AWAY from it, so an absent endpoint means "drawn".
  const identity = prop === 'transform' ? IDENTITY : prop === 'opacity' ? [1] : [0];
  const knots: Array<{ offset: number; value: number[] }> = [];
  for (const block of blocks) {
    const raw = block.decls.get(prop);
    if (raw === undefined) continue;
    if (prop === 'transform') {
      knots.push({ offset: block.offset, value: parseTransformList(raw) });
    } else {
      // Opacity is unitless; dashoffset may carry px.
      const n = Number(/^(-?[\d.]+)/.exec(raw.trim())?.[1]);
      if (Number.isFinite(n)) knots.push({ offset: block.offset, value: [n] });
    }
  }
  if (knots.length === 0) return null;

  if (knots[0]!.offset > 1e-6) knots.unshift({ offset: 0, value: [...identity] });
  if (knots[knots.length - 1]!.offset < 1 - 1e-6) knots.push({ offset: 1, value: [...identity] });
  if (knots.length < 2) return null;

  return { values: knots.map((k) => k.value), keyTimes: knots.map((k) => k.offset) };
}
