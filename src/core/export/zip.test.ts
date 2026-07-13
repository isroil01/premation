import { crc32, zipBytes } from './zip';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crc32', () => {
  it('matches known IEEE CRC-32 vectors', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
    // "The quick brown fox jumps over the lazy dog" → 0x414FA339
    expect(crc32(bytes('The quick brown fox jumps over the lazy dog')) >>> 0).toBe(0x414fa339);
    // "123456789" → 0xCBF43926
    expect(crc32(bytes('123456789')) >>> 0).toBe(0xcbf43926);
  });
});

describe('createStoreZip', () => {
  it('produces a valid PK zip with the entries', () => {
    const buf = zipBytes([
      { name: 'a.txt', data: bytes('hello') },
      { name: 'b.txt', data: bytes('world!') },
    ]);
    // Local file header signature PK\x03\x04
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // End-of-central-directory signature PK\x05\x06 appears near the end
    const tail = buf.slice(buf.length - 22);
    expect([tail[0], tail[1], tail[2], tail[3]]).toEqual([0x50, 0x4b, 0x05, 0x06]);
    // Entry count (offset 8 in EOCD) = 2
    expect(tail[8]! | (tail[9]! << 8)).toBe(2);
    // The stored file data appears verbatim (store method = no compression)
    const asString = new TextDecoder().decode(buf);
    expect(asString).toContain('hello');
    expect(asString).toContain('world!');
  });

  it('is empty-safe', () => {
    expect(zipBytes([]).length).toBe(22); // just the EOCD record
  });
});
