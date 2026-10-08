/**
 * Native plugin params of SDK 1.1 (plan P6) — the editor side of STRING,
 * GRADIENT and FILE (CURVE reuses the Curves effect's editor and form). Pure:
 * the controls live in src/layout/Effects/PluginParamControls.tsx.
 *
 *   text      a string
 *   gradient  `[[position, r, g, b, a], …]`, 0..1, straight colour
 *   file      a project item id ('' = none) — a `data` item (`importFiles` with `asData`)
 */

import type { Command } from '@motion/engine-api';

export interface GradientStop {
  position: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

const unit = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);

export const DEFAULT_GRADIENT: readonly GradientStop[] = [
  { position: 0, r: 0, g: 0, b: 0, a: 1 },
  { position: 1, r: 1, g: 1, b: 1, a: 1 },
];

/** The document's form → stops by position (the engine's reading: malformed stops dropped, none → black → white). */
export function gradientStops(value: unknown): GradientStop[] {
  const stops: GradientStop[] = [];
  if (Array.isArray(value)) {
    for (const s of value) {
      if (!Array.isArray(s) || s.length < 5 || !s.slice(0, 5).every((n) => typeof n === 'number')) continue;
      stops.push({ position: unit(s[0]), r: nonNeg(s[1]), g: nonNeg(s[2]), b: nonNeg(s[3]), a: nonNeg(s[4]) });
    }
  }
  if (stops.length === 0) return DEFAULT_GRADIENT.map((s) => ({ ...s }));
  return stops.sort((x, y) => x.position - y.position);
}

export function gradientValue(stops: readonly GradientStop[]): number[][] {
  return [...stops].sort((x, y) => x.position - y.position).map((s) => [s.position, s.r, s.g, s.b, s.a]);
}

const hex2 = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

/** `#rrggbb` of a stop (the colour input's form; alpha is separate). */
export function stopHex(s: GradientStop): string {
  return `#${hex2(s.r)}${hex2(s.g)}${hex2(s.b)}`;
}

/** A stop with `#rrggbb` as its colour (alpha kept); unchanged for anything else. */
export function withHex(s: GradientStop, hex: string): GradientStop {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return s;
  return { ...s, r: parseInt(m[1]!, 16) / 255, g: parseInt(m[2]!, 16) / 255, b: parseInt(m[3]!, 16) / 255 };
}

/** A CSS preview of the stops. */
export function gradientCss(stops: readonly GradientStop[]): string {
  const parts = stops.map((s) => `rgba(${Math.round(Math.min(1, s.r) * 255)}, ${Math.round(Math.min(1, s.g) * 255)}, ${Math.round(Math.min(1, s.b) * 255)}, ${Math.min(1, s.a)}) ${Math.round(s.position * 1000) / 10}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/** A new stop halfway into the widest gap, coloured as the gradient there. */
export function addStop(stops: readonly GradientStop[]): GradientStop[] {
  const s = [...stops].sort((x, y) => x.position - y.position);
  if (s.length === 0) return DEFAULT_GRADIENT.map((x) => ({ ...x }));
  let at = 0;
  let gap = -1;
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i + 1]!.position - s[i]!.position > gap) {
      gap = s[i + 1]!.position - s[i]!.position;
      at = i;
    }
  }
  if (s.length === 1) return [...s, { ...s[0]!, position: s[0]!.position < 0.5 ? 1 : 0 }].sort((x, y) => x.position - y.position);
  const a = s[at]!;
  const b = s[at + 1]!;
  const mid: GradientStop = {
    position: (a.position + b.position) / 2,
    r: (a.r + b.r) / 2,
    g: (a.g + b.g) / 2,
    b: (a.b + b.b) / 2,
    a: (a.a + b.a) / 2,
  };
  return [...s.slice(0, at + 1), mid, ...s.slice(at + 1)];
}

/** `"cube|3dl"` → `['cube', '3dl']` ('' = any). */
export function fileTypeList(types: string | undefined): string[] {
  return (types ?? '').split('|').map((t) => t.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
}

/** Does `name` have one of `types`' extensions ('' = any)? */
export function fileTypeMatches(name: string, types: string | undefined): boolean {
  const list = fileTypeList(types);
  if (list.length === 0) return true;
  const dot = name.lastIndexOf('.');
  return dot >= 0 && list.includes(name.slice(dot + 1).toLowerCase());
}

/** Import a picked file for a FILE param: a `data` item, never probed as footage. */
export function importForFileParam(path: string): Command {
  return { type: 'importFiles', files: [{ path, asSequence: false, createComposition: false, asData: true }] };
}
