/**
 * Template preview path — the gallery card builds each template's layout in
 * ISOLATION and hands it to the engine as a preview document. The picture is
 * the engine's (every template is drawn on the real binary in
 * core/engine/__tests__/previewDocumentNative.test.ts); here the two
 * properties that matter on the page side:
 *  • the preview document really carries the template's layers and keys, and
 *  • building it never mutates the live singleton scene (no wiping the user's
 *    work).
 */

import SceneGraph from '@core/scene/SceneGraph';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { TEMPLATES } from './registry';
import { templatePreviewSpec } from './templatePreview';
import { buildPreviewScene } from './previewController';

describe('template preview', () => {
  for (const t of TEMPLATES) {
    it(`${t.name}: the preview document holds the template's layers in its own composition`, () => {
      const scene = buildPreviewScene(templatePreviewSpec(t));
      const doc = JSON.parse(scene.doc.json) as {
        scene: { nodes: Array<{ id: string; parent: string | null }> };
        animation: { tracks: Record<string, unknown> };
        comps: Record<string, { width: number; height: number }>;
      };
      expect(scene.doc.compId).toBe('tpl_root');
      expect(doc.comps.tpl_root).toMatchObject({ width: t.width, height: t.height });
      expect(doc.scene.nodes.filter((n) => n.parent !== null).length).toBeGreaterThan(0);
      if (t.animate) {
        expect(Object.keys(doc.animation.tracks).length).toBeGreaterThan(0);
        expect(scene.duration).toBeGreaterThan(0);
      }
      if (t.previewTime !== undefined) expect(scene.posterTime).toBe(t.previewTime);
    });

    it(`${t.name}: building the preview does not mutate the live scene`, () => {
      const nodesBefore = defaultSceneGraph.size;
      const tracksBefore = JSON.stringify(defaultAnimation.snapshot());
      t.layout(new SceneGraph());
      buildPreviewScene(templatePreviewSpec(t));
      expect(defaultSceneGraph.size).toBe(nodesBefore);
      expect(JSON.stringify(defaultAnimation.snapshot())).toBe(tracksBefore);
    });
  }
});
