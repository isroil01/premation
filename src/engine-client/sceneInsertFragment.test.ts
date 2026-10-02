/**
 * The menu / library inserts as engine clients (sceneInsert.ts `build*` laid
 * into a FragmentBuilder against the mirror's insert frame) build the SAME
 * fragment as the legacy inserts run off-document over the page replica
 * (offDocument.ts buildLayerFragment) — and paste as ONE undoable entry with
 * the inserted layer selected.
 */

import { buildLayerFragment } from '@core/engine/offDocument';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import {
  build3DPrimitive, build3DText, buildAudio, buildCamera, buildFootage, buildImageNode, buildImageSequence, buildLight,
  buildPrimitive, buildShape, buildSolid, buildSvgDocument, buildSvgIconGroup, buildText,
  insert3DPrimitive, insert3DText, insertAudio, insertCamera, insertImageNode, insertLight, insertMedia, insertPrimitive,
  insertShape, insertSolid, insertSvgDocument, insertSvgShapeGroup, insertText, legacySink, type ShapeKind,
} from '@core/scene/sceneInsert';
import { syncPrimitiveLayerBox } from '@core/scene/primitiveLayer';
import { buildSolidLayer } from '@core/scene/layerSettings';
import { buildSettingsSolid } from '@core/scene/sceneInsert';
import { useCompositionStore } from '@stores/compositionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useInfoStore } from '@stores/infoStore';
import { useAssetStore, type ImportedAsset } from '@stores/assetStore';
import { FragmentBuilder } from './fragmentBuilder';
import { insertFragment, insertFrame, type InsertFrame } from './insertFragment';
import type { LayerSink } from './layerSink';
import { normalizeFragment } from './__testHelpers__/fragmentParity';

let h: Harness & { engine: LocalEngine };
beforeEach(async () => {
  h = await setupAppEngine();
  useInfoStore.getState().clear();
});
afterEach(async () => {
  await h.dispose();
});

function frames(): number {
  const c = useCompositionStore.getState().comp();
  return Math.round(c.durationSeconds * c.fps);
}

/** Legacy (off-document over the replica) vs client (FragmentBuilder over the mirror's frame). */
function expectParity(legacy: () => unknown, mine: (b: LayerSink, f: InsertFrame) => unknown): void {
  const old = buildLayerFragment('comp_root', legacy);
  const b = new FragmentBuilder({ idPrefix: 't' });
  mine(b, insertFrame('comp_root'));
  const built = b.build();
  expect(old).not.toBeNull();
  expect(built).not.toBeNull();
  expect(built!.scratchIds.length).toBe(old!.scratchIds.length);
  expect(normalizeFragment(built!.fragment, frames())).toEqual(normalizeFragment(old!.fragment, frames()));
}

const ANIMATED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="10" y="10" width="30" height="30" fill="#f00"><animate attributeName="opacity" from="1" to="0" dur="1s" repeatCount="indefinite"/></rect>
  <path d="M10 80 L90 80" stroke="#00f" stroke-width="4" fill="none" stroke-dasharray="80" stroke-dashoffset="80"><animate attributeName="stroke-dashoffset" from="80" to="0" dur="2s" fill="freeze"/></path>
  <circle cx="70" cy="30" r="12" fill="#0f0"/>
</svg>`;
const STATIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="120" height="80"><rect width="10" height="10" fill="#123"/></svg>`;

