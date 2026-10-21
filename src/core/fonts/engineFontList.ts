/**
 * The fonts the ENGINE can draw — the font menu's list.
 *
 * The C++ engine paints text from two sources: the families Premation ships
 * (`resources/fonts/fonts.json`, loaded at engine start) and the fonts
 * installed on this computer (DirectWrite / CoreText / fontconfig, the
 * engine's `listFonts`). A family offered anywhere else — a web font the page
 * loaded, a name from a hardcoded list — draws as Inter in the viewport and in
 * every export, which is what the font menu used to offer whenever the
 * browser's Local Font Access was refused.
 *
 * Each family carries its REAL faces and weights. A variable face stands for
 * every weight on its `wght` axis (the engine drives the axis), so a variable
 * family offers the hundreds inside that range and nothing outside it.
 */

import type { FontInfo } from '@motion/engine-api';
import { engine, subscribeEngine } from '@core/engine/engineInstance';
import bundledManifest from '../../../resources/fonts/fonts.json';
import type { FvarAxis } from '@core/text/variableFontProbe';
import type { LocalFace } from './localFontIndex';

interface ManifestAxis { tag: string; min: number; max: number; default: number }
interface ManifestFace { family: string; weight: number; style: string; file: string; fallback?: boolean; axes?: ManifestAxis[] }

/** One face as the menu needs it. */
interface FaceRecord {
  style: string;
  postscriptName: string;
  weight: number;
  italic: boolean;
  /** The `wght` axis range of a variable face. */
  wght: readonly [number, number] | null;
  axes: ReadonlyArray<FvarAxis>;
}

export interface FontFamilyInfo {
  family: string;
  /** Shipped with Premation — draws on every machine the project opens on. */
  bundled: boolean;
  /** Any face has variation axes. */
  variable: boolean;
  /** The weights this family really draws, ascending. */
  weights: number[];
  /** Pickable styles ("Light", "Bold Italic"), upright first then by weight. */
  faces: LocalFace[];
  /** The family's variation axes (each axis's range over all its faces). */
  axes: FvarAxis[];
}

const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
  600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};

function styleName(weight: number, italic: boolean): string {
  const base = WEIGHT_NAMES[weight] ?? String(weight);
  if (!italic) return base;
  return weight === 400 ? 'Italic' : `${base} Italic`;
}

/** The hundreds inside a `wght` range (its ends rounded inward), at least one. */
function hundredsIn([lo, hi]: readonly [number, number]): number[] {
  const out: number[] = [];
  for (let w = Math.ceil(lo / 100) * 100; w <= Math.min(900, hi); w += 100) out.push(w);
  return out.length ? out : [Math.round(Math.min(Math.max(400, lo), hi))];
}

/** Group face records into families. Pure. */
export function buildFamilies(
  records: ReadonlyArray<{ family: string; bundled: boolean; variable: boolean; face: FaceRecord }>,
): Map<string, FontFamilyInfo> {
  const groups = new Map<string, { bundled: boolean; variable: boolean; faces: FaceRecord[] }>();
  for (const r of records) {
    const family = r.family.trim();
    if (!family) continue;
    // A shipped family wins over an installed one of the same name: the
    // engine registers the bundled faces first and draws with those.
    const g = groups.get(family);
    if (!g) groups.set(family, { bundled: r.bundled, variable: r.variable, faces: [r.face] });
    else if (g.bundled === r.bundled) { g.faces.push(r.face); g.variable ||= r.variable; }
    else if (r.bundled) groups.set(family, { bundled: true, variable: r.variable, faces: [r.face] });
  }
  const out = new Map<string, FontFamilyInfo>();
  for (const [family, g] of groups) {
    const weights = new Set<number>();
    const faces = new Map<string, LocalFace>();
    const axes = new Map<string, FvarAxis>();
    for (const f of g.faces) {
      for (const a of f.axes) {
        const had = axes.get(a.tag);
        axes.set(a.tag, had ? { ...had, min: Math.min(had.min, a.min), max: Math.max(had.max, a.max) } : { ...a });
      }
    }
    const add = (style: string, weight: number, italic: boolean, postscriptName: string): void => {
      if (faces.has(style)) return;
      faces.set(style, { family, fullName: `${family} ${style}`, style, postscriptName, weight, italic });
    };
    for (const f of g.faces) {
      if (f.wght) {
        for (const w of hundredsIn(f.wght)) {
          weights.add(w);
          add(styleName(w, f.italic), w, f.italic, f.postscriptName);
        }
      } else {
        weights.add(f.weight);
        add(f.style || styleName(f.weight, f.italic), f.weight, f.italic, f.postscriptName);
      }
    }
    out.set(family, {
      family,
      bundled: g.bundled,
      variable: g.variable,
      weights: [...weights].sort((a, b) => a - b),
      faces: [...faces.values()].sort((a, b) => Number(a.italic) - Number(b.italic) || a.weight - b.weight || a.style.localeCompare(b.style)),
      axes: [...axes.values()],
    });
  }
  return out;
}

