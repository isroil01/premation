/**
 * The colour tokens keep their promises — measured, not asserted in a comment.
 *
 * dark.css carried a note that said "AA-checked on surface-1 (#171718)". The
 * surface had since been lightened, the text ramp never re-measured, and the
 * tertiary grey failed AA against every surface it was drawn on. A comment is
 * a claim about the moment it was written; this file is the check that runs
 * every time.
 *
 * Three contracts:
 *
 *   1. TEXT FLOOR — primary and secondary text reach 4.5:1 (WCAG AA body
 *      text) against `--surface-1`, the panel ground most text sits on;
 *      tertiary reaches 3:1 (AA large / UI components). Per theme.
 *
 *   2. SURFACE STEPS — `--surface-N+1` is LIGHTER than `--surface-N` in the
 *      dark themes and DARKER in light, by a contrast ratio of at least 1.05,
 *      so elevation stays legible without borders.
 *
 *   3. SLATE RAMP — the primitive ramp is monotonic in luminance end to end,
 *      and its chroma tapers monotonically from the mid-tone down to black.
 *      The old `--color-slate-700` (#3a3a3d) sat between a blue-tinted 600
 *      and a neutral 800 having dropped ALL of the tint in one step.
 *
 * Values are resolved through `var()` chains exactly as the browser would,
 * theme block first, then the primitive layer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

type Rgb = { r: number; g: number; b: number; a: number };
type Vars = Map<string, string>;

/** Every `--name: value;` declaration in a stylesheet, later wins. */
function declarations(css: string): Vars {
  const out: Vars = new Map();
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of src.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** The declarations inside the FIRST `{ … }` block only. */
function firstBlock(css: string): Vars {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const open = src.indexOf('{');
  const close = src.indexOf('}', open);
  return declarations(src.slice(open + 1, close));
}

const primitives = declarations(readFileSync(join(ROOT, 'tokens', 'colors.css'), 'utf8'));
const shadows = declarations(readFileSync(join(ROOT, 'tokens', 'shadows.css'), 'utf8'));

function theme(file: string): Vars {
  return firstBlock(readFileSync(join(ROOT, 'themes', file), 'utf8'));
}

/** dark.css followed by the high-contrast overrides — the cascade a browser sees. */
function highContrast(): Vars {
  const merged: Vars = new Map(theme('dark.css'));
  for (const [k, v] of theme('high-contrast.css')) merged.set(k, v);
  return merged;
}

function resolve(name: string, scope: Vars, depth = 0): string {
  if (depth > 20) throw new Error(`var() chain too deep at ${name}`);
  const raw = scope.get(name) ?? primitives.get(name) ?? shadows.get(name);
  if (raw === undefined) throw new Error(`${name} is not defined in the theme or the primitives`);
  const m = /^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/.exec(raw);
  return m ? resolve(m[1]!, scope, depth + 1) : raw;
}

function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (fn) return { r: +fn[1]!, g: +fn[2]!, b: +fn[3]!, a: fn[4] === undefined ? 1 : +fn[4] };
  throw new Error(`not a colour literal: ${value}`);
}

function color(name: string, scope: Vars): Rgb {
  return parseColor(resolve(name, scope));
}

