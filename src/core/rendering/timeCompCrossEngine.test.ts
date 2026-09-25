/**
 * Cross-engine parity of the time / composition family of the C++ scene
 * builder (plan D2w time/comp): composition instances (sealed recursive passes,
 * collapsed clones, Essential Properties, the cycle guard), precomp and layer
 * retime, frame blending, temporal ghosts, auto-orient, points bound to nulls,
 * Continuous Rasterization and corner pin — the features the golden suite
 * covers only in part.
 *
 * Every case is a harness-style scene (a fresh SceneGraph + AnimationEngine,
 * exported with the golden harness's own `sceneToProject`), built by
 * `buildSnapshot` + `snapshotToFrameScene` at a few frames. The fixture stores
 * the document and, per frame, a projection of the snapshot's layers and of the
 * FrameScene's renderables. `native/engine/tests/test_time_comp_parity.cpp`
 * opens the same document, runs `build_snapshot` + `build_frame_scene`, and
 * requires the same projection (and no feature reported unported).
 *
 * `GEN_NATIVE_TIME_COMP=1 npx jest timeCompCrossEngine` rewrites the fixture;
 * without it this test fails when the fixture is stale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import SceneGraph from '@core/scene/SceneGraph';
import { AnimationEngine } from '@motion/animation';
import { buildSnapshot, type SnapshotComp } from '@core/rendering/buildSnapshot';
import { snapshotToFrameScene } from '@core/rendering/snapshotToFrameScene';
import type { RenderLayer } from '@core/rendering/RenderBackend';
import type { MotionBlurConfig } from '@core/effects/motionBlur';
import { COMP_REF_PROP, COMP_COLLAPSE_PROP } from '@core/scene/compInstance';
import { useAssetStore } from '@stores/assetStore';
import { node, type Scene } from '../../../packages/render-tests/harness/sceneKit';
import { sceneToProject } from '../../../packages/render-tests/harness/sceneProject';

const OUT = path.resolve(__dirname, '../../../native/engine/tests/data/time_comp_parity.json');
const COMP = { width: 480, height: 320, background: '#101014' };
const MB: MotionBlurConfig = { enabled: true, shutterAngle: 180, shutterPhase: -90, samples: 8, adaptiveSampleLimit: 16, fps: 30 } as MotionBlurConfig;

type Build = (graph: SceneGraph, anim: AnimationEngine) => void;
interface Def { id: string; frames: number[]; build: Build; comp?: Partial<SnapshotComp>; motionBlur?: MotionBlurConfig; sizes?: Record<string, { width: number; height: number }> }

const rect = (id: string, x: number, y: number, w: number, h: number, fill: string, extra: Record<string, unknown> = {}) =>
  node(id, { kind: 'shape', position: { x, y }, transform: { width: w, height: h, shapeType: 'rect', ...extra }, style: { fill } });
const ellipse = (id: string, x: number, y: number, w: number, fill: string) =>
  node(id, { kind: 'shape', position: { x, y }, transform: { width: w, height: w, shapeType: 'ellipse' }, style: { fill } });
const instance = (id: string, ref: string, x: number, y: number, fx: Record<string, unknown> = {}, transform: Record<string, unknown> = {}) =>
  node(id, {
    kind: 'comp', position: { x, y }, transform,
    components: [{ id: `${id}_fx`, type: 'fx', props: { precomp: true, [COMP_REF_PROP]: ref, ...fx } }],
  });

/** An inner composition `inner` (200×120) with an animated rect, an ellipse and
 *  (optionally) a nested sealed instance of `deep` (80×60). */
function innerComp(graph: SceneGraph, anim: AnimationEngine, withDeep: boolean): void {
  graph.addNode(node('inner', { kind: 'group' }));
  graph.addChild('inner', rect('iRect', 50, 60, 60, 40, '#ff5d73'));
  graph.addChild('inner', ellipse('iDot', 150, 60, 50, '#5db4ff'));
  anim.setKeyframe('iRect', 'x', 0, 40);
  anim.setKeyframe('iRect', 'x', 2, 160);
  anim.setKeyframe('iRect', 'rotation', 0, 0);
  anim.setKeyframe('iRect', 'rotation', 2, 90);
  if (withDeep) {
    graph.addNode(node('deep', { kind: 'group' }));
    graph.addChild('deep', rect('dRect', 40, 30, 50, 30, '#ffd23f'));
    anim.setKeyframe('dRect', 'y', 0, 20);
    anim.setKeyframe('dRect', 'y', 2, 40);
    graph.addChild('inner', instance('iDeep', 'deep', 100, 90));
  }
}