describe('sceneInsert builders as engine clients', () => {
  it.each<ShapeKind>(['rect', 'ellipse', 'line', 'star', 'heart', 'crescent'])('shape %s', (shape) => {
    expectParity(() => insertShape(shape, 'S', { x: 300, y: 200 }), (b, f) => buildShape(b, f, shape, 'S', { x: 300, y: 200 }));
  });

  it('text, primitive, solid, 3D text', () => {
    expectParity(() => insertText('Title', 96, 800, { fill: '#ff0000', letterSpacing: 4 }), (b, f) => buildText(b, f, 'Title', 96, 800, { fill: '#ff0000', letterSpacing: 4 }));
    expectParity(() => insertPrimitive('shape', 'Shape'), (b, f) => buildPrimitive(b, f, 'shape', 'Shape'));
    expectParity(() => insertPrimitive('text', 'Text'), (b, f) => buildPrimitive(b, f, 'text', 'Text'));
    expectParity(() => insertSolid('#00ff00'), (b, f) => buildSolid(b, f, '#00ff00'));
    expectParity(() => insert3DText('HELLO'), (b, f) => build3DText(b, f, 'HELLO'));
    const values = { name: ' Matte ', labelColor: '#ff0000', width: 400.4, height: 99999, color: '#00ff00' };
    expectParity(() => buildSolidLayer(values), (b, f) => buildSettingsSolid(b, f, values));
  });

  it('places under the pointer when it is over the canvas', () => {
    useInfoStore.getState().set({ present: true, x: 123, y: 45 });
    expectParity(() => insertPrimitive('shape', 'Shape'), (b, f) => buildPrimitive(b, f, 'shape', 'Shape'));
  });

  it('3D primitives (the mesh box is what syncPrimitiveLayerBox would write)', () => {
    expectParity(() => insert3DPrimitive('cube'), (b, f) => build3DPrimitive(b, f, 'cube'));
    expectParity(() => {
      insert3DPrimitive('sphere', { radius: 90 });
      syncPrimitiveLayerBox(useSelectionStore.getState().ids[0]!);
    }, (b, f) => build3DPrimitive(b, f, 'sphere', { radius: 90 }));
  });

  it('camera and lights (with and without the ambient fill)', () => {
    expectParity(() => insertCamera({ name: 'Cam', focalLength: 1200, twoNode: true }), (b, f) => buildCamera(b, f, { name: 'Cam', focalLength: 1200, twoNode: true }));
    expectParity(() => insertLight({ name: 'Key', type: 'spot', coneAngle: 30 }), (b, f) => buildLight(b, f, { name: 'Key', type: 'spot', coneAngle: 30, compHasAmbient: false }));
    expectParity(() => insertLight({ name: 'Key', ambientFill: false }), (b, f) => buildLight(b, f, { name: 'Key', ambientFill: false, compHasAmbient: false }));
    expectParity(() => insertLight({ name: 'Sky', type: 'environment' }), (b, f) => buildLight(b, f, { name: 'Sky', type: 'environment', compHasAmbient: false }));
  });

  it('media: audio, video (contain-fit), image node, image sequence', async () => {
    const audio = { id: 'a1', name: 'beat.wav', type: 'audio', src: 'blob:a', metadata: { duration: 4 } } as unknown as ImportedAsset;
    expectParity(() => insertAudio(audio), (b, f) => buildAudio(b, f, audio));
    const video = { id: 'v1', name: 'clip.mp4', type: 'video', src: 'blob:v', metadata: { width: 3840, height: 2160, duration: 3 } } as unknown as ImportedAsset;
    // The legacy bar reads the footage length off the asset record.
    useAssetStore.setState({ assets: [...useAssetStore.getState().assets, video] });
    expectParity(() => { void insertMedia(video); }, (b, f) => buildFootage(b, f, video));
    expectParity(
      () => insertImageNode({ name: 'Img', src: 'data:x', width: 64, height: 32, x: 10, y: 20 }),
      (b, f) => buildImageNode(b, f, { name: 'Img', src: 'data:x', width: 64, height: 32, x: 10, y: 20 }),
    );
    // The legacy sequence insert decodes the first frame; the builder takes its size.
    expectParity(() => {
      const f = useCompositionStore.getState();
      buildImageSequence(legacySink(), { ...insertFrame('comp_root'), width: f.width, height: f.height, comp: 'comp_root' }, 'seq', ['u1', 'u2'], { w: 10, h: 20 }, 24);
    }, (b, f) => buildImageSequence(b, f, 'seq', ['u1', 'u2'], { w: 10, h: 20 }, 24));
  });

  it('SVG documents: a static one stored intact, an animated one as an icon group with keys', () => {
    expectParity(() => insertSvgDocument(STATIC_SVG, 'logo.svg'), (b, f) => buildSvgDocument(b, f, STATIC_SVG, 'logo.svg'));
    expectParity(() => insertSvgDocument(ANIMATED_SVG, 'anim.svg', { sizeHint: 300 }), (b, f) => buildSvgDocument(b, f, ANIMATED_SVG, 'anim.svg', { sizeHint: 300 }));
    expectParity(() => insertSvgShapeGroup(ANIMATED_SVG, 'icon', { x: 50, y: 60 }), (b, f) => buildSvgIconGroup(b, f, ANIMATED_SVG, 'icon', { x: 50, y: 60 }));
    // The icon carries its animation: an opacity track and a draw-on on a trim operator.
    const b = new FragmentBuilder();
    buildSvgIconGroup(b, insertFrame('comp_root'), ANIMATED_SVG, 'icon');
    const tracks = b.build()!.layers.flatMap((l) => Object.keys(l.anim?.tracks ?? {}));
    expect(tracks).toContain('opacity');
    expect(tracks.some((t) => t.startsWith('pathop.'))).toBe(true);
  });

  it('insertFragment pastes ONE undoable entry and selects the built layer', async () => {
    const entries = historyLabels().length;
    const before = h.doc();
    const ids = await insertFragment('Insert Star', (b, f) => buildShape(b, f, 'star', 'Star'));
    expect(ids).toHaveLength(1);
    expect(useSelectionStore.getState().ids).toEqual(ids);
    expect(historyLabels().length).toBe(entries + 1);
    expect(historyLabels().at(-1)).toBe('Insert Star');
    await h.run({ type: 'undo' });
    expect(h.doc()).toEqual(before);
  });
});
