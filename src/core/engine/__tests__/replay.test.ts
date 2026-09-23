/**
 * The replay corpus (ENGINE_API.md §12): scripted editing sessions covering
 * every command family — gestures, undo/redo interleaving, precompose, split,
 * ripple, effects, masks, text, 3D, markers, comps, items. Each is recorded,
 * serialized as JSON lines, and replayed into a FRESH engine; the replay must
 * reproduce every revision and document hash, the final saved project JSON
 * byte for byte, and the undo stack.
 */

import { LocalEngine } from '../LocalEngine';
import { replayLog, logToJsonl, logFromJsonl } from '../replay';
import { setupEngine, fakePorts, docDiff } from '../__testHelpers__/harness';
import { CORPUS } from '../__testHelpers__/corpus';

jest.useFakeTimers();

test.each(Object.keys(CORPUS))('replay reproduces: %s', async (name) => {
  const h = await setupEngine({ hashes: true });
  try {
    await CORPUS[name]!(h);
    const finalDoc = h.doc();
    const finalHistory = await h.query({ type: 'getHistory' });
    const log = logFromJsonl(logToJsonl(h.engine.commandLog()));
    expect(log.records.length).toBeGreaterThan(5);
    await h.engine.close();

    // A FRESH engine: new instance, document reset to the log's header.
    const files = h.files;
    const fresh = new LocalEngine({ verifyScopes: true, wire: true, ports: fakePorts(files) });
    const result = await replayLog(log, fresh, { checkHashes: true });
    expect(result.mismatches).toEqual([]);
    expect(result.applied).toBe(log.records.length);
    expect(docDiff(finalDoc, h.doc())).toEqual([]);
    expect(h.doc()).toBe(finalDoc);
    const hist = await fresh.query({ type: 'getHistory' });
    expect(hist.ok && { labels: hist.value.entries.map((e) => e.label), position: hist.value.position })
      .toEqual({ labels: finalHistory.entries.map((e) => e.label), position: finalHistory.position });
    await fresh.close();
  } finally {
    await h.dispose();
  }
});