const SIZES = { inner: { width: 200, height: 120 }, deep: { width: 80, height: 60 } };

const DEFS: Def[] = [
  {
    id: 'sealed-instance-2d',
    frames: [0, 17],
    sizes: SIZES,
    motionBlur: MB,
    build(graph, anim) {
      innerComp(graph, anim, true);
      graph.addNode(node('host', { kind: 'group' }));
      // Anchored, rotated, scaled, faded, masked and motion-blurred: every field
      // of the instance frame.
      graph.addChild('host', instance('inst', 'inner', 240, 160, {}, { rotation: 12, scaleX: 1.3, scaleY: 0.9, anchorX: 20, anchorY: -10 }));
      graph.setMotionBlur('inst', true);
      anim.setKeyframe('inst', 'x', 0, 200);
      anim.setKeyframe('inst', 'x', 1, 300);
      anim.setKeyframe('inst', 'opacity', 0, 100);
      anim.setKeyframe('inst', 'opacity', 1, 60);
      graph.setMask('inst', {
        paths: [{
          id: 'm1', mode: 'add', closed: true, feather: 0, opacity: 1, expansion: 0, inverted: false,
          points: [
            { x: -80, y: -50, inX: -80, inY: -50, outX: -80, outY: -50 },
            { x: 70, y: -40, inX: 70, inY: -40, outX: 70, outY: -40 },
            { x: 60, y: 55, inX: 60, inY: 55, outX: 60, outY: 55 },
          ],
        }],
      });
      // A second placement of the same comp: ids must not collide.
      graph.addChild('host', instance('inst2', 'inner', 120, 250));
    },
    comp: { rootId: 'host' },
  },
  {
    id: 'collapsed-and-overrides',
    frames: [0, 20],
    sizes: SIZES,
    build(graph, anim) {
      innerComp(graph, anim, true);
      graph.addNode(node('host', { kind: 'group' }));
      graph.addChild('host', rect('hBack', 240, 160, 400, 260, '#233047'));
      // Collapsed: spliced clones, centre-anchored, carrying overrides of a KEYFRAMED x and a colour.
      graph.addChild('host', instance('coll', 'inner', 150, 110, {
        [COMP_COLLAPSE_PROP]: true,
        __compOverrides: { 'iRect/x': 30, 'iDot/fill': '#00ff88', 'iDot/opacity': 50 },
      }, { rotation: -8 }));
      // Sealed with overrides: the recursive pass applies them to the real nodes.
      graph.addChild('host', instance('seal', 'inner', 340, 220, { __compOverrides: { 'iRect/x': 170, 'iRect/rotation': 45 } }));
      anim.setKeyframe('coll', 'y', 0, 100);
      anim.setKeyframe('coll', 'y', 1, 140);
    },
    comp: { rootId: 'host' },
  },
  {
    id: 'comp-card-3d',
    frames: [0, 14],
    sizes: SIZES,
    motionBlur: MB,
    build(graph, anim) {
      innerComp(graph, anim, false);
      graph.addNode(node('host', { kind: 'group' }));
      graph.addChild('host', node('cam', { kind: 'camera', position: { x: 280, y: 150 }, transform: { z: -800, focalLength: 800 } }));
      graph.addChild('host', node('lamp', {
        kind: 'light', position: { x: 60, y: 40 },
        transform: { lightType: 'point', intensity: 120, radius: 60, z: -300, lightGlow: false },
      }));
      // A 3D comp layer: rotated in Y, anchored, keyframed in X and Z, motion-blurred, lit.
      graph.addChild('host', instance('card', 'inner', 240, 160, {}, { z: 40, rotationY: 30, anchorX: 15, anchorY: 5, acceptsLights: true }));
      graph.setMotionBlur('card', true);
      anim.setKeyframe('card', 'x', 0, 180);
      anim.setKeyframe('card', 'x', 1, 300);
      anim.setKeyframe('card', 'z', 0, 40);
      anim.setKeyframe('card', 'z', 1, -120);
      // Behind the camera: not drawn.
      graph.addChild('host', instance('behind', 'inner', 240, 160, {}, { z: -1200 }));
      // The camera dollies, so every 3D card blurs through the sub-frame camera.
      anim.setKeyframe('cam', 'x', 0, 280);
      anim.setKeyframe('cam', 'x', 1, 220);
    },
    comp: { rootId: 'host' },
  },
  {
    id: 'cloners',
    frames: [0, 16],
    build(graph, anim) {
      // A radial cloner of a keyframed group (children cloned too) with a step
      // ramp, a cascade, hashed randomness and an order falloff.
      graph.addNode(node('ring', { kind: 'group', position: { x: 150, y: 160 }, rotation: 10 }));
      graph.addChild('ring', rect('petal', 0, 0, 40, 14, '#ff595e'));
      anim.setKeyframe('petal', 'rotation', 0, 0);
      anim.setKeyframe('petal', 'rotation', 1, 180);
      graph.setFxKey('ring', '__cloner', {
        enabled: true, mode: 'radial', count: 7, radius: 90, startAngle: -90, arc: 360, alignToRadius: true,
        step: { x: 0, y: 0, rotation: 30, scale: 0.6, opacity: -60, time: 0.4 },
        random: { seed: 7, position: 6, rotation: 12, scale: 0.1 },
        falloff: { shape: 'radial', source: 'order', position: 0.3, width: 0.6, invert: false },
      });
      // A grid cloner driven by a moving null's field, with push.
      graph.addNode(node('field', { kind: 'null', position: { x: 360, y: 160 } }));
      anim.setKeyframe('field', 'x', 0, 300);
      anim.setKeyframe('field', 'x', 1, 420);
      graph.addNode(ellipse('dot', 360, 160, 16, '#1982c4'));
      graph.setFxKey('dot', '__cloner', {
        enabled: true, mode: 'grid', countX: 5, countY: 4, offsetX: 30, offsetY: 30,
        step: { scale: 1 }, random: { seed: 3, position: 0, rotation: 0, scale: 0 },
        falloff: { shape: 'linear', source: 'layer', layerId: 'field', radius: 80, push: 25 },
      });
      // A plain linear cloner.
      graph.addNode(rect('bar', 240, 280, 30, 10, '#8ac926'));
      graph.setFxKey('bar', '__cloner', { enabled: true, mode: 'linear', count: 4, offsetX: 40, offsetY: -5 });
    },
  },
  {
    id: 'particle-layers',
    frames: [0, 12],
    motionBlur: MB,
    build(graph, anim) {
      graph.addNode(node('cam', { kind: 'camera', position: { x: 240, y: 160 }, transform: { z: -900, focalLength: 900 } }));
      // A 3D emitter (takes the scene lens), keyframed rate / size / colour
      // channel, a width track, motion blur on (the comp shutter), a sprite asset.
      useAssetStore.setState({ assets: [{ id: 'spark-png', name: 'spark.png', type: 'image', src: 'spark.png' }] as never });
      graph.addNode(node('emit', { kind: 'particle', position: { x: 200, y: 150 }, rotation: 15, transform: { width: 300, height: 200, z: 20 } }));
      graph.setParticle('emit', { birthRate: 40, shape: 'sprite', spriteAssetId: 'spark-png', colorStart: '#336699', seed: 4 });
      graph.setMotionBlur('emit', true);
      anim.setKeyframe('emit', 'particle.birthRate', 0, 20);
      anim.setKeyframe('emit', 'particle.birthRate', 1, 90);
      anim.setKeyframe('emit', 'particle.sizeStart', 0, 4);
      anim.setKeyframe('emit', 'particle.sizeStart', 1, 16);
      anim.setKeyframe('emit', 'particle.colorStart_r', 0, 0.1);
      anim.setKeyframe('emit', 'particle.colorStart_r', 1, 0.9);
      anim.setKeyframe('emit', 'width', 0, 300);
      anim.setKeyframe('emit', 'width', 1, 360);
      // A 2D emitter with a radius-sized box, normal transfer, a layer blend mode.
      graph.addNode(node('ring', { kind: 'particle', position: { x: 380, y: 240 }, transform: { radius: 50 } }));
      graph.setParticle('ring', { emitterType: 'circle', blend: 'normal', shape: 'square' });
      graph.setBlendMode('ring', 'screen');
    },
  },
  {
    id: 'instance-cycle-guard',
    frames: [0],
    sizes: { A: { width: 240, height: 160 }, B: { width: 160, height: 100 } },
    build(graph) {
      graph.addNode(node('A', { kind: 'group' }));
      graph.addChild('A', rect('aRect', 60, 40, 60, 40, '#ff5d73'));
      graph.addNode(node('B', { kind: 'group' }));
      graph.addChild('B', rect('bRect', 40, 30, 40, 30, '#5db4ff'));
      graph.addChild('A', instance('aB', 'B', 150, 100));
      graph.addChild('B', instance('bA', 'A', 100, 60, {}, { scaleX: 0.4, scaleY: 0.4 }));
      graph.addNode(node('host', { kind: 'group' }));
      graph.addChild('host', instance('hA', 'A', 240, 160));
    },
    comp: { rootId: 'host' },
  },
  {
    id: 'precomp-speed-retime',
    frames: [0, 12, 40],
    build(graph, anim) {
      graph.addNode(node('G', { kind: 'group' }));
      graph.addChild('G', ellipse('mover', 60, 160, 70, '#ffca3a'));
      graph.setPrecomp('G', true);
      anim.setKeyframe('mover', 'x', 0, 60);
      anim.setKeyframe('mover', 'x', 2, 420);
      // Speed %: 50 → 200 eased — the integral, not a sample.
      anim.setKeyframe('G', 'timeSpeed', 0, 50);
      anim.setKeyframe('G', 'timeSpeed', 1.5, 200);
      // A layer with its own Time Remap (sourceTime).
      graph.addNode(rect('remapped', 240, 60, 80, 40, '#8ac926'));
      anim.setKeyframe('remapped', 'timeRemap', 0, 1.5);
      anim.setKeyframe('remapped', 'timeRemap', 2, 0.25);
    },
  },
  {
    id: 'frame-mix-footage',
    frames: [7, 10],
    build(graph, anim) {
      useAssetStore.setState({
        assets: [{
          id: 'asset-clip', name: 'clip.mp4', type: 'video', src: 'clip.mp4',
          metadata: { width: 320, height: 180, fps: 24, duration: 4 },
        }] as never,
      });
      graph.addNode(node('clip', {
        kind: 'video', position: { x: 240, y: 160 },
        transform: { assetId: 'asset-clip', width: 320, height: 180 },
        style: { opacity: 100 },
      }));
      graph.setLayerTime('clip', { frameBlend: 'mix' });
      anim.setKeyframe('clip', 'timeSpeed', 0, 70);
      anim.setKeyframe('clip', 'timeSpeed', 1, 70);
    },
  },
  {
    id: 'ghosts-orient-corner-pin',
    frames: [0, 21],
    motionBlur: MB,
    build(graph, anim) {
      // Echo, Composite In Front, on an auto-oriented moving rect.
      graph.addNode(rect('echoed', 80, 80, 60, 24, '#ff595e'));
      graph.setAutoOrient('echoed', true);
      anim.setKeyframe('echoed', 'x', 0, 60);
      anim.setKeyframe('echoed', 'x', 1, 300);
      anim.setKeyframe('echoed', 'y', 0, 60);
      anim.setKeyframe('echoed', 'y', 1, 200);
      graph.setEffects('echoed', [{ id: 'e1', type: 'echo', params: { echoTime: -0.05, numEchoes: 4, startIntensity: 80, decay: 60, echoOperator: 5 } }]);
      // Wide Time on another mover.
      graph.addNode(ellipse('wide', 380, 80, 40, '#1982c4'));
      anim.setKeyframe('wide', 'y', 0, 40);
      anim.setKeyframe('wide', 'y', 1, 280);
      graph.setEffects('wide', [{ id: 'w1', type: 'wide-time', params: { forwardSteps: 2, backwardSteps: 3 } }]);
      // Corner pin on a motion-blurred rect.
      graph.addNode(rect('pinned', 240, 230, 160, 100, '#6a4c93'));
      graph.setCornerPin('pinned', [0.05, 0.1, 0.9, 0, 1, 0.85, 0.1, 1]);
      graph.setMotionBlur('pinned', true);
      anim.setKeyframe('pinned', 'x', 0, 200);
      anim.setKeyframe('pinned', 'x', 1, 280);
    },
  },
  {
    id: 'bound-points-continuous-raster',
    frames: [0, 15],
    build(graph, anim) {
      // A path whose 2nd and 4th vertices follow nulls (one parented, one keyframed).
      graph.addNode(node('pathShape', {
        kind: 'shape', position: { x: 200, y: 150 }, transform: { width: 200, height: 140, rotation: 10 },
        style: { fill: '#ffca3a' },
        components: [{
          id: 'pathShape_g', type: 'Geometry', props: {
            points: [
              { x: -80, y: -50, inX: -80, inY: -50, outX: -60, outY: -60 },
              { x: 60, y: -50, inX: 40, inY: -60, outX: 60, outY: -50 },
              { x: 80, y: 50, inX: 80, inY: 50, outX: 80, outY: 50 },
              { x: -70, y: 60, inX: -70, inY: 60, outX: -70, outY: 60 },
            ],
            open: false,
            pointBindings: [{ index: 1, nullId: 'nullA' }, { index: 3, nullId: 'nullB' }, { index: 9, nullId: 'nullA' }],
          },
        }],
      }));
      graph.addNode(node('rig', { kind: 'null', position: { x: 60, y: 40 }, rotation: 15 }));
      graph.addChild('rig', node('nullA', { kind: 'null', position: { x: 250, y: 20 } }));
      graph.addNode(node('nullB', { kind: 'null', position: { x: 120, y: 260 } }));
      anim.setKeyframe('nullB', 'x', 0, 100);
      anim.setKeyframe('nullB', 'x', 1, 160);
      // Continuous Rasterization: a stroked star scaled past the clamped ladder,
      // and the same shape without the switch.
      for (const [id, cr] of [['crOn', true], ['crOff', false]] as const) {
        graph.addNode(node(id, {
          kind: 'shape', position: { x: id === 'crOn' ? 360 : 420, y: 240 },
          transform: { width: 20, height: 20, shapeType: 'ellipse', scaleX: 6.5, scaleY: 6.5, ...(cr ? { continuousRasterize: true } : {}) },
          style: { fill: '#8ac926' },
        }));
        graph.setStroke(id, { enabled: true, width: 2, color: '#ffffff', opacity: 1 });
      }
    },
  },
];

