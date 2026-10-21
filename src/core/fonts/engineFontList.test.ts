/**
 * The font menu's list: what the engine draws, with each family's real weights.
 */

const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockListeners = new Set<(batch: { events: Array<{ type: string }> }) => void>();
jest.mock('@core/engine/engineInstance', () => ({
  engine: () => ({ execute: (c: unknown) => mockExecute(c), query: (q: unknown) => mockQuery(q) }),
  subscribeEngine: (l: (batch: { events: Array<{ type: string }> }) => void) => {
    mockListeners.add(l);
    return () => mockListeners.delete(l);
  },
}));

import {
  buildFamilies,
  cachedEngineFontList,
  fontFamilyInfo,
  loadEngineFontList,
  onEngineFontListReady,
  onInstalledFontsChanged,
  resetEngineFontListForTest,
  watchInstalledFonts,
} from './engineFontList';

const face = (style: string, weight: number, italic = false, wght: [number, number] | null = null) =>
  ({ style, postscriptName: '', weight, italic, wght, axes: wght ? [{ tag: 'wght', min: wght[0], default: weight, max: wght[1], hidden: false }] : [] });

afterEach(resetEngineFontListForTest);

describe('buildFamilies', () => {
  it('a variable face offers the hundreds on its wght axis, and nothing outside it', () => {
    const fams = buildFamilies([{ family: 'Lora', bundled: true, variable: true, face: face('Regular', 400, false, [400, 700]) }]);
    const lora = fams.get('Lora')!;
    expect(lora.weights).toEqual([400, 500, 600, 700]);
    expect(lora.faces.map((f) => f.style)).toEqual(['Regular', 'Medium', 'SemiBold', 'Bold']);
    expect(lora.axes).toEqual([{ tag: 'wght', min: 400, default: 400, max: 700, hidden: false }]);
  });

  it('static faces keep their own weights and style names', () => {
    const fams = buildFamilies([
      { family: 'Brand', bundled: false, variable: false, face: face('Bold Italic', 700, true) },
      { family: 'Brand', bundled: false, variable: false, face: face('Regular', 400) },
    ]);
    const brand = fams.get('Brand')!;
    expect(brand.weights).toEqual([400, 700]);
    expect(brand.faces.map((f) => f.style)).toEqual(['Regular', 'Bold Italic']);
  });

  it('a shipped family wins over an installed one of the same name (the engine draws the shipped faces)', () => {
    const fams = buildFamilies([
      { family: 'Roboto', bundled: false, variable: false, face: face('Black', 900) },
      { family: 'Roboto', bundled: true, variable: true, face: face('Regular', 400, false, [100, 900]) },
    ]);
    expect(fams.get('Roboto')!.bundled).toBe(true);
    expect(fams.get('Roboto')!.weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });
});

describe('the shipped families', () => {
  it('answer before the engine does, with their real ranges', () => {
    expect(fontFamilyInfo('Inter')?.weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(fontFamilyInfo('Fira Code')?.weights).toEqual([300, 400, 500, 600, 700]);
    expect(fontFamilyInfo('Bebas Neue')?.weights).toEqual([400]);
    expect(fontFamilyInfo('Poppins')?.faces.some((f) => f.style === 'Bold Italic')).toBe(true);
    expect(fontFamilyInfo('Not A Font')).toBeUndefined();
  });
});

describe('fonts installed or removed while the editor runs', () => {
  const installed = (family: string) => ({
    family, style: 'Regular', postScriptName: `${family}-Regular`, weight: 400, italic: false, variableAxes: [], scripts: ['Latn'], path: '',
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    mockExecute.mockReset().mockResolvedValue({ ok: true, value: { changed: false } });
    mockQuery.mockReset();
    mockListeners.clear();
  });

  it('asks the engine to re-read them when the window regains focus, at most once per burst', () => {
    const stop = watchInstalledFonts();
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({ type: 'refreshFonts' });
    stop();
    window.dispatchEvent(new Event('focus'));
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('on fontsChanged, drops what was derived from the old list and loads the new one', async () => {
    mockQuery.mockResolvedValueOnce({ ok: true, value: { fonts: [installed('Cormorant')] } });
    await loadEngineFontList();
    expect(cachedEngineFontList()?.has('Cormorant')).toBe(true);

    const stop = watchInstalledFonts();
    const changed = jest.fn();
    const ready = jest.fn();
    const offChanged = onInstalledFontsChanged(changed);
    const offReady = onEngineFontListReady(ready);
    mockQuery.mockResolvedValueOnce({ ok: true, value: { fonts: [installed('Garamond')] } });
    for (const l of mockListeners) l({ events: [{ type: 'fontsChanged' }] });
    expect(changed).toHaveBeenCalledTimes(1);
    await settle();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(cachedEngineFontList()?.has('Cormorant')).toBe(false);
    expect(cachedEngineFontList()?.has('Garamond')).toBe(true);
    // Other events leave the list alone.
    for (const l of mockListeners) l({ events: [{ type: 'playheadChanged' }] });
    expect(changed).toHaveBeenCalledTimes(1);
    offChanged();
    offReady();
    stop();
  });
});