function bundledRecords(): Array<{ family: string; bundled: boolean; variable: boolean; face: FaceRecord }> {
  return (bundledManifest.faces as ManifestFace[]).map((f) => {
    const wght = f.axes?.find((a) => a.tag === 'wght');
    const italic = f.style === 'italic';
    return {
      family: f.family,
      bundled: true,
      variable: (f.axes?.length ?? 0) > 0,
      face: {
        style: styleName(f.weight, italic), postscriptName: '', weight: f.weight, italic,
        wght: wght ? [wght.min, wght.max] as const : null,
        axes: (f.axes ?? []).map((a) => ({ tag: a.tag, min: a.min, default: a.default, max: a.max, hidden: false })),
      },
    };
  });
}

function installedRecords(fonts: ReadonlyArray<FontInfo>): Array<{ family: string; bundled: boolean; variable: boolean; face: FaceRecord }> {
  return fonts.map((f) => {
    const wght = f.variableAxes.find((a) => a.tag === 'wght');
    return {
      family: f.family,
      bundled: false,
      variable: f.variableAxes.length > 0,
      face: {
        style: f.style, postscriptName: f.postScriptName, weight: Math.round(f.weight), italic: f.italic,
        wght: wght && wght.min < wght.max ? [wght.min, wght.max] as const : null,
        axes: f.variableAxes.map((a) => ({ tag: a.tag, min: a.min, default: a.defaultValue, max: a.max, hidden: false })),
      },
    };
  });
}

let families: Map<string, FontFamilyInfo> | null = null;
let bundledOnly: Map<string, FontFamilyInfo> | null = null;
let pending: Promise<Map<string, FontFamilyInfo>> | null = null;
const listeners = new Set<() => void>();
const changeListeners = new Set<() => void>();

/**
 * Load the list (once, and again after the installed fonts change — see
 * watchInstalledFonts). Without an answer from the engine (not started yet, a
 * test host) the shipped families alone are returned and nothing is cached,
 * so the next call asks again.
 */
export function loadEngineFontList(): Promise<Map<string, FontFamilyInfo>> {
  if (families) return Promise.resolve(families);
  if (pending) return pending;
  pending = (async () => {
    try {
      const res = await engine().query({ type: 'listFonts', query: '' });
      if (!res.ok) return buildFamilies(bundledRecords());
      families = buildFamilies([...bundledRecords(), ...installedRecords(res.value.fonts)]);
      for (const l of listeners) l();
      return families;
    } catch {
      return buildFamilies(bundledRecords());
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** The loaded list, or null — never triggers a query. */
export function cachedEngineFontList(): ReadonlyMap<string, FontFamilyInfo> | null {
  return families;
}

/** A family's info from the loaded list, else from the shipped families. */
export function fontFamilyInfo(family: string): FontFamilyInfo | undefined {
  return (families ?? (bundledOnly ??= buildFamilies(bundledRecords()))).get(family);
}

/** Notified each time the engine's list has loaded (the first time, and after the installed fonts changed). */
export function onEngineFontListReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Notified when a font was installed or removed on this computer while the
 * editor runs — before the new list loads: what was derived from the old one
 * (a menu's family list, a family's axes) is dropped here and asked again.
 */
export function onInstalledFontsChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** The installed fonts changed: forget the list, tell the listeners, load it again. */
function installedFontsChanged(): void {
  families = null;
  pending = null;
  for (const l of changeListeners) l();
  void loadEngineFontList();
}

/** At most one `refreshFonts` per this many ms (focus can fire in bursts). */
const REFRESH_INTERVAL_MS = 1500;

/**
 * Follow fonts installed or removed while the editor runs (in a packaged app
 * as in a checkout): each time the window regains focus — the user comes back
 * from installing one — the engine re-reads the installed fonts
 * (`refreshFonts`, a cheap check unless something changed), redraws the text
 * that changed, and announces `fontsChanged`; the list is then loaded again.
 * Returns the uninstall.
 */
export function watchInstalledFonts(): () => void {
  let last = 0;
  const onFocus = (): void => {
    const now = Date.now();
    if (now - last < REFRESH_INTERVAL_MS) return;
    last = now;
    void engine().execute({ type: 'refreshFonts' }).catch(() => { /* no engine: nothing to follow */ });
  };
  const off = subscribeEngine((batch) => {
    if (batch.events.some((e) => e.type === 'fontsChanged')) installedFontsChanged();
  });
  window.addEventListener('focus', onFocus);
  return () => {
    off();
    window.removeEventListener('focus', onFocus);
  };
}

/** Test seam. */
export function resetEngineFontListForTest(): void {
  families = null;
  pending = null;
  bundledOnly = null;
}
