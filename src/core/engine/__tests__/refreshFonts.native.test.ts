/**
 * `refreshFonts` on the real engine process: with nothing installed or
 * removed it is the cheap check alone — no change, no `fontsChanged`, and
 * `listFonts` answers the same faces. (A real install is not scripted here: it
 * would change the machine's fonts; the catalogue's install / remove logic is
 * covered by native/engine/tests/test_font_catalog.cpp.)
 */
import { ProcessEngineClient, unwrap } from '@motion/engine-api';
import { nativeEngineExe, nativeEngineIsHeadless, startNativeEngine } from '../__testHelpers__/nativeEngine';

const suite = nativeEngineExe() && !nativeEngineIsHeadless() ? describe : describe.skip;

suite('refreshFonts', () => {
  it('reports no change when no font was installed or removed', async () => {
    const native = await startNativeEngine();
    const client = new ProcessEngineClient(native.bridge);
    const events: string[] = [];
    client.subscribe((batch) => {
      for (const e of batch.events) events.push(e.type);
    });
    try {
      const before = unwrap(await client.query({ type: 'listFonts', query: '' })).fonts.length;
      expect(unwrap(await client.execute({ type: 'refreshFonts' })).changed).toBe(false);
      expect(unwrap(await client.execute({ type: 'refreshFonts' })).changed).toBe(false);
      expect(unwrap(await client.query({ type: 'listFonts', query: '' })).fonts.length).toBe(before);
      expect(events).not.toContain('fontsChanged');
    } finally {
      await native.stop();
    }
  }, 60_000);
});