interface Proj { [k: string]: unknown }

/** The snapshot fields the C++ port must reproduce, recursively. */
function projLayer(l: RenderLayer): Proj {
  return {
    id: l.id,
    visible: l.visible !== false,
    x: l.x, y: l.y, rotation: l.rotation, scaleX: l.scaleX, scaleY: l.scaleY,
    anchorX: l.anchorX ?? 0, anchorY: l.anchorY ?? 0,
    opacity: l.opacity, width: l.width, height: l.height,
    blend: l.blend ?? 'normal',
    sourceTime: l.sourceTime ?? null,
    frameBlend: l.frameBlend ? { a: l.frameBlend.a, b: l.frameBlend.b, weight: l.frameBlend.weight, mode: l.frameBlend.mode ?? 'mix' } : null,
    cornerPin: l.cornerPin ? [...l.cornerPin] : null,
    continuousRaster: l.continuousRaster === true,
    motionSamples: (l.motionSamples?.length ?? 0) > 1 ? l.motionSamples!.map((s) => [s.x, s.y, s.rotation, s.scaleX, s.scaleY, s.opacity]) : [],
    maskPaths: l.mask?.paths.length ?? 0,
    pathPoints: Array.isArray(l.pathPoints) ? l.pathPoints.map((p) => [p.x, p.y, p.inX, p.inY, p.outX, p.outY]) : null,
    precompScene3d: !!l.precompScene3d,
    depth: l.matrix ? l.depth : null,  // a 2D layer's depth is never read
    matrix: l.matrix ? [...l.matrix] : null,
    quad3d: l.quad3d ? [...l.quad3d] : null,
    lighting: l.lighting ? [...l.lighting] : null,
    particles: l.particles ? JSON.stringify(l.particles) : null,
    sampleQuads: (l.motionSamples?.length ?? 0) > 1 ? l.motionSamples!.map((s) => (s.quad ? [...s.quad] : null)) : [],
    precompLayers: l.precompLayers ? l.precompLayers.map(projLayer) : null,
  };
}

