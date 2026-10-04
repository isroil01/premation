/**
 * Variable-font AXES and OpenType FEATURES on a canvas that supports neither.
 *
 * ## The limitation, measured
 *
 * Chromium's `CanvasRenderingContext2D` has no `fontVariationSettings`, no
 * `fontFeatureSettings` and no `fontVariantLigatures` (checked on Chrome 152:
 * none of the three is on the context; Bahnschrift at `'wdth' 75` measured the
 * same 366.13 px as at 100). The painter used to assign
 * `ctx.fontVariationSettings` anyway — an expando property the canvas never
 * reads — so Font Width and Font Slant keyframed happily and rendered nothing.
 *
 * ## What does work
 *
 * A `FontFace` DESCRIPTOR does. A face registered from the installed file,
 * `new FontFace(alias, "local('Bahnschrift')", { variationSettings: "'wdth' 60" })`,
 * draws Bahnschrift at width 60 (264.88 px), and `featureSettings: "'liga' 0"`
 * really removes Calibri's fi ligature (31.76 → 32.08 px). So every distinct
 * (face, axes, features) combination gets an alias family, loaded once, and the
 * painter draws with the alias instead of the family.
 *
 * ## The costs, stated
 *
 *   • Loading is asynchronous. Until an alias has loaded the text draws with
 *     the plain family; when it lands, {@link fontVariantEpoch} advances and
 *     listeners (the texture provider) re-rasterize.
 *   • `local()` reaches INSTALLED fonts only. A web font the app registered
 *     from a URL has no local file to alias, the load fails, and that
 *     combination keeps drawing without its axes/features.
 *
 * Vertical alternates go one step further: wherever the font's BYTES are
 * known (a Local Font Access blob, or bytes handed to {@link registerFontBytes}
 * by whoever loaded a web / project font) the 'vert' face is built from the
 * bytes and the font's own GSUB decides, per character, what it turns — see
 * {@link verticalAlternatesFor}.
 */

import { cachedFamilyFaces,  type LocalFace } from '@core/fonts/localFontIndex';

export interface FeatureOptions {
  /** Standard ligatures (liga + clig) OFF. */
  ligatures?: false;
  discretionaryLigatures?: true;
  /** Contextual alternates (calt) OFF. */
  contextualAlternates?: false;
  /** Stylistic sets on, 1–20. */
  stylisticSets?: ReadonlyArray<number>;
}

/** CSS `font-feature-settings` for the options, or undefined when all are default. */
export function featureSettingsString(o: FeatureOptions | undefined): string | undefined {
  if (!o) return undefined;
  const parts: string[] = [];
  if (o.ligatures === false) parts.push(`'liga' 0`, `'clig' 0`);
  if (o.discretionaryLigatures) parts.push(`'dlig' 1`);
  if (o.contextualAlternates === false) parts.push(`'calt' 0`);
  const sets = [...new Set((o.stylisticSets ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= 20))].sort((a, b) => a - b);
  for (const n of sets) parts.push(`'ss${String(n).padStart(2, '0')}' 1`);
  return parts.length ? parts.join(', ') : undefined;
}

