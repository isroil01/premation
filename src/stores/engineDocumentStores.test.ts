/**
 * F2 — with the engine as owner the swatch / material / guides stores are
 * views of the engine's document: its value lands in the store, a USER edit is
 * one undoable engine command, and a replica restore is never sent.
 */

import type { Command, EngineResult, LibraryMaterial, Swatch } from '@motion/engine-api';
import { restoreDocument, captureDocument } from '@core/api/cloudDocument';
import { bindEngineDocumentStores, type StoreMirrorView } from './engineDocumentStores';
import { useSwatchStore } from './swatchStore';
import { useMaterialStore } from './materialStore';
import { useGuidesStore } from './guidesStore';

class FakeMirror implements StoreMirrorView {
  guides = '{}';
  swatches: readonly Swatch[] = [];
  materials: readonly LibraryMaterial[] = [];
  private readonly subs = new Map<string, Set<() => void>>();
  subscribe(keys: readonly string[], l: () => void): () => void {
    for (const k of keys) (this.subs.get(k) ?? this.subs.set(k, new Set()).get(k)!).add(l);
    return () => { for (const k of keys) this.subs.get(k)?.delete(l); };
  }
  emit(key: 'guides' | 'swatches' | 'materials'): void {
    for (const l of [...(this.subs.get(key) ?? [])]) l();
  }
}

function setup(answer: (cmd: Command) => boolean = () => true) {
  const mirror = new FakeMirror();
  const sent: Array<{ label: string; cmd: Command }> = [];
  const send = async (label: string, cmd: Command): Promise<EngineResult<unknown>> => {
    sent.push({ label, cmd });
    const ok = answer(cmd);
    // The engine's echo (events come before the answer).
    if (ok && cmd.type === 'setSwatches') {
      mirror.swatches = cmd.swatches.map((s) => ({ ...s, hex: s.hex.toLowerCase() }));
      mirror.emit('swatches');
    }
    return ok ? { ok: true, revision: 1, value: [] } : { ok: false, revision: 1, error: { code: 'invalidArgument', message: 'no' } as never };
  };
  const dispose = bindEngineDocumentStores({ mirror, send });
  return { mirror, sent, dispose };
}

beforeEach(() => {
  useSwatchStore.getState().restore([]);
  useMaterialStore.getState().restore([]);
});

describe('engine-owned document stores (F2)', () => {
  it('the engine value lands in the store; the store change it causes is not sent back', () => {
    const { mirror, sent, dispose } = setup();
    mirror.swatches = [{ id: 'sw_doc_1', name: 'Brand', hex: '#ff0000' }];
    mirror.emit('swatches');
    expect(useSwatchStore.getState().swatches).toEqual([{ id: 'sw_doc_1', name: 'Brand', hex: '#ff0000' }]);
    mirror.materials = [{ id: 'mat_doc_1', name: 'Gold', params: '{"metal":1}', swatch: '#ffcc00' }];
    mirror.emit('materials');
    expect(useMaterialStore.getState().materials.map((m) => [m.id, m.name, m.swatch])).toEqual([['mat_doc_1', 'Gold', '#ffcc00']]);
    expect(sent).toEqual([]);
    dispose();
  });

  it('a user edit is ONE engine command with the whole new value', async () => {
    const { sent, dispose } = setup();
    useSwatchStore.getState().addSwatch('#00FF00', 'Green');
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.cmd.type).toBe('setSwatches');
    expect((sent[0]!.cmd as Extract<Command, { type: 'setSwatches' }>).swatches.map((s) => s.hex)).toEqual(['#00ff00']);
    useGuidesStore.getState().toggleGrid();
    await Promise.resolve();
    const guides = sent.find((s) => s.cmd.type === 'setGuides');
    expect(guides?.label).toBe('Guides');
    // Every key stated, so a patch also clears.
    expect(Object.keys(JSON.parse((guides!.cmd as Extract<Command, { type: 'setGuides' }>).patch) as object)).toEqual(
      expect.arrayContaining(['grid', 'cameraBookmarks', 'userGuides', 'overlayOpacity']),
    );
    dispose();
  });

  it('a replica restore (restoreDocument) is never sent; a refused edit falls back to the engine value', async () => {
    const { mirror, sent, dispose } = setup(() => false);
    const doc = captureDocument();
    restoreDocument({ ...doc, swatches: [{ id: 'x', name: 'X', hex: '#123456' }] });
    await Promise.resolve();
    expect(sent.filter((s) => s.cmd.type === 'setSwatches')).toEqual([]);
    mirror.swatches = [];
    useSwatchStore.getState().addSwatch('#abcdef');
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.filter((s) => s.cmd.type === 'setSwatches')).toHaveLength(1);
    expect(useSwatchStore.getState().swatches).toEqual([]);  // the engine refused it
    dispose();
  });
});