type R = ReturnType<typeof snapshotToFrameScene>['renderables'][number];
function projRenderable(r: R): Proj {
  return {
    id: r.id,
    kind: r.kind,
    textureKey: r.textureKey ?? null,
    maskTextureKey: r.maskTextureKey ?? null,
    modelMatrix: Array.from(r.modelMatrix as ArrayLike<number>),
    bounds: [r.bounds.x, r.bounds.y, r.bounds.width, r.bounds.height],
    opacity: r.opacity,
    blend: r.blend,
    cornerPin: r.cornerPin ? [...r.cornerPin] : null,
    motionSamples: (r.motionSamples ?? []).map((s) => [...Array.from(s.modelMatrix as ArrayLike<number>), s.opacity]),
    precomp: r.precomp
      ? {
          flat: r.precomp.flat ? [r.precomp.flat.width, r.precomp.flat.height] : null,
          projection: r.precomp.camera3d ? Array.from(r.precomp.camera3d.projection) : null,
          renderables: (r.precomp.renderables as R[]).map(projRenderable),
        }
      : null,
  };
}

function scene(def: Def): Scene {
  return {
    id: def.id,
    description: def.id,
    size: { w: COMP.width, h: COMP.height },
    comp: {
      ...COMP,
      ...(def.comp?.rootId ? { rootId: def.comp.rootId } : {}),
      ...(def.sizes ? { compSizeOf: (id: string) => def.sizes![id] } : {}),
    },
    fps: 30,
    frames: def.frames,
    ...(def.motionBlur ? { motionBlur: def.motionBlur } : {}),
    build: def.build,
  };
}

