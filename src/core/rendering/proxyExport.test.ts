/**
 * THE proxy invariant: no output path ever decodes a proxy.
 *
 * A proxy that leaks into an export does not make the editor feel slow — it
 * ships a low-resolution master and nothing in the app says so. That is the one
 * way this feature can damage output rather than merely speed up editing, so it
 * is pinned three ways:
 *
 *  1. Behaviourally, through `buildSnapshot`: the `src` an export-shaped call
 *     resolves to, with a ready proxy present and the preference ON.
 *  2. Structurally: `useProxies` defaults to false, so an output path reaches
 *     full resolution by DOING NOTHING. Omission is the safe direction.
 *  3. Statically: no file on an output path mentions `useProxies` at all.
 *
 * (1) is asserted at the frame-contract level — the `src` the snapshot carries
 * is exactly what the renderer decodes and the encoder therefore receives, and
 * jest has neither a GPU nor an ffmpeg child to encode with. The encode side is
 * covered separately in `proxyEncode.integration.test.ts`, which runs real
 * ffmpeg and asserts real output.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { useAssetStore } from '@stores/assetStore';
import type { SceneNode } from '@core/types';
import type { SnapshotComp } from './buildSnapshot';
import type { ImportedAsset } from '@stores/assetStore';

const COMP: SnapshotComp = { width: 1920, height: 1080, background: '#000' };
const ORIGINAL = 'blob:original-4k';
const PROXY = 'blob:proxy-1080';

const ASSET: ImportedAsset = {
  id: 'a1',
  name: 'shot.mov',
  type: 'video',
  src: ORIGINAL,
  size: 1,
  metadata: { width: 3840, height: 2160, duration: 12, fps: 24 },
  proxy: { status: 'ready', src: PROXY, width: 1920, height: 1080 },
};

function videoNode(): SceneNode {
  return {
    id: 'clip', name: 'clip', parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 960, y: 540 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: 'clip_t', type: 'Transform', props: { [SCENE_KIND_PROP]: 'video', x: 960, y: 540, width: 1920, height: 1080, assetId: 'a1' } },
      { id: 'clip_s', type: 'Style', props: { opacity: 100 } },
    ],
  } as unknown as SceneNode;
}

function srcAt(comp: SnapshotComp): string | undefined {
  const g = new SceneGraph();
  g.addNode(videoNode());
  const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, comp);
  return snap.layers.find((l) => l.id === 'clip')?.src;
}

beforeEach(() => {
  useAssetStore.setState({ assets: [ASSET] } as never);
});

describe('the export invariant', () => {
  it('an export-shaped build (no useProxies) decodes the ORIGINAL', () => {
    expect(srcAt(COMP)).toBe(ORIGINAL);
  });

  it('explicitly opting out decodes the original', () => {
    expect(srcAt({ ...COMP, useProxies: false })).toBe(ORIGINAL);
  });

  it('only an explicit opt-in reaches the proxy', () => {
    expect(srcAt({ ...COMP, useProxies: true })).toBe(PROXY);
  });

  it('a truthy-but-not-true value does not opt in', () => {
    // `comp.useProxies === true` is a strict check on purpose: a config object
    // deserialized from JSON with "true" as a string must not enable proxies.
    expect(srcAt({ ...COMP, useProxies: 'true' as unknown as boolean })).toBe(ORIGINAL);
    expect(srcAt({ ...COMP, useProxies: 1 as unknown as boolean })).toBe(ORIGINAL);
  });

  it('falls back to the original for every non-ready proxy state, even opted in', () => {
    for (const proxy of [
      { status: 'generating' as const },
      { status: 'failed' as const, error: 'ffmpeg exited 1' },
      { status: 'ready' as const },
    ]) {
      useAssetStore.setState({ assets: [{ ...ASSET, proxy }] } as never);
      expect(srcAt({ ...COMP, useProxies: true })).toBe(ORIGINAL);
    }
  });

  it('a deleted proxy file falls back without erroring', () => {
    useAssetStore.setState({ assets: [{ ...ASSET, proxy: undefined }] } as never);
    expect(() => srcAt({ ...COMP, useProxies: true })).not.toThrow();
    expect(srcAt({ ...COMP, useProxies: true })).toBe(ORIGINAL);
  });
});

describe('a proxy changes pixels only — timing and geometry still describe the source', () => {
  it('keeps the ORIGINAL size, duration and fps in the snapshot regardless of the toggle', () => {
    // The proxy is 1920x1080; the asset metadata says 3840x2160 @ 24fps / 12s.
    // If any of these followed the proxy, trim, slip, stretch, time remap and
    // auto-fit would all silently disagree with the source.
    const g = new SceneGraph();
    g.addNode(videoNode());
    for (const useProxies of [false, true]) {
      const snap = buildSnapshot(
        g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined,
        { ...COMP, useProxies },
      );
      const asset = useAssetStore.getState().assets.find((a) => a.id === 'a1')!;
      expect(asset.metadata?.width).toBe(3840);
      expect(asset.metadata?.height).toBe(2160);
      expect(asset.metadata?.duration).toBe(12);
      expect(asset.metadata?.fps).toBe(24);
      expect(snap.layers.find((l) => l.id === 'clip')).toBeDefined();
    }
  });
});

describe('structural guards', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '..', '..', '..', rel), 'utf8');

  /** Every module that produces frames for something other than the interactive
   *  viewport. If a new output path appears, add it here. */
  const OUTPUT_PATHS = [
    'src/core/export/exportManager.ts',
    'src/core/export/offlineRenderer.ts',
    'src/core/export/exportPreview.ts',
    'src/core/rendering/componentThumbs.ts',
  ];

  it.each(OUTPUT_PATHS)('%s never mentions useProxies', (rel) => {
    expect(read(rel)).not.toContain('useProxies');
  });

  it.each(OUTPUT_PATHS)('%s never mentions the tier type either', (rel) => {
    // `resolveMediaSrc` takes a `ProxyTier` now, defaulting to 'original'. The
    // boolean guard above would not have noticed an output path that named a
    // tier directly — and one of the tiers is 540p footage meant only for a
    // matcher to read. An output path cannot even SPELL the type.
    const src = read(rel);
    expect(src).not.toContain('ProxyTier');
    expect(src).not.toContain('resolveMediaSrc');
    expect(src).not.toContain("'analysis'");
  });

  it('exactly ONE module resolves the analysis tier, derived from the tree', () => {
    /*
      The invisible tier has one door, and this finds it rather than being told.

      A hand-listed caller set is the F25 shape — it only ever checks the
      subjects someone remembered, and goes green while a new caller sits
      outside it. So the file list comes from the directories where analysis
      walks live, and the claim is that precisely one of them names the tier.

      That module also owns the rule an extra caller would most likely get
      wrong: an analysis walk must know the ORIGINAL's display grid
      independently of what it decoded, or every measurement comes back in
      proxy pixels (see `analysisTier`). Routing through one door is what makes
      that rule unavoidable rather than remembered.
    */
    const dirs = ['src/core/tracking', 'src/core/reframe'];
    const namers: string[] = [];
    for (const dir of dirs) {
      const abs = join(__dirname, '..', '..', '..', dir);
      for (const f of readdirSync(abs)) {
        if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
        if (read(`${dir}/${f}`).includes("'analysis'")) namers.push(`${dir}/${f}`);
      }
    }
    expect(namers).toEqual(['src/core/tracking/analysisTier.ts']);
  });

  it('the walks that should use a stand-in go through that door', () => {
    // Scene-edit detection is deliberately absent: it argues in its own source
    // that a re-encode can move a hard cut and land the detector a frame late.
    // Roto is absent because its output IS the silhouette, so resolution there
    // is the deliverable rather than the cost.
    for (const w of ['src/core/tracking/trackVideoLayer.ts', 'src/core/tracking/smoothStabilize.ts']) {
      expect(read(w)).toContain('planAnalysisDecode');
    }
    for (const w of ['src/core/tracking/sceneEditDetectLayer.ts', 'src/core/tracking/rotoBrush.ts']) {
      expect(read(w)).not.toContain('planAnalysisDecode');
    }
  });

  it('exactly two viewport hosts opt in, and they are the ones we think', () => {
    // If this count changes, a third render surface started using proxies and
    // someone has to decide deliberately whether that surface is an output.
    const hosts = ['src/layout/Workspace/useWorkspace.ts', 'src/layout/Workspace/useViewportRenderer.ts'];
    for (const h of hosts) expect(read(h)).toContain('useProxies: useProxies');
  });
});
