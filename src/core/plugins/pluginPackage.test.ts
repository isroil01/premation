/**
 * Reading a plugin package: what is accepted, what is refused, and — the part
 * that matters for a manager UI — whether the refusal says why.
 *
 * Every validation here happens BEFORE any of the package's code exists in a
 * sandbox, which is what makes an informed install prompt possible at all.
 */

import { zipSync, strToU8 } from 'fflate';
import { parseManifest, HOST_API_VERSION, MANIFEST_VERSION } from './manifest';
import { readPluginFiles, readPluginZip, MAX_FILE_BYTES } from './pluginPackage';

const GOOD = {
  id: 'studio.acme.easing-lab',
  name: 'Easing Lab',
  version: '1.2.0',
  description: 'Adds easing tools.',
  apiVersion: HOST_API_VERSION,
  main: 'main.js',
  permissions: ['animation:write'],
};

const files = (manifest: unknown, extra: Record<string, string> = {}): Record<string, string> => ({
  'plugin.json': JSON.stringify(manifest),
  'main.js': 'export function activate() {}',
  ...extra,
});

describe('manifest validation', () => {
  it('accepts a well-formed manifest', () => {
    const { manifest, errors } = parseManifest(GOOD);
    expect(errors).toEqual([]);
    expect(manifest?.id).toBe('studio.acme.easing-lab');
  });

  it('requires a reverse-DNS id so two vendors cannot collide', () => {
    for (const id of ['easinglab', 'Studio.Acme', 'studio acme', '', 'studio..acme']) {
      const { errors } = parseManifest({ ...GOOD, id });
      expect({ id, ok: errors.length === 0 }).toEqual({ id, ok: false });
    }
  });

  it('requires semver', () => {
    expect(parseManifest({ ...GOOD, version: '1.2' }).errors).not.toEqual([]);
    expect(parseManifest({ ...GOOD, version: 'latest' }).errors).not.toEqual([]);
  });

  it('refuses a plugin built for a NEWER host, and says to update', () => {
    // MANIFEST_VERSION, not HOST_API_VERSION: `apiVersion` in a manifest is the
    // GRAMMAR it is written in. The two were equal until `contributes.exporters`
    // moved the grammar alone, and this assertion only ever passed because of
    // that coincidence.
    const { errors } = parseManifest({ ...GOOD, apiVersion: MANIFEST_VERSION + 1 });
    expect(errors.join(' ')).toMatch(/Update the app/);
  });

  it('refuses an unknown permission by name', () => {
    const { errors } = parseManifest({ ...GOOD, permissions: ['filesystem'] });
    expect(errors.join(' ')).toMatch(/Unknown permission "filesystem"/);
  });

  it('de-duplicates repeated permissions', () => {
    const { manifest } = parseManifest({ ...GOOD, permissions: ['scene:read', 'scene:read'] });
    expect(manifest?.permissions).toEqual(['scene:read']);
  });

  it('refuses a main path that escapes the package', () => {
    for (const main of ['../../etc/passwd', '/etc/passwd', 'C:/windows/system32', 'a/../../b.js']) {
      const { errors } = parseManifest({ ...GOOD, main });
      expect({ main, ok: errors.length === 0 }).toEqual({ main, ok: false });
    }
  });

  it('requires a description — it is what the user reads before installing', () => {
    expect(parseManifest({ ...GOOD, description: '' }).errors).not.toEqual([]);
  });

  it('drops a homepage that is not http(s)', () => {
    const { manifest } = parseManifest({ ...GOOD, homepage: 'javascript:alert(1)' });
    expect(manifest?.homepage).toBeUndefined();
  });
});

describe('package reading', () => {
  it('reads a flat file map', () => {
    const { pkg, errors } = readPluginFiles(files(GOOD));
    expect(errors).toEqual([]);
    expect(pkg?.files['main.js']).toContain('activate');
  });

  it('reads a zip whose contents sit inside one wrapping folder', () => {
    const zip = zipSync({
      'easing-lab/plugin.json': strToU8(JSON.stringify(GOOD)),
      'easing-lab/main.js': strToU8('export function activate() {}'),
    });
    const { pkg, errors } = readPluginZip(zip);
    expect(errors).toEqual([]);
    expect(pkg?.manifest.name).toBe('Easing Lab');
  });

  it('says so when there is no plugin.json', () => {
    const { pkg, errors } = readPluginFiles({ 'main.js': 'x' });
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/No plugin.json/);
  });

  it('says so when main points at a file that is not in the package', () => {
    const { pkg, errors } = readPluginFiles({ 'plugin.json': JSON.stringify(GOOD) });
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/main.*not in the package/);
  });

  it('reports invalid JSON with the parser s own message', () => {
    const { pkg, errors } = readPluginFiles({ 'plugin.json': '{ nope', 'main.js': 'x' });
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/not valid JSON/);
  });

  it('drops zip-slip entries instead of writing outside the package', () => {
    const zip = zipSync({
      'plugin.json': strToU8(JSON.stringify(GOOD)),
      'main.js': strToU8('export function activate() {}'),
      '../../../evil.js': strToU8('pwned'),
    });
    const { pkg } = readPluginZip(zip);
    expect(Object.keys(pkg?.files ?? {})).toEqual(expect.not.arrayContaining(['../../../evil.js']));
  });

  it('drops non-text payloads — a plugin is source, not an asset library', () => {
    const zip = zipSync({
      'plugin.json': strToU8(JSON.stringify(GOOD)),
      'main.js': strToU8('export function activate() {}'),
      'payload.exe': strToU8('MZ'),
    });
    const { pkg } = readPluginZip(zip);
    expect(pkg?.files['payload.exe']).toBeUndefined();
  });

  it('refuses an oversized file', () => {
    const zip = zipSync({
      'plugin.json': strToU8(JSON.stringify(GOOD)),
      'main.js': strToU8('x'.repeat(MAX_FILE_BYTES + 1)),
    });
    const { pkg, errors } = readPluginZip(zip);
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/unpacks to more than/);
  });

  it('refuses unreadable bytes rather than throwing', () => {
    const { pkg, errors } = readPluginZip(new Uint8Array([1, 2, 3, 4]));
    expect(pkg).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
  });
});
