/**
 * The menu / library inserts as engine clients (sceneInsert.ts `build*` laid
 * into a FragmentBuilder against the mirror's insert frame) build fragments
 * the engine takes — each pastes as ONE undoable entry with every built layer,
 * and insertFragment selects what it inserted. (The parity with the legacy
 * off-document inserts went with the page replica, block 3.)
 */

import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/appEngine';
import {
  build3DPrimitive, build3DText, buildAudio, buildCamera, buildFootage, buildImageNode, buildImageSequence, buildLight,
  buildPrimitive, buildShape, buildSolid, buildSvgDocument, buildSvgIconGroup, buildText, buildSettingsSolid, type ShapeKind,
} from '@core/scene/sceneInsert';
import type { Command } from '@motion/engine-api';
import { useSelectionStore } from '@stores/selectionStore';
import { useInfoStore } from '@stores/infoStore';
import type { ImportedAsset } from '@stores/assetStore';
import { FragmentBuilder } from './fragmentBuilder';
import { insertFragment, insertFrame, type InsertFrame } from './insertFragment';
import type { LayerSink } from './layerSink';

let h: Harness;
beforeEach(async () => {
  h = await setupAppEngine();
  useInfoStore.getState().clear();
});
afterEach(async () => {
  await h.dispose();
});

/**
 * The builder's fragment is one the ENGINE takes: it pastes into the
 * composition as one undoable entry, creating every built layer.
 */
async function expectPastes(mine: (b: LayerSink, f: InsertFrame) => unknown): Promise<void> {
  const b = new FragmentBuilder({ idPrefix: 't' });
  mine(b, insertFrame('comp_root'));
  const built = b.build();
  expect(built).not.toBeNull();
  const before = await h.doc();
  const r = await h.client.execute({ type: 'pasteLayers', comp: 'comp_root', fragment: built!.fragment } as Command);
  expect(r.ok ? 'ok' : r.error.message).toBe('ok');
  const layers = r.ok ? ((r.value as { layers?: string[] }).layers ?? []) : [];
  expect(layers).toHaveLength(built!.scratchIds.length);
  await h.run({ type: 'undo' });
  expect(await h.doc()).toBe(before);
}

const ANIMATED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="10" y="10" width="30" height="30" fill="#f00"><animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite"/></rect>
  <path d="M10 80 L90 80" stroke="#00f" stroke-width="4" fill="none" stroke-dasharray="80" stroke-dashoffset="80"><animate attributeName="stroke-dashoffset" from="80" to="0" dur="2s" fill="freeze"/></path>
  <circle cx="70" cy="30" r="12" fill="#0f0"/>
</svg>`;
const STATIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="120" height="80"><rect width="10" height="10" fill="#123"/></svg>`;

describe('sceneInsert builders as engine clients', () => {
  it.each<ShapeKind>(['rect', 'ellipse', 'line', 'star', 'heart', 'crescent'])('shape %s', async (shape) => {
    await expectPastes((b, f) => buildShape(b, f, shape, 'S', { x: 300, y: 200 }));
  });

  it('text, primitive, solid, 3D text', async () => {
    await expectPastes((b, f) => buildText(b, f, 'Title', 96, 800, { fill: '#ff0000', letterSpacing: 4 }));
    await expectPastes((b, f) => buildPrimitive(b, f, 'shape', 'Shape'));
    await expectPastes((b, f) => buildPrimitive(b, f, 'text', 'Text'));
    await expectPastes((b, f) => buildSolid(b, f, '#00ff00'));
    await expectPastes((b, f) => build3DText(b, f, 'HELLO'));
    const values = { name: ' Matte ', labelColor: '#ff0000', width: 400.4, height: 99999, color: '#00ff00' };
    await expectPastes((b, f) => buildSettingsSolid(b, f, values));
  });

  it('places under the pointer when it is over the canvas', async () => {
    useInfoStore.getState().set({ present: true, x: 123, y: 45 });
    await expectPastes((b, f) => buildPrimitive(b, f, 'shape', 'Shape'));
  });

  it('3D primitives (the mesh box is what syncPrimitiveLayerBox would write)', async () => {
    await expectPastes((b, f) => build3DPrimitive(b, f, 'cube'));
    await expectPastes((b, f) => build3DPrimitive(b, f, 'sphere', { radius: 90 }));
  });

  it('camera and lights (with and without the ambient fill)', async () => {
    await expectPastes((b, f) => buildCamera(b, f, { name: 'Cam', focalLength: 1200, twoNode: true }));
    await expectPastes((b, f) => buildLight(b, f, { name: 'Key', type: 'spot', coneAngle: 30, compHasAmbient: false }));
    await expectPastes((b, f) => buildLight(b, f, { name: 'Key', ambientFill: false, compHasAmbient: false }));
    await expectPastes((b, f) => buildLight(b, f, { name: 'Sky', type: 'environment', compHasAmbient: false }));
  });

  it('media: audio, video (contain-fit), image node, image sequence', async () => {
    const audio = { id: 'a1', name: 'beat.wav', type: 'audio', src: 'blob:a', metadata: { duration: 4 } } as unknown as ImportedAsset;
    await expectPastes((b, f) => buildAudio(b, f, audio));
    const video = { id: 'v1', name: 'clip.mp4', type: 'video', src: 'blob:v', metadata: { width: 3840, height: 2160, duration: 3 } } as unknown as ImportedAsset;
    await expectPastes((b, f) => buildFootage(b, f, video));
    await expectPastes((b, f) => buildImageNode(b, f, { name: 'Img', src: 'data:x', width: 64, height: 32, x: 10, y: 20 }), );
    await expectPastes((b, f) => buildImageSequence(b, f, 'seq', ['u1', 'u2'], { w: 10, h: 20 }, 24));
  });

  it('SVG documents: a static one stored intact, an animated one as an icon group with keys', async () => {
    await expectPastes((b, f) => buildSvgDocument(b, f, STATIC_SVG, 'logo.svg'));
    await expectPastes((b, f) => buildSvgDocument(b, f, ANIMATED_SVG, 'anim.svg', { sizeHint: 300 }));
    await expectPastes((b, f) => buildSvgIconGroup(b, f, ANIMATED_SVG, 'icon', { x: 50, y: 60 }));
    // The icon carries its animation: an opacity track and a draw-on on a trim operator.
    const b = new FragmentBuilder();
    buildSvgIconGroup(b, insertFrame('comp_root'), ANIMATED_SVG, 'icon');
    const tracks = b.build()!.layers.flatMap((l) => Object.keys(l.anim?.tracks ?? {}));
    expect(tracks).toContain('opacity');
    expect(tracks.some((t) => t.startsWith('pathop.'))).toBe(true);
  });

  it('insertFragment pastes ONE undoable entry and selects the built layer', async () => {
    const entries = (await historyLabels()).length;
    const before = (await h.doc());
    const ids = await insertFragment('Insert Star', (b, f) => buildShape(b, f, 'star', 'Star'));
    expect(ids).toHaveLength(1);
    expect(useSelectionStore.getState().ids).toEqual(ids);
    expect((await historyLabels()).length).toBe(entries + 1);
    expect((await historyLabels()).at(-1)).toBe('Insert Star');
    await h.run({ type: 'undo' });
    expect((await h.doc())).toEqual(before);
  });
});
