/**
 * F2 — with the engine as owner the assets store's items and the project
 * store's compositions follow the engine's ItemInfo / CompInfo; the page keeps
 * only its session fields (object URLs, thumbnails).
 */

import type { CompSettings, ItemInfo } from '@motion/engine-api';
import type { MirrorComp } from './documentMirror';
import { useAssetStore, type ImportedAsset } from './assetStore';
import { useProjectStore } from './projectStore';
import { bindEngineComps, bindEngineItems, compFromInfo, itemsFromMirror, type ItemsMirrorView } from './engineItemsView';

const SEC = 705_600_000;

function footage(id: string, patch: Partial<ItemInfo> = {}): ItemInfo {
  return {
    id, kind: 'footage', name: id, label: 0, comment: '', path: `/media/${id}.mp4`, missing: false,
    width: 1920, height: 1080, duration: 4 * SEC, frameRate: { num: 25, den: 1 }, hasVideo: true, hasAudio: true, hasAlpha: false,
    interpretation: { alpha: 'auto', pixelAspect: 1, fieldOrder: 'progressive', loops: 1, colorProfile: 'auto', invertAlpha: false },
    proxyPath: '', proxyEnabled: false, tags: [], codec: 'h264', audioChannels: 2, audioSampleRate: 0, colorProfile: '', fileBytes: 1234,
    mediaType: 'video', alphaProbed: true, audioProbed: true,
    ...patch,
  };
}

function folder(id: string, parent?: string): ItemInfo {
  return {
    ...footage(id), kind: 'folder', path: '', width: 0, height: 0, duration: 0, hasVideo: false, hasAudio: false,
    codec: '', audioChannels: 0, fileBytes: 0, ...(parent ? { parent } : {}),
  };
}

function settings(patch: Partial<CompSettings> = {}): CompSettings {
  return {
    name: 'Main', width: 1280, height: 720, pixelAspect: 1, frameRate: { num: 30, den: 1 }, duration: 6 * SEC,
    startTimecode: SEC, background: { r: 1, g: 0, b: 0, a: 1 }, transparent: false,
    workArea: { start: 0, duration: 6 * SEC },
    motionBlur: { shutterAngle: 180, shutterPhase: -90, samplesPerFrame: 8, adaptiveSampleLimit: 128, enabled: true },
    renderer3d: 'classic', globalLightAngle: 90, globalLightAltitude: 45, dropFrame: false, preserveFrameRate: false, preserveResolution: false,
    essentialProps: [],
    ...patch,
  };
}

class FakeMirror implements ItemsMirrorView {
  items = new Map<string, ItemInfo>();
  comps = new Map<string, MirrorComp>();
  private readonly subs = new Map<string, Set<() => void>>();
  subscribe(keys: readonly string[], l: () => void): () => void {
    for (const k of keys) (this.subs.get(k) ?? this.subs.set(k, new Set()).get(k)!).add(l);
    return () => { for (const k of keys) this.subs.get(k)?.delete(l); };
  }
  emit(key: string): void {
    for (const l of [...(this.subs.get(key) ?? [])]) l();
  }
}

describe('engine items view (F2)', () => {
  it('patches document fields over the page record and keeps its session fields', () => {
    const prev: ImportedAsset = { id: 'a1', name: 'old', type: 'video', src: 'blob:session-url', size: 10, thumbSrc: 'blob:thumb', folderId: null };
    const items = new Map([
      ['f1', folder('f1')],
      ['a1', footage('a1', { name: 'Plate', parent: 'f1', label: 2, comment: 'hero', tags: ['A'], interpretation: { alpha: 'premultiplied', pixelAspect: 2, fieldOrder: 'upperFirst', loops: 3, colorProfile: 'auto', invertAlpha: false, conformFrameRate: { num: 24, den: 1 } } })],
    ]);
    const out = itemsFromMirror(items, { assets: [prev, { id: 'gone', name: 'x', type: 'image', src: 'blob:x', size: 1 }], folders: [] });
    expect(out.folders).toEqual([{ id: 'f1', name: 'f1', parentId: null }]);
    expect(out.assets).toHaveLength(1);
    const a = out.assets[0]!;
    expect(a.src).toBe('blob:session-url');
    expect(a.thumbSrc).toBe('blob:thumb');
    expect(a.name).toBe('Plate');
    expect(a.folderId).toBe('f1');
    expect(a.comment).toBe('hero');
    expect(a.tags).toEqual(['A']);
    expect(typeof a.label).toBe('string');
    expect(a.interpret).toEqual({ alpha: 'premultiplied', par: 2, fields: 'upper', loopCount: 3, conformFps: 24 });
    expect(a.metadata?.fps).toBe(25);
    expect(a.size).toBe(1234);
  });

  it('an item the page has no record for gets one naming the engine file', () => {
    // B4 round 5: the type is the item's probed `mediaType`; the media, its `mediaUrl` when it has one.
    const out = itemsFromMirror(new Map([['a2', footage('a2', { duration: 0, mediaType: 'image' })]]), { assets: [], folders: [] });
    expect(out.assets[0]).toMatchObject({ id: 'a2', type: 'image', src: '/media/a2.mp4', path: '/media/a2.mp4' });
    const played = itemsFromMirror(new Map([['a3', footage('a3', { mediaUrl: 'local-file:///media/a3.mp4' })]]), { assets: [], folders: [] });
    expect(played.assets[0]).toMatchObject({ id: 'a3', type: 'video', src: 'local-file:///media/a3.mp4' });
  });

  it('binds: the store follows every items change', () => {
    const mirror = new FakeMirror();
    mirror.items.set('a1', footage('a1'));
    const dispose = bindEngineItems(mirror);
    expect(useAssetStore.getState().assets.map((a) => a.id)).toEqual(['a1']);
    mirror.items.set('a1', footage('a1', { name: 'Renamed' }));
    mirror.emit('items');
    expect(useAssetStore.getState().assets[0]!.name).toBe('Renamed');
    mirror.items.delete('a1');
    mirror.emit('items');
    expect(useAssetStore.getState().assets).toEqual([]);
    dispose();
  });
});

describe('engine compositions view (F2)', () => {
  it('maps CompSettings back to the stored record', () => {
    const c = compFromInfo('comp_1', settings({ world: JSON.stringify({ groundLevel: 12 }), pristine: true }), folder('comp_1', 'f9'), undefined);
    expect(c).toMatchObject({
      id: 'comp_1', name: 'Main', width: 1280, height: 720, fps: 30, durationSeconds: 6, background: '#ff0000',
      transparent: false, startFrame: 30, pristine: true, groundLevel: 12, folderId: 'f9',
    });
  });

  it('binds: the project store comps follow the mirror', () => {
    const mirror = new FakeMirror();
    mirror.comps.set('comp_1', { id: 'comp_1', settings: settings(), layers: [], markers: [], transitions: [] });
    const dispose = bindEngineComps(mirror);
    expect(useProjectStore.getState().comps.comp_1?.name).toBe('Main');
    mirror.comps.set('comp_1', { id: 'comp_1', settings: settings({ name: 'Edit' }), layers: [], markers: [], transitions: [] });
    mirror.emit('comps');
    expect(useProjectStore.getState().comps.comp_1?.name).toBe('Edit');
    dispose();
  });
});