/** Alpha colours are composited onto the surface they are drawn over. */
function over(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(c: Rgb): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function chroma(c: Rgb): number {
  return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
}

const THEMES: ReadonlyArray<{ name: string; vars: () => Vars; elevationLightens: boolean }> = [
  { name: 'dark', vars: () => theme('dark.css'), elevationLightens: true },
  { name: 'light', vars: () => theme('light.css'), elevationLightens: false },
  { name: 'high-contrast', vars: highContrast, elevationLightens: true },
];

describe.each(THEMES)('$name theme', ({ vars, elevationLightens }) => {
  const scope = vars();
  const ground = color('--surface-1', scope);

  it('text tokens clear the WCAG floor against --surface-1', () => {
    const ratio = (t: string): number => contrast(over(color(t, scope), ground), ground);
    expect(ratio('--color-text-primary')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-text-secondary')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('--color-text-tertiary')).toBeGreaterThanOrEqual(3);
  });

  /*
   * The selected row must not be the hardest row to read.
   *
   * `--color-primary` is a FILL — it is tuned to carry white text, and the
   * dashboard used it as the label colour on a `--color-primary-subtle` tint.
   * Measured live that was 2.80:1: the nav item for the page you were on was
   * less legible than every item you were not on. `--color-primary-text` is
   * the accent tuned the other way round, and this pins it there.
   *
   * Both grounds are real: the sidebar tints over `--surface-2`, the segmented
   * controls over `--surface-0`.
   */
  it('--color-primary-text clears AA on the selection tint', () => {
    const ink = color('--color-primary-text', scope);
    for (const groundName of ['--surface-0', '--surface-2']) {
      const base = color(groundName, scope);
      const tinted = over(color('--color-primary-subtle', scope), base);
      expect(contrast(ink, tinted)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('defines the whole surface contract', () => {
    for (const t of [
      '--surface-0', '--surface-1', '--surface-2', '--surface-3',
      '--surface-hover', '--surface-active', '--surface-selected',
    ]) {
      expect(() => resolve(t, scope)).not.toThrow();
    }
  });

  it(`steps ${elevationLightens ? 'lighter' : 'darker'} from --surface-0 to --surface-3`, () => {
    const levels = [0, 1, 2, 3].map((n) => color(`--surface-${n}`, scope));
    for (let i = 0; i < levels.length - 1; i++) {
      const lo = luminance(levels[i]!);
      const hi = luminance(levels[i + 1]!);
      if (elevationLightens) expect(hi).toBeGreaterThan(lo);
      else expect(hi).toBeLessThan(lo);
      // A step you can see, not just measure.
      expect(contrast(levels[i]!, levels[i + 1]!)).toBeGreaterThanOrEqual(1.05);
    }
  });

  it('keeps the legacy surface names on the contract', () => {
    // src/layout still spells these; each must land on a contract level so a
    // panel and the popover over it can never share a value by accident.
    expect(resolve('--color-surface-0', scope)).toBe(resolve('--surface-0', scope));
    expect(resolve('--color-surface-1', scope)).toBe(resolve('--surface-1', scope));
    expect(resolve('--color-surface-2', scope)).toBe(resolve('--surface-2', scope));
    expect(resolve('--color-surface-3', scope)).toBe(resolve('--surface-3', scope));
  });
});

describe('high-contrast theme', () => {
  it('draws a thicker focus ring than dark', () => {
    const hc = highContrast();
    expect(hc.get('--border-width-focus')).toBe('var(--border-width-heavy)');
    expect(theme('dark.css').has('--border-width-focus')).toBe(false); // dark keeps the 2px default
    // The ring must be opaque: an alpha ring vanishes on a light control.
    expect(color('--color-focus-ring', hc).a).toBe(1);
  });

  it('is written twice, identically (the media-query fallback)', () => {
    const src = readFileSync(join(ROOT, 'themes', 'high-contrast.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const blocks = [...src.matchAll(/\{([^{}]*)\}/g)].map((m) => declarations(m[1]!));
    expect(blocks).toHaveLength(2);
    expect([...blocks[1]!.entries()]).toEqual([...blocks[0]!.entries()]);
  });
});

describe('the slate ramp', () => {
  const STEPS = [0, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 850, 900, 925, 950, 1000];
  const ramp = STEPS.map((s) => ({ step: s, rgb: parseColor(primitives.get(`--color-slate-${s}`)!) }));

  it('is monotonic in luminance from white to black', () => {
    for (let i = 0; i < ramp.length - 1; i++) {
      const a = ramp[i]!;
      const b = ramp[i + 1]!;
      expect({ from: a.step, to: b.step, ok: luminance(a.rgb) > luminance(b.rgb) })
        .toEqual({ from: a.step, to: b.step, ok: true });
    }
  });

  it('tapers its tint monotonically from the mid-tone to black', () => {
    // The blue tint peaks at 500 and must fade from there — never jump.
    const tail = ramp.filter((r) => r.step >= 500);
    for (let i = 0; i < tail.length - 1; i++) {
      const a = tail[i]!;
      const b = tail[i + 1]!;
      expect({ from: a.step, to: b.step, ok: chroma(b.rgb) <= chroma(a.rgb) })
        .toEqual({ from: a.step, to: b.step, ok: true });
    }
  });
});
