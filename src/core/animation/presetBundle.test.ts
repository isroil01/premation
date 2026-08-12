/**
 * Preset export / import — the round trip, and the files that are not ours.
 *
 * Presets are the one thing users hand to each other, so the interesting cases
 * are not the round trip (which either works or obviously does not) but what
 * happens when the file is hostile, stale, newer, or simply something else that
 * happened to be JSON. Each of those has a defined answer here rather than an
 * exception thrown somewhere far from the import.
 */

import {
  exportPresets,
  importPresets,
  PRESET_BUNDLE_FORMAT,
  PRESET_BUNDLE_VERSION,
  USER_PRESET_FOLDER,
  type AnimationPreset,
} from './animationPresets';
import { setCoreServiceRefs } from '@core/services/coreServices';

/** Presets persist through SettingsManager; this is the smallest thing that is one. */
function stubSettings(): { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  setCoreServiceRefs({
    settings: {
      get: <T>(k: string, fallback: T): T => (store.has(k) ? (store.get(k) as T) : fallback),
      set: <T>(k: string, v: T): void => { store.set(k, v); },
    },
  } as unknown as Parameters<typeof setCoreServiceRefs>[0]);
  return { store };
}

const preset = (name: string, extra: Partial<AnimationPreset> = {}): AnimationPreset =>
  ({ name, tracks: [{ prop: 'x', keyframes: [] }], ...extra } as unknown as AnimationPreset);

const bundleOf = (presets: unknown[], version = PRESET_BUNDLE_VERSION): string =>
  JSON.stringify({ format: PRESET_BUNDLE_FORMAT, version, presets });

describe('preset bundles', () => {
  let store: Map<string, unknown>;
  beforeEach(() => { ({ store } = stubSettings()); });

  const seed = (...p: AnimationPreset[]): void => { store.set('animationPresets', p); };
  const saved = (): AnimationPreset[] => (store.get('animationPresets') as AnimationPreset[]) ?? [];

  it('round-trips a preset through export and import', () => {
    seed(preset('Fade Up'));
    const json = exportPresets();
    store.set('animationPresets', []);
    const r = importPresets(json);
    expect(r.added).toEqual(['Fade Up']);
    expect(saved().map((p) => p.name)).toEqual(['Fade Up']);
  });

  it('exports only the named subset when asked', () => {
    seed(preset('A'), preset('B'), preset('C'));
    const only = JSON.parse(exportPresets(['A', 'C'])) as { presets: AnimationPreset[] };
    expect(only.presets.map((p) => p.name)).toEqual(['A', 'C']);
  });

  it('never exports built-ins', () => {
    // They ship with the app. A bundle carrying one duplicates it on import,
    // and pins a stale copy of a preset that may since have been improved.
    seed(preset('Mine'), preset('Stock', { builtin: true }));
    const b = JSON.parse(exportPresets()) as { presets: AnimationPreset[] };
    expect(b.presets.map((p) => p.name)).toEqual(['Mine']);
  });

  it('overwrites by name, the same rule saving already uses', () => {
    // `saveCurrentAsPreset` replaces a same-named preset rather than
    // accumulating duplicates. An import that appended instead would make the
    // library's identity depend on how an entry got there.
    seed(preset('Fade Up', { description: 'old' }));
    const r = importPresets(bundleOf([preset('Fade Up', { description: 'new' })]));
    expect(r.replaced).toEqual(['Fade Up']);
    expect(r.added).toEqual([]);
    expect(saved()).toHaveLength(1);
    expect(saved()[0]!.description).toBe('new');
  });

  it('strips `builtin` off anything imported', () => {
    // A file can claim anything. A preset arriving marked built-in would be
    // undeletable through the panel and would shadow a real one.
    importPresets(bundleOf([preset('Trojan', { builtin: true })]));
    expect(saved()[0]!.builtin).toBeUndefined();
  });

  it('files a folderless preset under User Presets', () => {
    importPresets(bundleOf([preset('Loose')]));
    expect(saved()[0]!.folder).toBe(USER_PRESET_FOLDER);
  });

  it('keeps the sender’s folder when it has one', () => {
    importPresets(bundleOf([preset('Filed', { folder: 'Text/Animate In' })]));
    expect(saved()[0]!.folder).toBe('Text/Animate In');
  });

  describe('files that are not ours', () => {
    it('rejects malformed JSON without throwing', () => {
      expect(importPresets('{ not json').error).toMatch(/valid JSON/i);
    });

    it('rejects JSON that is not a preset bundle', () => {
      // The likeliest wrong file is another of the app's own exports.
      expect(importPresets(JSON.stringify({ layers: [] })).error).toMatch(/not a premation preset bundle/i);
    });

    it('refuses a bundle from a NEWER build rather than half-reading it', () => {
      // A newer bundle may carry fields whose absence changes behaviour, so
      // importing the subset this build understands yields a preset that is
      // wrong rather than one that is missing.
      const r = importPresets(bundleOf([preset('Future')], PRESET_BUNDLE_VERSION + 1));
      expect(r.error).toMatch(/newer than this build/i);
      expect(saved()).toEqual([]);
    });

    it('accepts an OLDER bundle', () => {
      expect(importPresets(bundleOf([preset('Vintage')], PRESET_BUNDLE_VERSION - 1)).added).toEqual(['Vintage']);
    });

    it('drops unusable entries and imports the rest, reporting both', () => {
      const r = importPresets(bundleOf([
        preset('Good'),
        { name: '', tracks: [] },      // no name
        { name: 'No tracks' },          // no tracks array
        null,
      ]));
      expect(r.added).toEqual(['Good']);
      expect(r.rejected).toBe(3);
      expect(saved().map((p) => p.name)).toEqual(['Good']);
    });

    it('writes NOTHING when a bundle contains no usable preset', () => {
      seed(preset('Existing'));
      const r = importPresets(bundleOf([{ garbage: true }]));
      expect(r.error).toMatch(/no usable presets/i);
      expect(saved().map((p) => p.name)).toEqual(['Existing']); // untouched
    });
  });

  it('exports valid JSON ending in a newline', () => {
    seed(preset('A'));
    const json = exportPresets();
    expect(json.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
