/**
 * Variable-font axes: `fvar` parsing, the variation string (legacy output held
 * byte-identical), the alias-face feature string, and scene resolution.
 */

import { parseFvarAxes, hasVariableAxes } from './variableFontProbe';
import {
  fontVariationString,
  axisPropPath,
  parseAxisPropPath,
  resolveFontAxes,
  sanitizeAxes,
  isAxisTag,
} from './fontAxes';
import { featureSettingsString } from './fontFaceVariants';
import type { SceneNode } from '@core/types';

/** A minimal sfnt: a table directory with one `fvar`, and the table itself. */
function fontWithFvar(axes: Array<{ tag: string; min: number; def: number; max: number; hidden?: boolean }>): ArrayBuffer {
  const dirLen = 12 + 16;
  const fvarLen = 16 + axes.length * 20;
  const buf = new ArrayBuffer(dirLen + fvarLen);
  const v = new DataView(buf);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, 1);
  const tag = (s: string): number => (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);
  v.setUint32(12, tag('fvar'));
  v.setUint32(12 + 8, dirLen);
  v.setUint32(12 + 12, fvarLen);
  const t = dirLen;
  v.setUint16(t, 1);
  v.setUint16(t + 4, 16); // axesArrayOffset
  v.setUint16(t + 8, axes.length);
  v.setUint16(t + 10, 20);
  axes.forEach((a, i) => {
    const at = t + 16 + i * 20;
    v.setUint32(at, tag(a.tag) >>> 0);
    v.setInt32(at + 4, Math.round(a.min * 65536));
    v.setInt32(at + 8, Math.round(a.def * 65536));
    v.setInt32(at + 12, Math.round(a.max * 65536));
    v.setUint16(at + 16, a.hidden ? 1 : 0);
  });
  return buf;
}

describe('fvar axis parsing', () => {
  it('reads tag / min / default / max / hidden for every axis', () => {
    const buf = fontWithFvar([
      { tag: 'wght', min: 100, def: 400, max: 900 },
      { tag: 'slnt', min: -12.5, def: 0, max: 0 },
      { tag: 'GRAD', min: -200, def: 0, max: 150, hidden: true },
    ]);
    expect(hasVariableAxes(buf)).toBe(true);
    expect(parseFvarAxes(buf)).toEqual([
      { tag: 'wght', min: 100, default: 400, max: 900, hidden: false },
      { tag: 'slnt', min: -12.5, default: 0, max: 0, hidden: false },
      { tag: 'GRAD', min: -200, default: 0, max: 150, hidden: true },
    ]);
  });

  it('a static font or a truncated buffer has no axes', () => {
    expect(parseFvarAxes(new ArrayBuffer(8))).toEqual([]);
    const buf = fontWithFvar([{ tag: 'wght', min: 1, def: 400, max: 1000 }]);
    expect(parseFvarAxes(buf.slice(0, 40))).toEqual([]);
  });
});

describe('variation string', () => {
  it('is byte-identical to the legacy wght/wdth/slnt output when no new axis is used', () => {
    const legacy = (w?: string, wd?: number, sl?: number): string | undefined => {
      const parts: string[] = [];
      const n = w !== undefined ? Number(w) : NaN;
      if (Number.isFinite(n)) parts.push(`'wght' ${n}`);
      if (wd !== undefined) parts.push(`'wdth' ${wd}`);
      if (sl !== undefined) parts.push(`'slnt' ${sl}`);
      return parts.length ? parts.join(', ') : undefined;
    };
    for (const [w, wd, sl] of [['600', undefined, undefined], ['350', 87.5, -8], [undefined, 120, undefined], [undefined, undefined, undefined]] as const) {
      expect(fontVariationString({ fontWeight: w, fontWidth: wd, fontSlant: sl })).toBe(legacy(w, wd, sl));
    }
  });

  it('appends other tags sorted, and applies per-glyph offsets', () => {
    expect(fontVariationString({ fontWeight: '400', fontAxes: { opsz: 24, GRAD: -50 } })).toBe(`'wght' 400, 'GRAD' -50, 'opsz' 24`);
    expect(fontVariationString({ fontWeight: '400', fontWidth: 100 }, { wght: 100, wdth: -25, GRAD: 20 }))
      .toBe(`'wght' 500, 'wdth' 75, 'GRAD' 20`);
    // An offset on an unset axis starts from the registered default.
    expect(fontVariationString({}, { opsz: 4 })).toBe(`'opsz' 16`);
  });
});

describe('axis storage + paths', () => {
  it('wght / wdth / slnt keep their legacy props; every other tag is text.axis.<tag>', () => {
    expect(axisPropPath('wdth')).toBe('fontWidth');
    expect(axisPropPath('wght')).toBe('fontWeight');
    expect(axisPropPath('GRAD')).toBe('text.axis.GRAD');
    expect(parseAxisPropPath('text.axis.opsz')).toBe('opsz');
    expect(parseAxisPropPath('text.axis.op')).toBeNull();
    expect(isAxisTag('ab c')).toBe(false);
  });

  it('sanitizes stored maps and resolves animated tracks over static values', () => {
    expect(sanitizeAxes({ GRAD: 1, wdth: 90, 'bad!': 2, opsz: 'x' })).toEqual({ GRAD: 1 });
    const node = { id: 'n', components: [{ id: 'c', type: 'Text', props: { content: 'A', fontAxes: { GRAD: 10 } } }] } as unknown as SceneNode;
    expect(resolveFontAxes(node, undefined)).toEqual({ GRAD: 10 });
    expect(resolveFontAxes(node, new Map([['text.axis.GRAD', 40], ['text.axis.opsz', 18], ['fontWidth', 80]]))).toEqual({ GRAD: 40, opsz: 18 });
    const plain = { id: 'p', components: [{ id: 'c', type: 'Text', props: { content: 'A' } }] } as unknown as SceneNode;
    expect(resolveFontAxes(plain, new Map())).toBeUndefined();
  });
});

describe('OpenType feature string', () => {
  it('is undefined at defaults and deterministic otherwise', () => {
    expect(featureSettingsString({})).toBeUndefined();
    expect(featureSettingsString({ ligatures: false, discretionaryLigatures: true, contextualAlternates: false, stylisticSets: [3, 1, 3, 25] }))
      .toBe(`'liga' 0, 'clig' 0, 'dlig' 1, 'calt' 0, 'ss01' 1, 'ss03' 1`);
  });
});
