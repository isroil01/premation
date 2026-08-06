/**
 * Package reading, after binary media was allowed in.
 *
 * Split from `pluginPackage.test.ts` because the risk changed shape. That suite
 * asks whether a well-formed package is read correctly; this one asks what
 * happens when the archive is hostile, which became a live question the moment
 * packages could contain something other than source.
 *
 * The specific bug this is built around: the size ceilings used to be applied
 * AFTER `unzipSync(bytes)`, which inflates the whole archive into memory first.
 * So the 8 MB limit was being enforced against the COMPRESSED bytes, and a
 * perfectly compliant 8 MB archive could expand to gigabytes and take the app
 * down before a single check ran. A ceiling applied after the allocation it is
 * meant to prevent is not a ceiling.
 */

import { zipSync, strToU8 } from 'fflate';
import { readPluginZip, MAX_FILE_BYTES } from './pluginPackage';

const MANIFEST = {
  id: 'studio.acme.media',
  name: 'Media',
  version: '1.0.0',
  description: 'A package with media in it.',
  apiVersion: 2,
  main: 'main.js',
};

/** The two bytes every PNG starts with — enough to tell it is not text. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function archive(
  extraText: Record<string, string> = {},
  extraBinary: Record<string, Uint8Array> = {},
  manifest: unknown = MANIFEST,
): Uint8Array {
  return zipSync({
    'plugin.json': strToU8(JSON.stringify(manifest)),
    'main.js': strToU8('export function activate() {}'),
    ...Object.fromEntries(Object.entries(extraText).map(([k, v]) => [k, strToU8(v)])),
    ...extraBinary,
  });
}

describe('binary media in a package', () => {
  it('keeps a png as bytes, not as mangled text', () => {
    const { pkg, errors } = readPluginZip(archive({}, { 'lut.png': PNG_BYTES }));
    expect(errors).toEqual([]);
    // Read as text, these bytes would have come back as replacement characters
    // and been useless — silently, and only at the point of use.
    expect(pkg?.binaries['lut.png']).toEqual(PNG_BYTES);
    expect(pkg?.files['lut.png']).toBeUndefined();
  });

  it('accepts every declared media extension', () => {
    const { pkg } = readPluginZip(archive({}, {
      'a.png': PNG_BYTES, 'b.jpg': PNG_BYTES, 'c.jpeg': PNG_BYTES, 'd.webp': PNG_BYTES,
    }));
    expect(Object.keys(pkg?.binaries ?? {}).sort()).toEqual(['a.png', 'b.jpg', 'c.jpeg', 'd.webp']);
  });

  it('keeps shader source and svg as TEXT', () => {
    // SVG is markup and shaders are source. Treating either as opaque bytes
    // would lose the one thing that makes them usable.
    const { pkg } = readPluginZip(archive({
      'blur.wgsl': '@fragment fn main() {}',
      'warp.glsl': 'void main() {}',
      'icon.svg': '<svg/>',
    }));
    expect(pkg?.files['blur.wgsl']).toContain('@fragment');
    expect(pkg?.files['warp.glsl']).toContain('void main');
    expect(pkg?.files['icon.svg']).toBe('<svg/>');
    expect(pkg?.binaries['icon.svg']).toBeUndefined();
  });

  it('still drops a file type that is on neither list', () => {
    const { pkg } = readPluginZip(archive({ 'run.exe': 'MZ' }));
    expect(pkg?.files['run.exe']).toBeUndefined();
    expect(pkg?.binaries['run.exe']).toBeUndefined();
  });

  it('strips one wrapping directory across text AND media together', () => {
    // Computing the prefix from the text files alone would leave a media
    // subdirectory unstripped, and every path in the manifest pointing at
    // nothing — for the most ordinary way of producing a package there is.
    const zip = zipSync({
      'my-plugin/plugin.json': strToU8(JSON.stringify(MANIFEST)),
      'my-plugin/main.js': strToU8('export function activate() {}'),
      'my-plugin/media/lut.png': PNG_BYTES,
    });
    const { pkg, errors } = readPluginZip(zip);
    expect(errors).toEqual([]);
    expect(pkg?.binaries['media/lut.png']).toEqual(PNG_BYTES);
  });
});

describe('hostile archives', () => {
  it('refuses a file whose UNCOMPRESSED size is over the limit', () => {
    // Highly compressible, so the archive itself is tiny — this is exactly the
    // input the old post-inflation check could not see coming.
    const bomb = new Uint8Array(MAX_FILE_BYTES + 1024); // all zeroes
    const { pkg, errors } = readPluginZip(archive({}, { 'big.png': bomb }));
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/unpacks to more than/);
  });

  it('refuses a pathological compression ratio', () => {
    const bomb = new Uint8Array(600 * 1024); // zeroes: ~1000x
    const { pkg, errors } = readPluginZip(archive({}, { 'bomb.png': bomb }));
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/zip bomb|unpacks to more than/);
  });

  it('refuses a package whose entries TOTAL more than the ceiling once unpacked', () => {
    const chunk = new Uint8Array(1024 * 1024); // 1 MB of zeroes each
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 12; i++) many[`m${i}.png`] = chunk;
    const { pkg, errors } = readPluginZip(archive({}, many));
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/unpacks to more than|zip bomb/);
  });

  it('refuses a panel entry that climbs out of the package', () => {
    const { pkg, errors } = readPluginZip(archive({}, {}, {
      ...MANIFEST,
      contributes: { panels: [{ id: 'main', title: 'Main', entry: '../../../etc/passwd' }] },
    }));
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/package-relative/);
  });

  it('refuses a panel entry that is not in the package', () => {
    // Otherwise the mistake surfaces as an empty frame at open time, a long way
    // from where it was made.
    const { pkg, errors } = readPluginZip(archive({}, {}, {
      ...MANIFEST,
      contributes: { panels: [{ id: 'main', title: 'Main', entry: 'missing.html' }] },
    }));
    expect(pkg).toBeNull();
    expect(errors.join(' ')).toMatch(/missing\.html/);
  });

  it('accepts a package whose declared panels are all present', () => {
    const { pkg, errors } = readPluginZip(archive({
      'panel.html': '<p>main</p>',
      'inspector.html': '<p>inspector</p>',
    }, {}, {
      ...MANIFEST,
      contributes: {
        panels: [
          { id: 'main', title: 'Main', entry: 'panel.html' },
          { id: 'inspector', title: 'Inspector', entry: 'inspector.html' },
        ],
      },
    }));
    expect(errors).toEqual([]);
    expect(pkg?.manifest.contributes.panels).toHaveLength(2);
  });

  it('still ignores a zip-slip path outright', () => {
    const zip = zipSync({
      'plugin.json': strToU8(JSON.stringify(MANIFEST)),
      'main.js': strToU8('export function activate() {}'),
      '../escaped.js': strToU8('bad'),
    });
    const { pkg } = readPluginZip(zip);
    expect(pkg?.files['../escaped.js']).toBeUndefined();
  });
});
