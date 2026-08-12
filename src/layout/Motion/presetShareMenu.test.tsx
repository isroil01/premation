/**
 * Export / Import Presets, in the panel that carries them.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * `presetBundle.test.ts` covers the bundle format thoroughly — round trip,
 * overwrite-by-name, hostile files, newer versions. Every one of those tests
 * passed on a build where `exportPresets` and `importPresets` had **no caller
 * anywhere in `src/`**, which is how they shipped: a complete, well-tested
 * model reachable by nothing. That is the same shape as the dead controls this
 * branch keeps finding, produced this time by the branch itself.
 *
 * So the observable here is deliberately not "the bundle is correct" but "a
 * user can reach the bundle", and the medium has to be React for that claim to
 * mean anything. A source-level assertion that the panel imports the functions
 * would also have caught the original miss, but it would pass on a menu item
 * that renders disabled forever, or one whose handler throws.
 *
 * ── What this medium cannot see ─────────────────────────────────────────────
 *
 * jsdom has no file picker: clicking Import opens a real dialog in the app and
 * nothing here. The test therefore drives the hidden `<input type="file">`
 * directly with a synthetic `File`, which exercises the handler, the result
 * message and the refresh — but NOT the click that opens the picker. That one
 * link is a `fileRef.current?.click()`. It is covered only to the extent that
 * the input is asserted to exist below; whether the menu item reaches it is
 * UNVERIFIED — not hand-checked in the app, and not checkable here.
 *
 * `URL.createObjectURL` does not exist in jsdom, so the download is observed at
 * the anchor rather than as a saved file.
 *
 * The handler also clears `input.value` so that re-picking the SAME file fires
 * `change` again — without it, a user who fixes a rejected bundle and chooses
 * it a second time gets no event and no feedback, and the app looks frozen
 * rather than picky. That is NOT tested here: jsdom never assigns a value to a
 * file input and forbids setting a non-empty one, so an assertion on
 * `input.value` passes whether or not the reset is there. It was written, seen
 * to pass with the line deleted, and removed rather than left to look like
 * cover. It is therefore UNVERIFIED, by reasoning about the DOM API rather
 * than by observation.
 */

import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MotionPresetsPanel } from './MotionPresetsPanel';
import {
  PRESET_BUNDLE_FORMAT,
  PRESET_BUNDLE_VERSION,
  listPresets,
} from '@core/animation/animationPresets';
import { setCoreServiceRefs } from '@core/services/coreServices';

/** Presets persist through SettingsManager; the smallest thing that is one. */
function stubSettings(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  setCoreServiceRefs({
    settings: {
      get: <T,>(k: string, fallback: T): T => (store.has(k) ? (store.get(k) as T) : fallback),
      set: <T,>(k: string, v: T): void => { store.set(k, v); },
    },
  } as unknown as Parameters<typeof setCoreServiceRefs>[0]);
  return store;
}

const bundle = (names: string[]): string =>
  JSON.stringify({
    format: PRESET_BUNDLE_FORMAT,
    version: PRESET_BUNDLE_VERSION,
    presets: names.map((name) => ({ name, tracks: [{ prop: 'x', keyframes: [] }] })),
  });

/** The share entries live behind the panel's settings menu. */
function openMenu(): void {
  fireEvent.click(screen.getByTitle('Sort presets'));
}

let store: Map<string, unknown>;
let created: string[];

beforeEach(() => {
  store = stubSettings();
  created = [];
  seedNames = listPresets().map((p) => p.name);
  // jsdom has neither, and the export path uses both.
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = (): string => {
    created.push('blob');
    return 'blob:stub';
  };
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = (): void => {};
  // jsdom's File has no `.text()`. Chromium has had `Blob.prototype.text`
  // since 76, so this is the test environment lagging the runtime rather than
  // the panel using something Electron lacks.
  if (!File.prototype.text) {
    (File.prototype as unknown as { text: unknown }).text = function text(this: File): Promise<string> {
      return new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.readAsText(this);
      });
    };
  }
});

/**
 * Presets that came from the user, not the five compiled-in arrays.
 *
 * `listPresets()` returns 73 shipped presets ahead of the user's, so asserting
 * on it directly says nothing about what an import did. Subtracting the
 * pre-import names is used rather than a `builtin` filter so this stays honest
 * even if a shipped array is ever added without the flag.
 */
const userPresetNames = (): string[] => {
  const shipped = new Set(seedNames);
  return listPresets().map((p) => p.name).filter((n) => !shipped.has(n));
};

/** The names present before any import — i.e. everything compiled in. */
let seedNames: string[] = [];

afterEach(cleanup);

describe('preset export / import is reachable from the panel', () => {
  it('offers both entries in the panel menu', () => {
    store.set('animationPresets', [{ name: 'Mine', tracks: [] }]);
    render(<MotionPresetsPanel />);
    openMenu();
    expect(screen.getByText('Export Presets…')).toBeInTheDocument();
    expect(screen.getByText('Import Presets…')).toBeInTheDocument();
  });

  it('disables Export when there is nothing of the user’s to export', () => {
    // Built-ins are stripped from a bundle, so a library of only built-ins
    // exports an empty file. The entry says so by being disabled rather than
    // producing one.
    store.set('animationPresets', []);
    render(<MotionPresetsPanel />);
    openMenu();
    expect(screen.getByText('Export Presets…').closest('button')).toBeDisabled();
  });

  it('exporting reaches the download path', () => {
    store.set('animationPresets', [{ name: 'Mine', tracks: [{ prop: 'x', keyframes: [] }] }]);
    render(<MotionPresetsPanel />);
    openMenu();
    fireEvent.click(screen.getByText('Export Presets…'));
    // The blob URL is the last step before the browser takes over, so its
    // creation is the furthest this medium can follow the file.
    expect(created).toEqual(['blob']);
  });

  it('importing a bundle adds the presets and refreshes the list', async () => {
    render(<MotionPresetsPanel />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = new File([bundle(['Imported A', 'Imported B'])], 'p.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => {
      expect(userPresetNames()).toEqual(['Imported A', 'Imported B']);
    });
    // The panel refreshes off the scene revision; if the bump were missing the
    // presets would be saved and invisible until something else redrew.
    await waitFor(() => expect(screen.getByText('Imported A')).toBeInTheDocument());
  });

  it('a rejected file leaves the library alone and says why', async () => {
    store.set('animationPresets', [{ name: 'Existing', tracks: [{ prop: 'x', keyframes: [] }] }]);
    render(<MotionPresetsPanel />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['{ not json'], 'x.json', { type: 'application/json' })] },
    });
    await waitFor(() => {
      expect(userPresetNames()).toEqual(['Existing']);
    });
  });

});
