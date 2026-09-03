/**
 * Ambient occlusion — does the contact between two surfaces actually darken?
 *
 * ── What the pair isolates ──────────────────────────────────────────────────
 *
 * Both frames have the same geometry, the same camera and the same lights.
 * They differ in ONE property: the composition's `ssao.enabled`. So the
 * difference between them is the whole of the feature, and `-off` is a real
 * control rather than an empty frame — it is the same corner, lit the same way,
 * with nothing occluding anything.
 *
 * That also makes `-off` the assertion nothing else can make: SSAO widens the
 * shade tail of every lit-3d material and adds two bindings to every lit-3d
 * pipeline, in comps that will never turn it on. If a future edit moves the AO
 * term out from behind `aoParams.x`, this frame changes — and it is a scene
 * whose reference was blessed while the feature was off, so the failure points
 * at the gate rather than at the lighting.
 *
 * ── Why the rig is ambient-heavy ────────────────────────────────────────────
 *
 * Because AO multiplies AMBIENT light and nothing else. A scene lit only by a
 * spot would compute the buffer, sample it, and multiply it into a term that is
 * zero — the two frames would come out identical and would have certified a
 * feature that does not run. The ambient here is the dominant light and the
 * parallel is a weak fill, so the corner is bright enough to darken.
 *
 * ── Why the geometry is what it is ──────────────────────────────────────────
 *
 * A CORNER, not a floating box: AO is a statement about two surfaces near each
 * other, and a single object in empty space has nothing to be occluded by. The
 * floor and the back wall meet behind a box that sits on the floor, so the
 * frame contains three separate contacts — floor-to-wall, box-to-floor and
 * box-to-wall — at three different depths. A halo bug shows up on one of them
 * even when the other two look plausible.
 *
 * Every surface sets `acceptsLights` explicitly. It is OFF by default
 * (`acceptsLightsFlag` requires an explicit true), and an unlit surface has no
 * ambient term for AO to multiply — the same trap `shadow-map-spot` documents,
 * one term further along.
 *
 * The radius is 90 comp px against a 120 px box on a 480×360 comp: large enough
 * that the darkening is several pixels wide at this size (a 20 px radius is
 * sub-pixel once the half-res buffer has downsampled it, and the pair would
 * differ by a rounding), small enough that it stays a contact shadow rather
 * than a global tint.
 */

import { defineScene, node, type Scene } from '../sceneKit';

const SIZE = { w: 480, h: 360 };
const CENTER = { x: 240, y: 180 };
const BG = '#0c0c12';

// The pair shares one graph; only `comp()` differs, so the flag lives there.
function build(): Scene['build'] {
  return (graph) => {
    /*
      The lights go FIRST, and the order is load-bearing for the same reason it
      is in `shadow-map-spot`: a light also emits a comp-sized WASH layer, and
      the wash keeps its slot in the layer stack while the 3D layers sort by
      depth around it. Adding the lights ahead of the geometry pins both washes
      to the back in BOTH frames, so the only thing that can differ is the AO.
    */
    graph.addNode(node('amb', {
      kind: 'light',
      position: CENTER,
      transform: { lightType: 'ambient', intensity: 85 },
      style: { fill: '#ffffff' },
    }));
    // A weak parallel fill, so the surfaces are not flat-shaded slabs and the
    // AO reads as darkening rather than as the only shading in the frame.
    graph.addNode(node('key', {
      kind: 'light',
      position: CENTER,
      transform: {
        lightType: 'parallel', intensity: 35, z: -600,
        poiX: 240, poiY: 260, poiZ: 300,
      },
      style: { fill: '#ffffff' },
    }));
    // The back wall: a plane at the far end of the run, facing the camera.
    graph.addNode(node('wall', {
      kind: 'shape',
      position: CENTER,
      transform: {
        width: 460, height: 340, shapeType: 'rect', z: 320,
        acceptsLights: true, diffuse: 100, ambient: 100,
      },
      style: { fill: '#c8ccd8' },
    }));
    // The floor: the same plane rotated back under the camera, meeting the wall
    // along its far edge.
    graph.addNode(node('floor', {
      kind: 'shape',
      position: { x: 240, y: 300 },
      transform: {
        width: 460, height: 340, shapeType: 'rect', z: 150, rotationX: 90,
        acceptsLights: true, diffuse: 100, ambient: 100,
      },
      style: { fill: '#b4b8c4' },
    }));
    // The box, sitting on the floor and standing off the wall — so its base and
    // its back edge are two contacts at different depths.
    graph.addNode(node('box', {
      kind: 'shape',
      position: { x: 210, y: 235 },
      transform: {
        width: 120, height: 120, shapeType: 'rect', z: 170,
        acceptsLights: true, diffuse: 100, ambient: 100,
      },
      style: { fill: '#4ad0a0' },
    }));
    graph.addNode(node('cam', { kind: 'camera', position: CENTER, transform: { z: -900, focalLength: 900 } }));
  };
}

function comp(on: boolean): Scene['comp'] {
  return {
    width: 480,
    height: 360,
    background: BG,
    // Absent, not `enabled: false`, in the control — a comp that never opted in
    // must reach `buildSnapshot` with no `ssao` key at all, which is the state
    // every project on disk is in.
    ...(on ? { ssao: { enabled: true, radius: 90, intensity: 1.2, quality: 'full' as const } } : {}),
  };
}

/**
 * Blessed from the GPU, and it has to be: there is no Canvas2D oracle for this.
 * The deleted Canvas2D backend shaded a lit plane per QUAD — one flat tint for
 * the whole layer — so it could not express a per-fragment ambient term at all,
 * let alone one modulated by a screen-space buffer.
 */
function ssaoScene(id: string, description: string, on: boolean): Scene {
  return defineScene({
    id,
    description,
    size: SIZE,
    comp: comp(on),
    fps: 30,
    frames: [0],
    oracle: 'gpu',
    build: build(),
  });
}

export const ssaoScenes: Scene[] = [
  ssaoScene(
    'ssao-corner',
    'A box on a floor in a corner under an ambient-heavy rig, with Ambient Occlusion ON: '
    + 'the contacts darken.',
    true,
  ),
  ssaoScene(
    'ssao-corner-off',
    'The same corner with Ambient Occlusion off — the control the pair is measured against, '
    + 'and the frame that proves the shade tail is a no-op when nothing opted in.',
    false,
  ),
];
