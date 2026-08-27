/**
 * Plugin exporters — a plugin that writes a file format the editor does not
 * know.
 *
 * Three things are worth pinning and they are not the happy path:
 *
 *   • The extension a plugin may claim. A `.mp4` a plugin produced is a file
 *     whose contents its name does not predict, and the failure lands wherever
 *     the user takes it next.
 *   • The permission. To encode a composition a plugin sees every rendered
 *     pixel of it — strictly more than `assets:read` — so the gate has to be at
 *     the one door frames pass through, not in the worker→host call table that
 *     an export never touches.
 *   • That the two version numbers finally moved apart. `contributes.exporters`
 *     is a manifest KEY, so the grammar bumped and the host method surface did
 *     not.
 */

import { parseManifest, MANIFEST_VERSION, HOST_API_VERSION } from './manifest';
import { parseExporters, MAX_EXPORTERS_PER_PLUGIN } from './exporterSchema';
import {
  pluginFormatId,
  parsePluginFormat,
  isPluginFormat,
  pluginExporters,
  pluginExporterFor,
} from '@core/export/pluginExporters';
import { usePluginStore } from '@stores/pluginStore';

const BASE = {
  id: 'com.example.fmt',
  name: 'Formats',
  version: '1.0.0',
  description: 'Writes a format.',
  main: 'main.js',
  permissions: [],
};

const one = (over: Record<string, unknown> = {}) => [{ id: 'webp', label: 'Animated WebP', extension: 'webp', ...over }];

function parse(exporters: unknown, apiVersion = MANIFEST_VERSION) {
  return parseManifest({ ...BASE, apiVersion, contributes: { exporters } });
}

describe('declaring an exporter', () => {
  it('accepts one', () => {
    const { manifest, errors } = parse(one());
    expect(errors).toEqual([]);
    expect(manifest?.contributes.exporters).toEqual([
      { id: 'webp', label: 'Animated WebP', extension: 'webp' },
    ]);
  });

  it('requires the grammar that introduced it', () => {
    const { errors } = parse(one(), 5);
    expect(errors.join(' ')).toMatch(/requires "apiVersion": 6/);
  });

  it('still accepts an EMPTY block on the older grammar', () => {
    // A package that declared nothing was valid before this shipped and stays
    // valid — the same back-compat rule `layerKinds` and `effects` follow.
    expect(parse([], 5).errors).toEqual([]);
  });

  it('★ refuses an extension the editor writes itself', () => {
    // Not about collision — the host's formats are matched first, so a
    // duplicate would never be reached. It is about what the user believes
    // they exported.
    for (const ext of ['mp4', 'png', 'wav', 'gif']) {
      const { errors } = parse(one({ extension: ext }));
      expect(errors.join(' ')).toMatch(/the editor writes itself/);
    }
  });

  it('refuses an extension with a dot, a slash or capitals', () => {
    for (const ext of ['.webp', 'we/bp', 'WEBP', '']) {
      expect(parse(one({ extension: ext })).errors.join(' ')).toMatch(/extension/);
    }
  });

  it('★ refuses an id with a dot, because the host joins on dots', () => {
    // `plugin:<pluginId>.<exporterId>` is split on the LAST dot. An exporter id
    // containing one would make that split ambiguous.
    expect(parse(one({ id: 'my.fmt' })).errors.join(' ')).toMatch(/no dots/);
  });

  it('refuses two exporters under one id, and two writing one extension', () => {
    const dupId = [
      { id: 'a', label: 'A', extension: 'aaa' },
      { id: 'a', label: 'B', extension: 'bbb' },
    ];
    expect(parse(dupId).errors.join(' ')).toMatch(/declares "a" twice/);

    const dupExt = [
      { id: 'a', label: 'A', extension: 'aaa' },
      { id: 'b', label: 'B', extension: 'aaa' },
    ];
    expect(parse(dupExt).errors.join(' ')).toMatch(/two exporters writing/);
  });

  it('refuses more than the per-plugin limit', () => {
    const many = Array.from({ length: MAX_EXPORTERS_PER_PLUGIN + 1 }, (_, i) => ({
      id: `e${i}`, label: `E${i}`, extension: `e${i}x`,
    }));
    expect(parse(many).errors.join(' ')).toMatch(/the limit is 4/);
  });

  it('reports rather than throws on a malformed entry', () => {
    const errors: string[] = [];
    expect(parseExporters(['nope'], 'contributes.exporters', errors)).toEqual([]);
    expect(errors.join(' ')).toMatch(/must be an object/);
  });
});

describe('the format id', () => {
  it('round-trips a reverse-DNS plugin id', () => {
    // The plugin id contains dots and the exporter id may not, so the LAST dot
    // is the separator and the split is unambiguous.
    const id = pluginFormatId('studio.acme.tools', 'webp');
    expect(id).toBe('plugin:studio.acme.tools.webp');
    expect(parsePluginFormat(id)).toEqual({ pluginId: 'studio.acme.tools', exporterId: 'webp' });
  });

  it('rejects anything that is not one', () => {
    for (const bad of ['mp4', 'plugin:', 'plugin:nodots', 'plugin:trailing.']) {
      expect(isPluginFormat(bad)).toBe(false);
    }
  });
});

describe('the registry', () => {
  const install = (enabled: boolean) => {
    usePluginStore.setState({
      plugins: [{
        enabled,
        granted: ['export:frames'],
        manifest: parse(one()).manifest!,
      }],
    } as never);
  };

  afterEach(() => usePluginStore.setState({ plugins: [] } as never));

  it('lists an installed, enabled plugin s exporter', () => {
    install(true);
    const list = pluginExporters();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ exporterId: 'webp', extension: 'webp', pluginName: 'Formats' });
    expect(pluginExporterFor(list[0]!.format)).not.toBeNull();
  });

  it('★ omits a DISABLED plugin rather than offering a format that then refuses', () => {
    // A format the user can select and that fails afterwards is worse than one
    // that is not offered: the refusal arrives after they configured a render.
    install(false);
    expect(pluginExporters()).toEqual([]);
    expect(pluginExporterFor('plugin:com.example.fmt.webp')).toBeNull();
  });

  it('answers null for a format no installed plugin provides', () => {
    expect(pluginExporterFor('plugin:com.gone.away.fmt')).toBeNull();
  });
});

describe('the version split', () => {
  it('★ moved the grammar alone — which is what the split was for', () => {
    // `contributes.exporters` adds a manifest KEY and no host method, so
    // MANIFEST_VERSION moved and HOST_API_VERSION did not. Whether a plugin may
    // CALL the new surface is the `exporters` capability, not a version.
    expect(MANIFEST_VERSION).toBe(6);
    expect(HOST_API_VERSION).toBe(5);
    expect(MANIFEST_VERSION).not.toBe(HOST_API_VERSION);
  });
});
