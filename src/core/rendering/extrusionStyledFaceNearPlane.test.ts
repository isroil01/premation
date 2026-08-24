/**
 * The seam between two fixes that neither one owns.
 *
 * `32d3f00` made the near-plane guard drop extrusion slices and faces whose
 * origin falls behind the camera. `1a32ab6` made those same faces take their
 * fill from the layer's STYLED surface colour rather than its raw fill, so a
 * Colour Overlay reaches the walls and back cap instead of repainting only the
 * front.
 *
 * The two meet at the same loop and were written by different sessions, so
 * nobody wrote the test for what happens when a STYLED face is also a DROPPED
 * face. The failure it would guard against is quiet: faces are synthesized per
 * frame, so a mistake here shows up as one wall of an extruded object flicking
 * to the wrong colour as the camera moves past it, which reads as a lighting
 * artefact rather than a fill bug.
 *
 * The rule being pinned: dropping is all-or-nothing per face. A face is either
 * absent, or present carrying the styled fill. There is no state where a face
 * survives the guard with the pre-overlay colour.
 */

import { buildSnapshot } from './buildSnapshot';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { DEFAULT_COLOR_OVERLAY, styledSurfaceFill, type LayerStyles } from '@core/effects/layerStyles';

// These cases pin the QUAD-SYNTHESIS extrusion (scene/extrusion.ts), which is
// now the FALLBACK behind the mesh path (scene/extrusionMesh.ts) — taken when
// an outline cannot be produced. The fallback is still live code, so its
// guarantees are kept by switching the mesh path off for this file.
import { setExtrusionMeshPath } from '@core/scene/extrusionMesh';
beforeAll(() => setExtrusionMeshPath(false));
afterAll(() => setExtrusionMeshPath(true));

const W = 1920;
const H = 1080;
const FOCAL = 2666.5025797583758;
const BASE_FILL = '#2b7eff';
const OVERLAY = '#ff2d55';

/** A Colour Overlay at full strength — the face fill should read as OVERLAY. */
const STYLES: LayerStyles = {
  colorOverlay: { ...DEFAULT_COLOR_OVERLAY, enabled: true, color: OVERLAY, opacity: 1 },
} as LayerStyles;

function node(
  id: string,
  kind: string,
  parent: string | null,
  props: Record<string, unknown>,
  styles?: LayerStyles,
): SceneNode {
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: kind, x: 0, y: 0, rotation: 0, ...props } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: BASE_FILL } },
      // Layer styles live on an `fx` component, not on Style — `readNodeLayerStyles`
      // looks for exactly that, and a Style-borne copy resolves to undefined.
      ...(styles ? [{ id: `${id}_f`, type: 'fx', props: { layerStyles: styles } }] : []),
    ],
  } as unknown as SceneNode;
}

const three = (p: Record<string, unknown> = {}) => ({ z: 0, rotationX: 0, rotationY: 0, ...p });

/**
 * An extruded, overlaid box turned 180° about Y so its body extrudes back
 * TOWARD the viewer, with the eye at `camZ`. Depth 200 with the eye at −50
 * straddles deliberately: the front cap and side walls stay in front, the back
 * cap crosses behind. `camZ` far back keeps every face in front.
 */
function faces(camZ: number) {
  const g = new SceneGraph();
  g.addNode(node('root', 'group', null, {}));
  g.addChild('root', node('box', 'shape', 'root', {
    x: W / 2, y: H / 2, width: 300, height: 300,
    ...three({ z: 100, rotationY: 180 }), extrusionDepth: 200,
  }, STYLES));
  g.addChild('root', node('cam', 'camera', 'root', {
    x: W / 2, y: H / 2, z: camZ, focalLength: FOCAL,
  }));
  const snap = buildSnapshot(g, new AnimationEngine(), 0, undefined, undefined, undefined, undefined, {
    width: W, height: H, background: '#101014', rootId: 'root',
  } as never);
  return snap.layers.filter((l) => l.id.startsWith('box::ext'));
}

describe('a styled extrusion face is either absent or correctly styled', () => {
  /** What the walls should be tinted from, per styledSurfaceFill. */
  const expectedFill = styledSurfaceFill(STYLES, BASE_FILL);

  it('the overlay colour is genuinely different from the raw fill', () => {
    // Guards the guard: if these matched, every assertion below would pass on a
    // build where the overlay never reached the faces at all.
    expect(expectedFill.toLowerCase()).not.toBe(BASE_FILL.toLowerCase());
    expect(expectedFill.toLowerCase()).toBe(OVERLAY.toLowerCase());
  });

  it('with every face in front of the camera, all of them carry the styled fill', () => {
    const all = faces(-FOCAL);
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(String(f.fill).toLowerCase()).toBe(expectedFill.toLowerCase());
  });

  it('with the camera pushed in, the crossing face is ABSENT — not mis-filled', () => {
    const far = faces(-FOCAL);
    const near = faces(-50);
    // Something was dropped: the near case has strictly fewer faces.
    expect(near.length).toBeLessThan(far.length);
    expect(near.length).toBeGreaterThan(0);
    // …and every face that survived still carries the styled fill. A face that
    // came back with BASE_FILL would mean the two fixes had interleaved wrongly.
    for (const f of near) expect(String(f.fill).toLowerCase()).toBe(expectedFill.toLowerCase());
  });

  it('no surviving face sits at the near-plane clamp', () => {
    // The other half of "absent, not mis-drawn": a face that escaped the guard
    // would report depth pinned at NEAR and a focal-length scale.
    for (const f of faces(-50)) {
      expect(f.depth).toBeGreaterThan(1);
      expect(Math.abs(f.scaleY)).toBeLessThan(2000);
    }
  });
});
