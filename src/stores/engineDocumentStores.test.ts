/**
 * F2 — with the engine as owner the swatch / material / guides stores are
 * views of the engine's document: its value lands in the store, a USER edit is
 * one undoable engine command, and a replica restore is never sent.
 */

import type { ColorManagementSettings, Command, EngineResult, LibraryMaterial, MotionBlurSettings, Swatch } from '@motion/engine-api';
import { restoreDocument, captureDocument } from '@core/api/cloudDocument';
import { bindEngineDocumentStores, type StoreMirrorView } from './engineDocumentStores';
import { useSwatchStore } from './swatchStore';
import { useMaterialStore } from './materialStore';
import { useGuidesStore } from './guidesStore';
import { DEFAULT_MOTION_BLUR_SETTINGS, useMotionBlurStore } from './motionBlurStore';
import { DEFAULT_COLOR_MANAGEMENT_SETTINGS, useColorManagementStore } from './colorManagementStore';

class FakeMirror implements StoreMirrorView {
  guides = '{}';
  swatches: readonly Swatch[] = [];
  materials: readonly LibraryMaterial[] = [];
  motionBlur: MotionBlurSettings = { enabled: true, shutterAngle: 180, shutterPhase: -90, samplesPerFrame: 8, adaptiveSampleLimit: 128 };
  colorManagement: ColorManagementSettings = { workingSpace: 'srgbLinear', displayTransform: 'srgb', bitDepth: 16 };
  private readonly subs = new Map<string, Set<() => void>>();
  subscribe(keys: readonly string[], l: () => void): () => void {
    for (const k of keys) (this.subs.get(k) ?? this.subs.set(k, new Set()).get(k)!).add(l);
    return () => { for (const k of keys) this.subs.get(k)?.delete(l); };
  }
  emit(key: 'guides' | 'swatches' | 'materials' | 'motionBlur' | 'colorManagement'): void {
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
  useMotionBlurStore.getState().restore(DEFAULT_MOTION_BLUR_SETTINGS);
  useColorManagementStore.getState().restore(DEFAULT_COLOR_MANAGEMENT_SETTINGS);
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

  it('motion blur and colour management: the engine record lands in the store, a panel edit is one command', async () => {
    const { mirror, sent, dispose } = setup();
    mirror.motionBlur = { enabled: false, shutterAngle: 90, shutterPhase: 0, samplesPerFrame: 16, adaptiveSampleLimit: 64 };
    mirror.emit('motionBlur');
    expect(useMotionBlurStore.getState().settings()).toEqual({ enabled: false, shutterAngle: 90, shutterPhase: 0, samples: 16, adaptiveSampleLimit: 64 });
    mirror.colorManagement = { workingSpace: 'acesCg', displayTransform: 'aces', bitDepth: 32 };
    mirror.emit('colorManagement');
    expect(useColorManagementStore.getState().settings()).toEqual({ workingSpace: 'aces-cg', displayTransform: 'aces', bitDepth: 32 });
    expect(sent).toEqual([]);

    useMotionBlurStore.getState().setShutterAngle(270);
    await Promise.resolve();
    const mb = sent.find((x) => x.cmd.type === 'setMotionBlur');
    expect(mb?.label).toBe('Motion Blur');
    expect((mb!.cmd as Extract<Command, { type: 'setMotionBlur' }>).patch).toEqual({ enabled: false, shutterAngle: 270, shutterPhase: 0, samplesPerFrame: 16, adaptiveSampleLimit: 64 });

    useColorManagementStore.getState().setDisplayTransform('hlg');
    await Promise.resolve();
    const cm = sent.find((x) => x.cmd.type === 'setColorManagement');
    expect((cm!.cmd as Extract<Command, { type: 'setColorManagement' }>).patch).toEqual({ workingSpace: 'acesCg', displayTransform: 'hlg', bitDepth: 32 });
    dispose();
  });
});