function generate(): unknown[] {
  const out: unknown[] = [];
  for (const def of DEFS) {
    useAssetStore.setState({ assets: [] });
    const sc = scene(def);
    const graph = new SceneGraph();
    const anim = new AnimationEngine();
    sc.build(graph, anim);
    const exp = sceneToProject(sc, graph, anim);
    // sceneToProject lists only the assets a node names by `assetId`; a particle
    // sprite names its asset inside the config, so the session's assets ride too.
    const harness = exp.document.harness as { assets: Array<{ id: string }> };
    for (const a of useAssetStore.getState().assets) {
      if (harness.assets.some((x) => x.id === a.id)) continue;
      harness.assets.push(JSON.parse(JSON.stringify(a)) as { id: string });
      const items = exp.document.projectItems as { footage: Record<string, unknown> };
      items.footage[a.id] = { name: a.name ?? a.id, type: a.type };
    }
    const frames = def.frames.map((f) => {
      const snap = buildSnapshot(graph, anim, f / sc.fps, undefined, undefined, undefined, sc.motionBlur, sc.comp as SnapshotComp);
      const fs = snapshotToFrameScene(snap);
      return {
        frame: f,
        errors: (snap.layerErrors ?? []).map((e) => `${e.layerId}: ${e.message}`),
        layers: snap.layers.map(projLayer),
        renderables: fs.renderables.map(projRenderable),
      };
    });
    out.push({ name: def.id, compId: exp.compId, document: exp.document, frames });
  }
  return out;
}

