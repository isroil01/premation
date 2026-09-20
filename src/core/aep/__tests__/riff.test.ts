/**
 * The container readers: RIFX and its XML twin.
 *
 * The point of most of these is that the two readers agree. `.aep` and `.aepx`
 * are the same document in two encodings, and the whole design of this importer
 * rests on them producing an identical chunk tree — so that is asserted
 * directly rather than left to two parallel sets of expectations that could
 * drift apart.
 */

import { AepParseError, chunkText, findChunk, findList, findLists, parseRifx, ratio, Reader } from '../riff';
import { parseAepx } from '../aepx';
import { aepFile, chunk, compItem, layer, list, utf8 } from '../__testHelpers__/buildAep';

const sample = (): Uint8Array =>
  aepFile([
    compItem({
      id: 7,
      name: 'Main',
      width: 1920,
      height: 1080,
      fps: 24,
      durationSeconds: 5,
      layers: [layer({ id: 1, displayName: 'Hero' })],
    }),
  ]);

describe('parseRifx', () => {
  it('reads the form header and the folder beneath it', () => {
    const root = parseRifx(sample());
    expect(root.id).toBe('RIFX');
    expect(root.listType).toBe('Egg!');
    const fold = findList(root, 'Fold');
    expect(fold).toBeDefined();
    expect(findLists(fold, 'Item')).toHaveLength(1);
  });

  it('finds a named leaf and reads its text', () => {
    const item = findLists(findList(parseRifx(sample()), 'Fold'), 'Item')[0];
    expect(chunkText(findChunk(item, 'Utf8'))).toBe('Main');
  });

  it('refuses bytes that are not a project', () => {
    expect(() => parseRifx(new Uint8Array([1, 2, 3]))).toThrow(AepParseError);
    expect(() => parseRifx(new TextEncoder().encode('RIFFxxxxWAVEfmt '))).toThrow(/RIFF media file/);
  });

  it('refuses a RIFX that is not an After Effects form', () => {
    const bytes = sample();
    // Overwrite `Egg!` with something else, leaving the rest intact.
    bytes.set(new TextEncoder().encode('Nope'), 8);
    expect(() => parseRifx(bytes)).toThrow(/unexpected form type/);
  });

  it('stops at the declared size, so AE’s trailing XMP is not read as chunks', () => {
    const bytes = sample();
    const withXmp = new Uint8Array(bytes.length + 64);
    withXmp.set(bytes);
    withXmp.set(new TextEncoder().encode('<?xpacket begin='), bytes.length);
    // The tail must not appear as a chunk, and must not make the read throw.
    const root = parseRifx(withXmp);
    expect(root.children?.some((c) => c.id.startsWith('<'))).toBe(false);
  });

  it('keeps what it has read when a chunk claims more bytes than remain', () => {
    // A truncated project is common — half a copy, an interrupted download —
    // and losing the tail must not cost the comps that were read first.
    const bytes = sample();
    const truncated = bytes.subarray(0, bytes.length - 40);
    const root = parseRifx(truncated);
    expect(findList(root, 'Fold')).toBeDefined();
  });

  it('does not descend into an opaque `btdk` blob', () => {
    const blob = new TextEncoder().encode('/0 << /1 (not chunks) >>');
    const bytes = aepFile([list('Item', [list('btdk', [chunk('xxxx', blob)])])]);
    const btdk = findList(findLists(findList(parseRifx(bytes), 'Fold'), 'Item')[0], 'btdk');
    expect(btdk?.children).toBeUndefined();
    expect(btdk?.body).toBeDefined();
  });

  it('gives a wrapper chunk its children rather than a body', () => {
    // `fnam` holds an effect's display name as a nested Utf8 — it is a list in
    // everything but name, and reading it as a leaf loses the name.
    const bytes = aepFile([list('Item', [chunk('fnam', utf8('Gaussian Blur'))])]);
    const item = findLists(findList(parseRifx(bytes), 'Fold'), 'Item')[0];
    expect(chunkText(findChunk(findChunk(item, 'fnam'), 'Utf8'))).toBe('Gaussian Blur');
  });
});

describe('parseAepx', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AfterEffectsProject xmlns="http://www.adobe.com/products/aftereffects" majorVersion="1" minorVersion="0">
  <head bdata="00000000"/>
  <Fold>
    <Item>
      <idta bdata="0004000000000000000000000000000000000007"/>
      <string>Main</string>
    </Item>
  </Fold>
  <ProjectXMPMetadata><![CDATA[<?xpacket begin="" ?>]]></ProjectXMPMetadata>
</AfterEffectsProject>`;

  it('produces the same shape of tree as the binary reader', () => {
    const root = parseAepx(xml);
    expect(root.id).toBe('RIFX');
    expect(root.listType).toBe('Egg!');
    const item = findLists(findList(root, 'Fold'), 'Item')[0];
    expect(chunkText(findChunk(item, 'Utf8'))).toBe('Main');
    expect(findChunk(item, 'idta')?.body).toHaveLength(20);
  });

  it('drops the XMP packet instead of treating it as a chunk', () => {
    expect(parseAepx(xml).children?.some((c) => c.id.startsWith('Proj'))).toBe(false);
  });

  it('pads a short element name back to four bytes', () => {
    // `Pin ` has a trailing space in the binary that XML cannot carry.
    const root = parseAepx(`<AfterEffectsProject><Fold><Item><Pin><sspc bdata="00"/></Pin></Item></Fold></AfterEffectsProject>`);
    const item = findLists(findList(root, 'Fold'), 'Item')[0];
    expect(findList(item, 'Pin ')).toBeDefined();
  });

  it('resolves entities in element text', () => {
    const root = parseAepx('<AfterEffectsProject><string>a &amp; b &lt;c&gt;</string></AfterEffectsProject>');
    expect(chunkText(findChunk(root, 'Utf8'))).toBe('a & b <c>');
  });

  it('never resolves an external entity declared in a DOCTYPE', () => {
    const hostile = `<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<AfterEffectsProject><string>&xxe;</string></AfterEffectsProject>`;
    // The reference survives as literal text; nothing is fetched or expanded.
    expect(chunkText(findChunk(parseAepx(hostile), 'Utf8'))).toBe('&xxe;');
  });

  it('refuses a document that is not an After Effects project', () => {
    expect(() => parseAepx('<html><body/></html>')).toThrow(AepParseError);
  });
});

describe('Reader', () => {
  const r = new Reader(new Uint8Array([0x00, 0x2a, 0xff, 0x01, 0x41, 0x42, 0x00, 0x00]));

  it('reads big-endian fields at named offsets', () => {
    expect(r.u16(0)).toBe(42);
    expect(r.u8(2)).toBe(255);
    expect(r.bit(3, 0)).toBe(true);
    expect(r.str(4, 4)).toBe('AB');
  });

  it('reads zero past the end rather than throwing', () => {
    // AE has grown these records over the years; an older file simply stops
    // early, and every field after that point should read as absent.
    expect(r.u32(64)).toBe(0);
    expect(r.f64(64)).toBe(0);
    expect(r.has(6, 8)).toBe(false);
  });
});

describe('ratio', () => {
  it('reads AE’s dividend/divisor pairs', () => {
    expect(ratio(245760, 24576)).toBe(10);
  });

  it('reads a zero divisor as zero, never as Infinity', () => {
    // A placeholder duration with a zero divisor reaches the comp's length and
    // would NaN out the whole timeline.
    expect(ratio(1, 0)).toBe(0);
  });
});
