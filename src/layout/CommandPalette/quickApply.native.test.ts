/**
 * Quick Apply — effects and presets reachable from the palette.
 *
 * The claim under test: typing a few letters of an effect applies it to the
 * selection on Enter, for every selected layer, and a preset that cannot act
 * on the selection says so up front instead of applying and doing nothing.
 */

import { useSelectionStore } from '@stores/selectionStore';
import { effectHits, presetHits } from './quickApply';
import { parseQuery } from './paletteSearch';
import { setupAppEngine, historyLabels, settleEdits } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { buildScene } from '@core/engine/__testHelpers__/scene';

beforeEach(() => {
  useSelectionStore.getState().set([]);
});

describe('mode prefixes', () => {
  it('route + to effects and * to presets', async () => {
    expect(parseQuery('+glow')).toEqual({ mode: 'effects', term: 'glow' });
    expect(parseQuery('* fade')).toEqual({ mode: 'presets', term: 'fade' });
  });
});

describe('effects', () => {
  it('finds an effect by a few letters and files it under its folder', async () => {
    const hits = effectHits('gaus', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.label).toMatch(/Gaussian/i);
    expect(hits[0]!.hint).toBe('Blur & Sharpen');
  });

  it('is disabled with nothing selected, and applies to EVERY selected layer (one entry)', async () => {
    expect(effectHits('gaus', 1)[0]!.enabled).toBe(false);
    // The add goes through the engine (addEffect addresses layers).
    const h = await setupAppEngine();
    try {
      const s = await buildScene(h);
      useSelectionStore.getState().set([s.B, s.P]);
      const hit = effectHits('gaus', 1)[0]!;
      expect(hit.enabled).toBe(true);
      const before = (await historyLabels()).length;
      hit.apply();
      await settleEdits();
      expect((await docView()).getNodeEffects(s.B)).toHaveLength(1);
      expect((await docView()).getNodeEffects(s.P)).toHaveLength(1);
      expect((await historyLabels()).length).toBe(before + 1);
    } finally {
      await h.dispose();
    }
  });

  it('matches on the folder name as a fallback, ranked below label hits', async () => {
    const hits = effectHits('Blur & Sharpen', 40);
    expect(hits.every((h) => h.hint === 'Blur & Sharpen' || /blur|sharpen/i.test(h.label))).toBe(true);
  });
});

describe('presets', () => {
  it('marks a text-only preset disabled on a shape, enabled on text', async () => {
    // Layers of a composition, built through the engine: the fit reads the
    // document mirror's layer kinds (B4).
    const h = await setupAppEngine();
    try {
      const s = await buildScene(h);
      useSelectionStore.getState().set([s.B]);
      const onShape = presetHits('typewriter', 5).find((x) => /typewriter/i.test(x.label));
      useSelectionStore.getState().set([s.T]);
      const onText = presetHits('typewriter', 5).find((x) => /typewriter/i.test(x.label));
      // If the library carries no typewriter preset the assertion is vacuous —
      // guard so a renamed preset fails loudly instead of passing silently.
      expect(onShape && onText).toBeTruthy();
      expect(onShape!.enabled).toBe(false);
      expect(onText!.enabled).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it('applies a preset at the playhead through the engine (one undo entry) and leaves keyframes behind', async () => {
    // A LAYER of a composition: `applyPreset` addresses layers (B3).
    const h = await setupAppEngine();
    try {
      const s = await buildScene(h);
      useSelectionStore.getState().set([s.B]);
      const before = (await historyLabels()).length;
      const hit = presetHits('', 200).find((x) => x.enabled)!;
      expect(hit).toBeDefined();
      hit.apply();
      await settleEdits();
      expect((await docView()).tracksFor(s.B).length + (await docView()).dataTracksFor(s.B).length).toBeGreaterThan(0);
      expect((await historyLabels()).length).toBe(before + 1);
    } finally {
      await h.dispose();
    }
  });
});
