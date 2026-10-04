import type { SceneNode } from '@core/types';

import { collectFontUsage, findMissingFonts, missingFontsMessage, primaryFamily } from './missingFonts';
import { makeFontAvailability } from './fontAvailability';
import { SCENE_KIND_PROP } from '@core/scene/sceneKind';

function node(id: string, kind: string, text: Record<string, unknown> = {}): SceneNode {
  return {
    id,
    name: `Layer ${id}`,
    parent: 'root',
    children: [],
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    visible: true,
    locked: false,
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind } },
      { id: `${id}_c`, type: 'Text', props: text },
    ],
  } as unknown as SceneNode;
}

const nodes = [
  node('a', 'text', { content: 'A', fontFamily: 'Brand Sans' }),
  node('b', 'text', {
    content: 'Hello',
    fontFamily: '"Inter", sans-serif',
    __runs: [{ start: 0, end: 2, style: { fontFamily: 'brand sans' } }, { start: 2, end: 3, style: { fontFamily: 'Gone Serif' } }],
    __runsIndex: 'grapheme',
  }),
  node('c', 'text', { content: 'No family prop' }),
  node('d', 'shape', { fontFamily: 'Not Text' }),
  node('e', 'text', { content: 'x', fontFamily: 'monospace' }),
];

describe('collectFontUsage', () => {
  it('counts layer families AND run families, once per layer, case-insensitively', () => {
    const usage = collectFontUsage(nodes);
    expect(usage.map((u) => u.family)).toEqual(['Brand Sans', 'Gone Serif', 'Inter', 'monospace']);
    expect(usage[0]!.layers).toEqual([
      { id: 'a', name: 'Layer a', inRuns: false },
      { id: 'b', name: 'Layer b', inRuns: true },
    ]);
  });

  it('primaryFamily unquotes the first family of a stack', () => {
    expect(primaryFamily('"Brand Sans", Arial, sans-serif')).toBe('Brand Sans');
    expect(primaryFamily("'X'")).toBe('X');
  });
});

describe('findMissingFonts', () => {
  it('reports only unavailable, non-generic families', () => {
    const available = new Set(['inter', 'monospace']);
    const missing = findMissingFonts(nodes, (f) => available.has(f.toLowerCase()));
    expect(missing.map((m) => m.family)).toEqual(['Brand Sans', 'Gone Serif']);
    // A generic family is never reported, whatever the checker says.
    expect(findMissingFonts(nodes, () => false).map((m) => m.family)).not.toContain('monospace');
    expect(missingFontsMessage(2)).toBe('2 fonts missing');
    expect(missingFontsMessage(1)).toBe('1 font missing');
  });
});

describe('makeFontAvailability — the evidence order', () => {
  const none = { localFamilies: null, loadedFamilies: new Set<string>(), measure: () => undefined };

  it('web-safe, document web fonts and generics are always available', () => {
    const ok = makeFontAvailability({ ...none, localFamilies: new Set(), measure: () => false });
    expect(ok('Arial')).toBe(true);
    expect(ok('Playfair Display')).toBe(true);
    expect(ok('serif')).toBe(true);
  });

  it('an authoritative local list decides when the canvas cannot find it', () => {
    const check = makeFontAvailability({ ...none, localFamilies: new Set(['brand sans']), measure: () => false });
    expect(check('Brand Sans')).toBe(true);
    expect(check('Gone Serif')).toBe(false);
  });

  it('loaded web fonts and a canvas hit count; with no evidence at all it assumes available', () => {
    expect(makeFontAvailability({ ...none, loadedFamilies: new Set(['webby']) })('Webby')).toBe(true);
    expect(makeFontAvailability({ ...none, measure: () => true })('Anything')).toBe(true);
    expect(makeFontAvailability({ ...none, measure: () => false })('Anything')).toBe(false);
    expect(makeFontAvailability(none)('Anything')).toBe(true);
  });
});
