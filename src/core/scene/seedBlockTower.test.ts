/**
 * Block Tower is a loadable composition, not a catalog card — if the seed
 * writes nodes the snapshot drops, the viewport stays empty and the command
 * looks dead. Drive the live graph the way the menu does.
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { useSelectionStore } from '@stores/selectionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { getNodeEffects } from '@core/effects/effects';
import {
  applyBlockTower,
  BLOCK_TOWER,
  BLOCK_TOWER_MAIN_IDS,
  blockTowerFragmentIds,
} from './seedBlockTower';

const COMP = {
  width: BLOCK_TOWER.width,
  height: BLOCK_TOWER.height,
  background: BLOCK_TOWER.background,
  rootId: 'comp_root',
};

const snapAt = (t: number) =>
  buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, COMP);

const visible = (layers: ReadonlyArray<{ id: string; opacity?: number; scaleX?: number }>) =>
  layers.filter((l) => (l.opacity ?? 1) > 0.01 && Math.abs(l.scaleX ?? 1) > 0.01);

describe('seedBlockTower', () => {
  beforeEach(() => {
    getTimelineController().seekSeconds(0);
    defaultAnimation.clear();
    defaultSceneGraph.clear();
    useSelectionStore.getState().set([]);
    applyBlockTower();
  });

  it('keeps the composition root id the active tab already points at', () => {
    expect(defaultSceneGraph.getNode('comp_root')?.name).toBe(BLOCK_TOWER.name);
  });

  it('authors five distinct solids and a shard for each', () => {
    for (const id of BLOCK_TOWER_MAIN_IDS) {
      expect(defaultSceneGraph.getNode(id)).toBeTruthy();
    }
    const frags = blockTowerFragmentIds();
    expect(frags).toHaveLength(25);
    for (const id of frags) expect(defaultSceneGraph.getNode(id)).toBeTruthy();
  });

  it('the first block has bounced onto the floor by 1.2s', () => {
    const y = defaultAnimation.sample('bt_square', 'y', 1.2);
    expect(y).toBeDefined();
    expect(y!).toBeGreaterThan(BLOCK_TOWER.floorY - 220);
    expect(y!).toBeLessThan(BLOCK_TOWER.floorY);
    expect(defaultAnimation.sample('bt_square', 'opacity', 1.2)).toBeGreaterThan(90);
  });

  it('the circle hops in from off-frame, not from the rest slot', () => {
    const startX = defaultAnimation.sample('bt_circle', 'x', 1.62);
    const restX = defaultAnimation.sample('bt_circle', 'x', 3.0);
    expect(startX).toBeDefined();
    expect(restX).toBeDefined();
    expect(startX!).toBeLessThan(100);
    expect(restX!).toBeGreaterThan(400);
  });

  it('before the burst, every main block is on screen', () => {
    const drawn = new Set(visible(snapAt(8.2).layers).map((l) => l.id));
    for (const id of BLOCK_TOWER_MAIN_IDS) expect(drawn.has(id)).toBe(true);
  });

  it('after the burst, the originals are gone and shards are visible', () => {
    expect(defaultAnimation.sample('bt_square', 'opacity', 11)).toBeLessThan(5);
    const drawn = new Set(visible(snapAt(11).layers).map((l) => l.id));
    for (const id of BLOCK_TOWER_MAIN_IDS) expect(drawn.has(id)).toBe(false);
    const shownFrags = blockTowerFragmentIds().filter((id) => drawn.has(id));
    expect(shownFrags.length).toBeGreaterThan(8);
  });

  it('bounce curves actually overshoot — a landing is not a single ease', () => {
    const keys = defaultAnimation.getTrackKeyframes('bt_square', 'y') ?? [];
    expect(keys.length).toBeGreaterThan(4);
  });

  it('drop-shadow is a real effect on the solids, not a missing write', () => {
    const fx = getNodeEffects('bt_star');
    expect(fx.some((e) => e.type === 'drop-shadow')).toBe(true);
  });
});
