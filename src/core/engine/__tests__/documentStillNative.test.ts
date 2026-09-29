/**
 * renderDocumentStill on the REAL C++ engine: another document's frame, drawn
 * without opening it (Versions ▸ Compare). The same document renders the same
 * picture getThumbnail draws; a saved document keeps its own picture after the
 * open one changes; the open document's revision does not move.
 *
 * Skipped, saying so, when the full engine (with the scene) is not built.
 */

import { ProcessEngineClient, unwrap, type EngineClient } from '@motion/engine-api';
import { nativeEngineExe, startNativeEngine, type NativeEngine } from '@core/engine/__testHelpers__/nativeEngine';

jest.setTimeout(120_000);

const exe = nativeEngineExe();
const full = !!exe && !/headless/i.test(exe);
if (!full) console.log('[renderDocumentStill native] the full premation-engine is not built — skipped');
const maybe = full ? describe : describe.skip;

function rgba(t: { format: string; data: Uint8Array }): Uint8Array {
  expect(t.format).toBe('png');
  // Test-only decoder (devDependency).
  const { PNG } = require('pngjs') as { PNG: { sync: { read(b: Buffer): { data: Buffer } } } };
  return new Uint8Array(PNG.sync.read(Buffer.from(t.data)).data);
}

/** Share of RGBA bytes that differ by more than 8 levels. */
function differing(a: Uint8Array, b: Uint8Array): number {
  expect(a.length).toBe(b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 8) n++;
  return n / a.length;
}

maybe('renderDocumentStill in the C++ engine', () => {
  let native: NativeEngine;
  let client: EngineClient;

  beforeAll(async () => {
    native = await startNativeEngine({ extraArgs: [] });
    const c = new ProcessEngineClient(native.bridge);
    await c.whenReady();
    client = c;
  });
  afterAll(async () => {
    await native?.stop();
  });

  it('draws a saved document as it was, leaving the open one alone', async () => {
    const comp = unwrap(await client.execute({
      type: 'createComposition',
      settings: { name: 'Still', width: 320, height: 180, background: { r: 1, g: 0, b: 0, a: 1 } },
      fromItems: [],
    })).item;
    const saved = new TextDecoder().decode(unwrap(await client.query({ type: 'exportDocument' })).document);
    const live = rgba(unwrap(await client.query({ type: 'getThumbnail', item: comp, time: 0, maxSize: 320 })));
    const same = rgba(unwrap(await client.query({ type: 'renderDocumentStill', document: saved, comp, time: 0, maxSize: 320 })));
    expect(differing(live, same)).toBeLessThan(0.001);

    unwrap(await client.execute({ type: 'setCompositionSettings', comp, patch: { background: { r: 0, g: 0, b: 1, a: 1 } } }));
    const rev = unwrap(await client.query({ type: 'getHistory' })).entries.length;
    const nowLive = rgba(unwrap(await client.query({ type: 'getThumbnail', item: comp, time: 0, maxSize: 320 })));
    const version = rgba(unwrap(await client.query({ type: 'renderDocumentStill', document: saved, comp, time: 0, maxSize: 320 })));
    // Red → blue: the R and B bytes of every pixel (half of all bytes).
    expect(differing(nowLive, live)).toBeGreaterThan(0.4);
    expect(differing(version, live)).toBeLessThan(0.001);
    expect(unwrap(await client.query({ type: 'getHistory' })).entries.length).toBe(rev);
  });

  it('refuses what is not a document, and a composition it does not have', async () => {
    const bad = await client.query({ type: 'renderDocumentStill', document: 'not json', time: 0, maxSize: 64 });
    expect(bad.ok).toBe(false);
    const saved = new TextDecoder().decode(unwrap(await client.query({ type: 'exportDocument' })).document);
    const none = await client.query({ type: 'renderDocumentStill', document: saved, comp: 'comp_missing', time: 0, maxSize: 64 });
    expect(none.ok).toBe(false);
  });
});