test('the C++ time/comp parity fixture matches what buildSnapshot + snapshotToFrameScene produce', () => {
  const cases = generate();
  const text = `${JSON.stringify({ comment: 'Generated by src/core/rendering/timeCompCrossEngine.test.ts (GEN_NATIVE_TIME_COMP=1). Do not edit.', cases })}\n`;
  if (process.env.GEN_NATIVE_TIME_COMP === '1') {
    writeFileSync(OUT, text);
  } else {
    expect(existsSync(OUT)).toBe(true);
    const stored = JSON.parse(readFileSync(OUT, 'utf8')) as { cases: Array<{ name: string; frames: unknown }> };
    expect(stored.cases.map((c) => ({ name: c.name, frames: c.frames })))
      .toEqual((cases as Array<{ name: string; frames: unknown }>).map((c) => ({ name: c.name, frames: c.frames })));
  }
  // Every case really exercises its feature (a vacuous fixture pins nothing).
  const all = JSON.stringify(cases);
  for (const needle of ['inst::iRect', 'inst::iDeep::dRect', 'inst2::iRect', 'coll::iRect', 'seal::iRect', 'vfa:clip', 'vfb:clip',
    'echoed__echo0', 'ring~c6::petal', 'dot~c19::root', 'bar~c3::root', 'wide__echo4', '"quad3d":[', '"cornerPin":[0.05', 'hA::aB::bRect', '"continuousRaster":true']) {
    expect(all).toContain(needle);
  }
  for (const c of cases as Array<{ frames: Array<{ errors: string[] }> }>) for (const f of c.frames) expect(f.errors).toEqual([]);
});
