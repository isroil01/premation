/**
 * Template preview path — the gallery thumbnail renders each template's layout
 * through the real snapshot pipeline in ISOLATION. jsdom has no canvas 2d, so we
 * can't rasterize here; instead we verify the two properties that matter:
 *  • layout() into a throwaway graph yields real render layers (not empty), and
 *  • it never mutates the live singleton scene (no wiping the user's work).
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot } from '@core/rendering/buildSnapshot';
import { TEMPLATES } from './registry';

describe('template preview', () => {
  for (const t of TEMPLATES) {
    it(`${t.name}: layout renders visible layers in a throwaway graph`, () => {
      const g = new SceneGraph();
      t.layout(g);
      const snap = buildSnapshot(
        g, new AnimationEngine(), 0, undefined, undefined,
        { scale: 0.1, offsetX: 0, offsetY: 0 }, undefined,
        { rootId: 'tpl_root', width: t.width, height: t.height, background: 'rgba(0,0,0,0)' },
      );
      expect(snap.layers.length).toBeGreaterThan(0);
    });

    it(`${t.name}: layout does not mutate the live scene`, () => {
      const before = defaultSceneGraph.size;
      t.layout(new SceneGraph());
      expect(defaultSceneGraph.size).toBe(before);
    });
  }
});
