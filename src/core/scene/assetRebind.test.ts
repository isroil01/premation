/**
 * Re-binding layer media to live asset urls after a load.
 *
 * The contract: a component naming an asset by id gets that asset's CURRENT
 * src, but only when the stored one is dead-on-arrival (`blob:` or empty) —
 * durable srcs (http, data:, /files/, packaged) are the document's business
 * and stay untouched. Audio's `__`-prefixed pair follows the same rule.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { rebindAssetSrcs } from './assetRebind';
import type { SceneNode } from '@core/types';

function addRoot(id: string): void {
  defaultSceneGraph.addNode({
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_t`, type: 'Transform', props: {} }],
  } as unknown as SceneNode);
}

function addLayer(id: string, parent: string, props: Record<string, unknown>, extra?: { type: string; props: Record<string, unknown> }): void {
  defaultSceneGraph.addChild(parent, {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props },
      ...(extra ? [{ id: `${id}_x`, type: extra.type, props: extra.props }] : []),
    ],
  } as unknown as SceneNode);
}

const propsOf = (id: string, type = 'Transform'): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === type)!.props as Record<string, unknown>;

describe('rebindAssetSrcs', () => {
  const ids: string[] = [];
  const root = (name: string): string => { ids.push(name); return name; };
  afterEach(() => {
    for (const id of ids.splice(0)) defaultSceneGraph.removeNode(id);
  });

  it('repoints a dead blob src at the live asset url', () => {
    addRoot(root('rb_root'));
    addLayer('rb_vid', 'rb_root', { assetId: 'a1', src: 'blob:http://old/dead' });

    const fixed = rebindAssetSrcs([{ id: 'a1', src: 'blob:http://new/live' }]);

    expect(fixed).toBe(1);
    expect(propsOf('rb_vid').src).toBe('blob:http://new/live');
  });

  it('rebinds an empty src too, but never a durable one', () => {
    addRoot(root('rb_root'));
    addLayer('rb_empty', 'rb_root', { assetId: 'a1', src: '' });
    addLayer('rb_http', 'rb_root', { assetId: 'a1', src: 'https://cdn/clip.mp4' });
    addLayer('rb_files', 'rb_root', { assetId: 'a1', src: '/files/clip.mp4' });

    const fixed = rebindAssetSrcs([{ id: 'a1', src: 'blob:http://new/live' }]);

    expect(fixed).toBe(1);
    expect(propsOf('rb_empty').src).toBe('blob:http://new/live');
    expect(propsOf('rb_http').src).toBe('https://cdn/clip.mp4');
    expect(propsOf('rb_files').src).toBe('/files/clip.mp4');
  });

  it('leaves a layer alone when its asset is not in the library — missing-assets territory', () => {
    addRoot(root('rb_root'));
    addLayer('rb_orphan', 'rb_root', { assetId: 'gone', src: 'blob:http://old/dead' });

    expect(rebindAssetSrcs([{ id: 'a1', src: 'blob:http://new/live' }])).toBe(0);
    expect(propsOf('rb_orphan').src).toBe('blob:http://old/dead');
  });

  it("follows audio's __-prefixed pair", () => {
    addRoot(root('rb_root'));
    addLayer('rb_aud', 'rb_root', {}, { type: 'Audio', props: { __assetId: 'a2', __src: 'blob:http://old/dead' } });

    const fixed = rebindAssetSrcs([{ id: 'a2', src: 'blob:http://new/audio' }]);

    expect(fixed).toBe(1);
    expect(propsOf('rb_aud', 'Audio').__src).toBe('blob:http://new/audio');
  });

  it('is idempotent — a second pass finds nothing to fix', () => {
    addRoot(root('rb_root'));
    addLayer('rb_vid', 'rb_root', { assetId: 'a1', src: 'blob:http://old/dead' });
    const assets = [{ id: 'a1', src: 'blob:http://new/live' }];

    expect(rebindAssetSrcs(assets)).toBe(1);
    expect(rebindAssetSrcs(assets)).toBe(0);
  });
});
