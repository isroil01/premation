import { crc32 } from './zip';
import { buildMogrtPackage, exportMogrtZip } from './exportMogrt';

describe('exportMogrt', () => {
  it('builds a package with fields array and format tag', () => {
    const pkg = buildMogrtPackage('Test');
    expect(pkg.format).toBe('premation-mogrt-v1');
    expect(pkg.name).toBe('Test');
    expect(Array.isArray(pkg.fields)).toBe(true);
    expect(pkg.document).toBeTruthy();
  });

  it('zips to a valid local-file header', () => {
    const bytes = exportMogrtZip('Test');
    expect(bytes.length).toBeGreaterThan(64);
    // PK\x03\x04 local file header
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes[2]).toBe(0x03);
    expect(bytes[3]).toBe(0x04);
    // CRC helper still works on payload
    expect(crc32(bytes.subarray(0, 8))).toBeGreaterThanOrEqual(0);
  });
});
