/**
 * Plugin importers — reading a file format the editor cannot.
 *
 * The mirror of `exporters.test.ts`, and the interesting cases are the same
 * shape: what a plugin may CLAIM, and what it is handed. A plugin never opens a
 * file — it is given the bytes of one the user themselves chose, and only for
 * an extension it declared.
 */

import { parseManifest, MANIFEST_VERSION } from './manifest';
import { parseImporters, MAX_IMPORTERS_PER_PLUGIN, MAX_EXTENSIONS_PER_IMPORTER } from './importerSchema';
import { pluginImporters, pluginImporterForFile } from '@core/assets/pluginImporters';
import { usePluginStore } from '@stores/pluginStore';

const BASE = {
  id: 'com.example.read',
  name: 'Readers',
  version: '1.0.0',
  description: 'Reads a format.',
  main: 'main.js',
  permissions: [],
};

const one = (over: Record<string, unknown> = {}) =>
  [{ id: 'tga', label: 'Truevision TGA', extensions: ['tga'], ...over }];

function parse(importers: unknown, apiVersion = MANIFEST_VERSION) {
  return parseManifest({ ...BASE, apiVersion, contributes: { importers } });
}

describe('declaring an importer', () => {
  it('accepts one', () => {
    const { manifest, errors } = parse(one());
    expect(errors).toEqual([]);
    expect(manifest?.contributes.importers).toEqual([
      { id: 'tga', label: 'Truevision TGA', extensions: ['tga'] },
    ]);
  });

  it('accepts several extensions for one importer', () => {
    const { manifest, errors } = parse(one({ extensions: ['tga', 'vda', 'icb'] }));
    expect(errors).toEqual([]);
    expect(manifest?.contributes.importers[0]!.extensions).toEqual(['tga', 'vda', 'icb']);
  });

  it('requires the grammar that introduced it', () => {
    expect(parse(one(), 5).errors.join(' ')).toMatch(/requires "apiVersion": 6/);
  });

  it('still accepts an EMPTY block on the older grammar', () => {
    expect(parse([], 5).errors).toEqual([]);
  });

  it('★ refuses a format the editor already reads', () => {
    // Not a race the host would lose — built-ins are matched first. A plugin
    // shadowing `.png` turns a working import into a plugin bug the user has
    // no reason to suspect.
    for (const ext of ['png', 'mp4', 'psd', 'svg', 'wav', 'json']) {
      expect(parse(one({ extensions: [ext] })).errors.join(' ')).toMatch(/already reads/);
    }
  });

  it('refuses an extension with a dot or capitals', () => {
    for (const ext of ['.tga', 'TGA', 'tg/a', '']) {
      expect(parse(one({ extensions: [ext] })).errors.join(' ')).toMatch(/extensions/);
    }
  });

  it('refuses an empty extension list — an importer claiming nothing', () => {
    expect(parse(one({ extensions: [] })).errors.join(' ')).toMatch(/non-empty array/);
  });

  it('refuses two importers claiming one extension', () => {
    const dup = [
      { id: 'a', label: 'A', extensions: ['zzz'] },
      { id: 'b', label: 'B', extensions: ['zzz'] },
    ];
    expect(parse(dup).errors.join(' ')).toMatch(/claims \.zzz twice|claims "\.zzz" twice|\.zzz/);
  });

  it('refuses more than the per-plugin and per-importer limits', () => {
    const many = Array.from({ length: MAX_IMPORTERS_PER_PLUGIN + 1 }, (_, i) => ({
      id: `i${i}`, label: `I${i}`, extensions: [`x${i}`],
    }));
    expect(parse(many).errors.join(' ')).toMatch(/the limit is 4/);

    const wide = one({ extensions: Array.from({ length: MAX_EXTENSIONS_PER_IMPORTER + 1 }, (_, i) => `q${i}`) });
    expect(parse(wide).errors.join(' ')).toMatch(/the limit is 8/);
  });

  it('reports rather than throws on a malformed entry', () => {
    const errors: string[] = [];
    expect(parseImporters([42], 'contributes.importers', errors)).toEqual([]);
    expect(errors.join(' ')).toMatch(/must be an object/);
  });
});

describe('claiming a file', () => {
  const install = (enabled: boolean, extensions = ['tga']) => {
    usePluginStore.setState({
      plugins: [{
        enabled,
        granted: ['import:files'],
        manifest: parse(one({ extensions })).manifest!,
      }],
    } as never);
  };

  afterEach(() => usePluginStore.setState({ plugins: [] } as never));

  it('matches by extension, case-insensitively', () => {
    install(true);
    expect(pluginImporterForFile('shot.tga')?.importerId).toBe('tga');
    expect(pluginImporterForFile('SHOT.TGA')?.importerId).toBe('tga');
  });

  it('claims nothing it did not declare', () => {
    install(true);
    expect(pluginImporterForFile('shot.png')).toBeNull();
    expect(pluginImporterForFile('noextension')).toBeNull();
    expect(pluginImporterForFile('trailing.')).toBeNull();
  });

  it('★ a DISABLED plugin claims nothing', () => {
    // Otherwise dropping a file would start an import that then refuses,
    // after the user already believes it is happening.
    install(false);
    expect(pluginImporters()).toEqual([]);
    expect(pluginImporterForFile('shot.tga')).toBeNull();
  });
});