interface Entry {
  alias: string;
  status: 'loading' | 'loaded' | 'failed';
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let epoch = 0;

/** Advances every time an alias finishes loading — fold into a cache key. */
export function fontVariantEpoch(): number {
  return epoch;
}

/** Called when an alias face becomes drawable. Returns an unsubscribe. */
export function onFontVariantsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/**
 * The alias family to draw `style` with so `variation` / `features` apply, or
 * null — nothing to apply, no FontFace API, or the alias is not loaded (yet,
 * or ever). A null answer is always safe: draw with the plain family.
 */
type FaceStyle = { fontFamily?: string; fontWeight?: string; fontStyle?: string };

/** The installed face nearest `style` (italic first, then weight), if the local font index knows the family. */
function nearestFace(style: FaceStyle): LocalFace | undefined {
  const italic = style.fontStyle === 'italic';
  const weight = Number(style.fontWeight ?? 400);
  const faces = cachedFamilyFaces(style.fontFamily ?? 'Inter');
  return faces.length
    ? [...faces].sort((a, b) =>
        (a.italic === italic ? 0 : 1000) + Math.abs(a.weight - weight) - ((b.italic === italic ? 0 : 1000) + Math.abs(b.weight - weight)))[0]
    : undefined;
}

const WEIGHT_NAMES: Readonly<Record<number, string>> = { 300: 'Light', 400: 'Regular', 500: 'Medium', 700: 'Bold' };

/**
 * The `local()` names to try for `style`, most specific first:
 * postscriptName → fullName → family.
 *
 * Measured in Chromium 151 on Windows (scratch Playwright probe): `local()`
 * matches a face's PostScript or FULL name, not its family — `local("Yu Gothic")`
 * fails to load while `local("YuGothic-Regular")` and `local("Yu Gothic Regular")`
 * both load and turn 「 under 'vert'. (MS Gothic's full name IS its family, so
 * all three pass; an installed VARIABLE font such as Noto Sans KR matched only
 * by family.) Without the local font index the names are guessed from the
 * family and a plain weight.
 */
export function localFaceCandidates(style: FaceStyle, face: Pick<LocalFace, 'postscriptName' | 'fullName'> | undefined = nearestFace(style)): string[] {
  const family = style.fontFamily ?? 'Inter';
  const italic = style.fontStyle === 'italic';
  const out: string[] = [];
  const add = (n: string | null | undefined): void => {
    const clean = n?.replace(/"/g, '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
  };
  if (face) {
    add(face.postscriptName);
    add(face.fullName);
  } else {
    const w = WEIGHT_NAMES[Number(style.fontWeight ?? 400)];
    if (w) {
      const suffix = italic ? (w === 'Regular' ? 'Italic' : `${w}Italic`) : w;
      add(`${family.replace(/\s+/g, '')}-${suffix}`);
      add(`${family} ${italic ? (w === 'Regular' ? 'Italic' : `${w} Italic`) : w}`);
    } else if (italic) {
      add(`${family} Italic`);
    }
  }
  add(family);
  return out;
}

export function variantFamily(
  style: FaceStyle,
  variation: string | undefined,
  features: string | undefined,
): string | null {
  return aliasFamily(style, variation, features, null);
}

/**
 * One alias face. `only` = a single `local()` name (the vertical probe tries
 * candidates one face at a time); null = every candidate in one src list, which
 * the browser walks until one loads.
 */
function aliasFamily(
  style: FaceStyle,
  variation: string | undefined,
  features: string | undefined,
  only: string | null,
): string | null {
  if (!variation && !features) return null;
  const doc = (globalThis as { document?: Document }).document;
  const FF = (globalThis as { FontFace?: typeof FontFace }).FontFace;
  if (!doc?.fonts || typeof FF !== 'function') return null;

  const family = style.fontFamily ?? 'Inter';
  const italic = style.fontStyle === 'italic';
  const weight = Number(style.fontWeight ?? 400);
  // A variable font's named instances usually share one file, and the
  // variation string pins every axis it names anyway; a static family needs
  // the right face.
  const face = nearestFace(style);
  // Static faces keep their own weight so the browser can still synthesize;
  // an axis-driven face declares the full range so nothing is synthesized.
  const weightDesc = variation ? '1 1000' : String(face?.weight ?? (Number.isFinite(weight) ? weight : 400));
  const key = `${family}|${face?.postscriptName ?? ''}|${italic ? 'i' : ''}|${weightDesc}|${variation ?? ''}|${features ?? ''}${only !== null ? `|src:${only}` : ''}`;
  const hit = entries.get(key);
  if (hit) return hit.status === 'loaded' ? hit.alias : null;

  const alias = `__pv_${hash(key)}`;
  const entry: Entry = { alias, status: 'loading' };
  entries.set(key, entry);
  const q = (n: string): string => `local("${n}")`;
  const src = (only !== null ? [only] : localFaceCandidates(style, face)).map(q).join(', ');
  try {
    const descriptors: Record<string, string> = { style: italic ? 'italic' : 'normal', weight: weightDesc };
    if (variation) {
      descriptors.stretch = '50% 200%';
      descriptors.variationSettings = variation;
    }
    if (features) descriptors.featureSettings = features;
    const ff = new FF(alias, src, descriptors as FontFaceDescriptors);
    void ff.load().then(
      () => {
        doc.fonts.add(ff);
        entry.status = 'loaded';
        epoch++;
        for (const cb of listeners) cb();
      },
      () => {
        entry.status = 'failed';
      },
    );
  } catch {
    entry.status = 'failed';
  }
  return null;
}

// ── Vertical alternates ('vert') ───────────────────────────────────────

/** The feature a vertical-type alias adds. Not 'vrt2': that one also swaps
 *  proportional Latin for pre-rotated glyphs, which would double-rotate an
 *  upright (Standard Vertical Roman Alignment) letter. */
export const VERTICAL_ALTERNATES_FEATURE = `'vert' 1`;

/** `features` with vertical alternates switched on. */
export function withVerticalAlternates(features: string | undefined): string {
  return features ? `${features}, ${VERTICAL_ALTERNATES_FEATURE}` : VERTICAL_ALTERNATES_FEATURE;
}

const vertProbes = new Map<string, boolean>();

/** A face that draws the font's own vertical alternates, and which characters it turns. */
export interface VerticalAlternates {
  /** The alias family to draw with. */
  family: string;
  /**
   * Whether this character's glyph has a vertical alternate in the face. False
   * = take the Unicode fallback (presentation form / rotation) for THIS
   * character only. Always true for a face decided by the ink probe.
   */
  has: (codePoint: number) => boolean;
  /** 'gsub' = read from the font's bytes; 'probe' = a `local()` or WOFF2 face that turned 「. */
  source: 'gsub' | 'probe';
}

// ── Vertical alternates from font BYTES ────────────────────────────────

export interface FontBytesOptions {
  weight?: number | string;
  style?: 'normal' | 'italic';
  /** CSS unicode-range the bytes serve (several registrations may share a family). */
  unicodeRange?: string;
  /** For a collection (.ttc): the face to use, by PostScript or full name. First face otherwise. */
  postscriptName?: string;
}

type BytesLoader = () => Promise<ArrayBuffer>;

interface BytesSource {
  id: string;
  load: BytesLoader;
  weight: number;
  italic: boolean;
  unicodeRange?: string;
  postscriptName?: string;
}

const registeredBytes = new Map<string, BytesSource[]>();
let bytesSeq = 0;

function notifyChanged(): void {
  epoch++;
  for (const cb of listeners) cb();
}

/**
 * Tell vertical type the bytes behind a family the app loaded itself (a web
 * font fetched from a URL, a font bundled with a project). `bytes` may be a
 * loader, called at most once per face when vertical text first needs it.
 * Returns an unregister. Additive: nothing else about drawing the family changes.
 */
export function registerFontBytes(
  family: string,
  bytes: ArrayBuffer | ArrayBufferView | BytesLoader,
  options: FontBytesOptions = {},
): () => void {
  const key = family.trim().toLowerCase();
  let load: BytesLoader;
  if (typeof bytes === 'function') load = bytes;
  else {
    const buf = ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice().buffer : bytes;
    load = () => Promise.resolve(buf);
  }
  const w = Number(options.weight ?? 400);
  const source: BytesSource = {
    id: `r${++bytesSeq}`,
    load,
    weight: Number.isFinite(w) ? w : 400,
    italic: options.style === 'italic',
    ...(options.unicodeRange ? { unicodeRange: options.unicodeRange } : {}),
    ...(options.postscriptName ? { postscriptName: options.postscriptName } : {}),
  };
  const list = registeredBytes.get(key) ?? [];
  list.push(source);
  registeredBytes.set(key, list);
  notifyChanged();
  return () => {
    const cur = registeredBytes.get(key);
    const i = cur?.indexOf(source) ?? -1;
    if (cur && i >= 0) {
      cur.splice(i, 1);
      if (cur.length === 0) registeredBytes.delete(key);
      notifyChanged();
    }
  };
}

interface ByteEntry {
  status: 'loading' | 'ready' | 'failed';
  alias: string;
  /** Code points the face turns (GSUB); null = no GSUB answer, ink-probe the face. */
  codePoints: ReadonlySet<number> | null;
  probe?: boolean;
}

const byteEntries = new Map<string, ByteEntry>();

type MeasureContext = { font: string; measureText(t: string): TextMetrics };

function probeContext(): MeasureContext | null {
  try {
    const doc = (globalThis as { document?: Document }).document;
    const c = doc?.createElement('canvas').getContext('2d');
    if (c) return c;
    const OC = (globalThis as { OffscreenCanvas?: typeof OffscreenCanvas }).OffscreenCanvas;
    return OC ? (new OC(8, 8).getContext('2d') as unknown as MeasureContext | null) : null;
  } catch {
    return null;
  }
}

/** Ink aspect (width / height) of U+300C in `family`, or null without ink metrics. */
function bracketAspect(g: MeasureContext, family: string, style: { fontWeight?: string; fontStyle?: string }): number | null {
  g.font = `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight ?? 400} 100px "${family}"`;
  const m = g.measureText('「');
  const w = (m.actualBoundingBoxLeft ?? NaN) + (m.actualBoundingBoxRight ?? NaN);
  const h = (m.actualBoundingBoxAscent ?? NaN) + (m.actualBoundingBoxDescent ?? NaN);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? w / h : null;
}

/** Exported for tests: does `alias` draw 「 in its vertical form where `plain` does not? */
export function probeVerticalAlternates(
  alias: string,
  plain: string,
  style: { fontWeight?: string; fontStyle?: string },
  ctx: MeasureContext | null = probeContext(),
): boolean {
  if (!ctx) return false;
  const vert = bracketAspect(ctx, alias, style);
  const horiz = bracketAspect(ctx, plain, style);
  return vert !== null && horiz !== null && horiz < 1 && vert > 1;
}

/** Test hook. */
export function resetFontVariantsForTest(): void {
  entries.clear();
  vertProbes.clear();
  byteEntries.clear();
  registeredBytes.clear();
  epoch = 0;
}
