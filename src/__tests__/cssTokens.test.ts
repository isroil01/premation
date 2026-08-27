/**
 * Every `var(--token)` in the app's CSS must name a token that exists.
 *
 * A var() pointing at an undefined token is invisible: with a fallback the
 * fallback silently becomes the permanent value (so the theme can never reach
 * it); without one the declaration is dropped entirely and the element
 * inherits. Neither shows up as an error anywhere.
 *
 * Reported as issue #13 ("I tried to switch theme, but a few areas are still
 * dark mode"). The sweep that fixed it turned up a whole family of these:
 *
 *   --color-primary-contrast  →  hardcoded #fff for the selected property name
 *   --color-error             →  export-preview error state had no colour
 *   --color-surface           →  hardcoded #1e1e1e panel grounds
 *   --color-input-bg          →  hardcoded rgba(0,0,0,.3) input wells
 *   --color-surface-hover     →  hardcoded white alpha in the graph editor
 *   --font-mono / --font-family-base / --font-weight-normal / --z-modal …
 *
 * Each was a plausible-looking name that simply was not the name. This test is
 * how the next one gets caught at commit time instead of in a bug report.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

/**
 * Custom properties that are set at RUNTIME rather than in a stylesheet, so a
 * static scan cannot see their definition.
 *   • the three density vars written by `applyUiPreferences`
 *   • `--app-accent`, written by the accent-customization setting
 *   • Radix's own positioning vars, written by the popper on mount
 */
const RUNTIME_DEFINED = new Set([
  '--sidebar-item-padding',
  '--sidebar-item-font-size',
  '--app-accent',
]);
const RUNTIME_PREFIXES = ['--radix-'];

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (entry.endsWith('.css')) out.push(full);
  }
  return out;
}

const files = cssFiles(ROOT);

/** Custom properties declared anywhere in the global token/theme layer. */
const globalTokens = new Set<string>();
for (const file of files) {
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
  if (!rel.startsWith('tokens/') && !rel.startsWith('themes/') && !rel.startsWith('styles/')) continue;
  for (const m of readFileSync(file, 'utf8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    globalTokens.add(m[1]!);
  }
}

/**
 * Custom properties any stylesheet declares, plus the ones components write
 * from TSX (`style={{ '--fill': … }}`).
 *
 * A component knob is legitimately declared in one file and consumed in
 * another — `--prop-value-col` is set by the effects panel and read by the
 * shared PropertyRow — so "defined" has to mean "defined somewhere", not
 * "defined in the token layer".
 */
const componentKnobs = new Set<string>();
for (const file of files) {
  for (const m of readFileSync(file, 'utf8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) {
    componentKnobs.add(m[1]!);
  }
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

for (const file of sourceFiles(ROOT)) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]\s*[,:)]/g)) componentKnobs.add(m[1]!);
}

describe('CSS custom properties', () => {
  it('finds the token layer (guards against a moved/renamed tokens dir)', () => {
    expect(globalTokens.size).toBeGreaterThan(100);
    // Spot-check one from each token file so a silently-emptied file fails.
    expect(globalTokens).toContain('--color-primary');
    expect(globalTokens).toContain('--color-timeline-playhead');
    expect(globalTokens).toContain('--font-family-mono');
    expect(globalTokens).toContain('--z-index-modal');
    expect(globalTokens).toContain('--space-2');
  });

  /**
   * Two distinct failures, one rule each:
   *
   *   • `var(--x)` with NO fallback and no definition — the declaration is
   *     dropped outright and the element inherits.
   *   • `var(--x, literal)` where `--x` is in a GLOBAL namespace (--color-*,
   *     --font-*, --space-*, …) but is not a token — the literal is the only
   *     value it can ever have, so the theme can never reach it.
   *
   * A `var(--component-knob, default)` whose name is NOT in a global namespace
   * is fine by construction: that syntax IS how a component declares an
   * overridable default.
   */
  it('has no var() pointing at a token nobody defines', () => {
    const GLOBAL_NAMESPACES = [
      '--color-', '--font-', '--space-', '--radius-',
      '--shadow-', '--motion-', '--z-', '--bar-', '--control-', '--icon-',
    ];
    const dangling: string[] = [];

    for (const file of files) {
      // Comments first: prose that quotes a var() is not a reference, and this
      // file's own docs quote several.
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      const local = new Set(
        [...src.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]!),
      );

      for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
        const name = m[1]!;
        const hasFallback = m[2] === ',';
        if (globalTokens.has(name) || local.has(name) || componentKnobs.has(name)) continue;
        if (RUNTIME_DEFINED.has(name)) continue;
        if (RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        const isGlobalName = GLOBAL_NAMESPACES.some((ns) => name.startsWith(ns));
        if (hasFallback && !isGlobalName) continue; // component knob's own default
        const line = src.slice(0, m.index).split('\n').length;
        dangling.push(`${rel}:~${line}  ${name}${hasFallback ? ' (theme can never reach it)' : ' (declaration dropped)'}`);
      }
    }

    expect(dangling).toEqual([]);
  });
});

describe('theme coverage', () => {
  /**
   * The light theme has to redefine every semantic colour the dark theme sets.
   * A token defined only in dark.css keeps its DARK value in the light theme —
   * which is exactly how "a few areas are still dark mode" happens.
   */
  it('light theme redefines every colour token the dark theme defines', () => {
    const read = (name: string): Set<string> =>
      new Set(
        [...readFileSync(join(ROOT, 'themes', name), 'utf8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)]
          .map((m) => m[1]!),
      );
    const dark = read('dark.css');
    const light = read('light.css');
    const missing = [...dark].filter((t) => !light.has(t));
    expect(missing).toEqual([]);
  });

  /**
   * Timeline surfaces are the ones that must NOT be theme-fixed — they were the
   * headline complaint. Pin that every one of them has a light-theme value.
   */
  it('defines a light value for every timeline surface token', () => {
    const domain = readFileSync(join(ROOT, 'tokens', 'domain.css'), 'utf8');
    const lightBlock = domain.slice(domain.indexOf('[data-theme="light"]'));
    expect(lightBlock).not.toBe('');
    for (const token of [
      '--color-timeline-bg',
      '--color-timeline-header',
      '--color-timeline-header-hover',
      '--color-timeline-row-alt',
      '--color-timeline-ruler-bg',
      '--color-timeline-ruler-border',
      '--color-timeline-tick',
      '--color-timeline-tick-major',
      '--color-timeline-well',
      '--color-timeline-well-hover',
      '--color-timeline-well-border-hover',
      '--color-scrollbar-track',
      '--color-scrollbar-thumb',
      '--color-scrollbar-thumb-hover',
      '--color-checkerboard-a',
      '--color-checkerboard-b',
    ]) {
      expect(lightBlock).toContain(`${token}:`);
    }
  });
});
