/**
 * 3D render groups (CompositionPass): contiguous depth-eligible 3D renderables
 * render as ONE depth-tested pass ('composition-3d') into the scene colour
 * target; 2D layers and offscreen-routed layers (effects/mattes) break the
 * group and keep the painter's-order path. Verified against the NullBackend's
 * pass/draw log.
 */

import { Renderer } from '../core/renderer/Renderer';
import { NullBackend } from '../gpu/backends/NullBackend';
import { Mat3 } from '../core/math/Mat3';
import { Color } from '../core/math/Color';
import type { FrameScene, Renderable } from '../scene/FrameScene';

const F = 800;

function camera3d() {
  const n = 1;
  const fr = 100000;
  return {
    view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -400, -300, F, 1] as readonly number[],
    projection: [F, 0, 0, 0, 0, F, 0, 0, 400, 300, fr / (fr - n), 1, 0, 0, (-fr * n) / (fr - n), 0] as readonly number[],
  };
}

function rect(id: string, x: number, y: number, threeD = false, extra: Partial<Renderable> = {}): Renderable {
  const w = 100;
  const h = 100;
  const model = Mat3.multiply(Mat3.compose(x, y, 0, w, h), Mat3.translation(-0.5, -0.5));
  return {
    id,
    kind: 'rect',
    modelMatrix: model,
    bounds: { x: x - w / 2, y: y - h / 2, width: w, height: h },
    opacity: 1,
    blend: 'normal',
    color: Color.white(),
    ...(threeD
      ? { threeD: { model: [w, 0, 0, 0, 0, h, 0, 0, 0, 0, 1, 0, x - w / 2, y - h / 2, 0, 1] } }
      : {}),
    ...extra,
  };
}

function scene(renderables: Renderable[], withCamera = true): FrameScene {
  return {
    composition: { id: 'comp', size: { width: 800, height: 600 }, background: Color.of(0, 0, 0, 1) },
    renderables,
    hasEffects: true, // route through the (depth-capable) scene colour target
    ...(withCamera ? { camera3d: camera3d() } : {}),
  };
}

async function render(s: FrameScene): Promise<NullBackend> {
  const backend = new NullBackend();
  const renderer = new Renderer({ backend, now: () => 16 });
  await renderer.initialize();
  const vp = renderer.createViewport({ width: 800, height: 600, overlays: { grid: false, checkerboard: false } });
  vp.camera.setState({ center: { x: 400, y: 300 }, zoom: 1 });
  renderer.render(vp, s);
  return backend;
}

describe('CompositionPass 3D render groups', () => {
  it('a contiguous 3D run renders as one depth pass', async () => {
    const backend = await render(scene([rect('a', 100, 100, true), rect('b', 130, 120, true), rect('c', 160, 140, true)]));
    expect(backend.depthPassLog).toEqual(['composition-3d']);
    // All three quads drawn inside the depth pass.
    expect(backend.draws.filter((d) => d.pass === 'composition-3d')).toHaveLength(3);
  });

  it('a 2D layer breaks the run into two depth groups (AE group semantics)', async () => {
    const backend = await render(
      scene([rect('a', 100, 100, true), rect('flat', 200, 200, false), rect('b', 300, 300, true)]),
    );
    expect(backend.depthPassLog).toEqual(['composition-3d', 'composition-3d']);
    // The 2D layer draws through the ordinary composition pass between them.
    const order = backend.passLog.filter((p) => p === 'composition' || p === 'composition-3d');
    expect(order).toEqual(['composition-3d', 'composition', 'composition-3d']);
  });

  it('without a scene camera the 3D flag is ignored (affine fallback, no depth pass)', async () => {
    const backend = await render(scene([rect('a', 100, 100, true), rect('b', 130, 120, true)], false));
    expect(backend.depthPassLog).toEqual([]);
    expect(backend.stats().draws).toBeGreaterThanOrEqual(2);
  });

  it('an effect-laden 3D layer JOINS the depth group (pre-resolved, then drawn as a 3D quad)', async () => {
    const backend = await render(
      scene([
        rect('a', 100, 100, true),
        rect('fx', 200, 200, true, { effects: [{ type: 'blur', radiusPx: 4 }] }),
        rect('b', 300, 300, true),
      ]),
    );
    // The whole contiguous run is ONE depth group now — the effect layer no
    // longer breaks it. Its effect chain is pre-resolved (blur sub-passes) into
    // an offscreen texture, which is then drawn as a textured3d quad alongside
    // its plain 3D siblings in a single depth pass (3 draws).
    expect(backend.depthPassLog).toEqual(['composition-3d']);
    expect(backend.draws.filter((d) => d.pass === 'composition-3d')).toHaveLength(3);
    // The effect chain ran (blur H+V) as offscreen sub-passes BEFORE the depth
    // pass, and NO ordinary 2D 'composition' pass appears (the effect layer did
    // not drop to the affine painter path).
    expect(backend.passLog).toEqual(expect.arrayContaining(['threed-fx-src', 'blurH', 'blurV']));
    expect(backend.passLog).not.toContain('composition');
    // blurH must precede the depth pass (resolve happens outside/before it).
    expect(backend.passLog.indexOf('blurH')).toBeLessThan(backend.passLog.indexOf('composition-3d'));
  });

  it('a mixed run [3D-plain, 3D-blur, 2D] keeps the 3D pair in one depth group, 2D on the painter path', async () => {
    const backend = await render(
      scene([
        rect('a', 100, 100, true),
        rect('fx', 130, 120, true, { effects: [{ type: 'blur', radiusPx: 4 }] }),
        rect('flat', 300, 300, false),
      ]),
    );
    // The plain + effect 3D layers form ONE depth group (2 draws); the 2D layer
    // draws through the ordinary composition pass after it.
    expect(backend.depthPassLog).toEqual(['composition-3d']);
    expect(backend.draws.filter((d) => d.pass === 'composition-3d')).toHaveLength(2);
    const order = backend.passLog.filter((p) => p === 'composition' || p === 'composition-3d');
    expect(order).toEqual(['composition-3d', 'composition']);
    expect(backend.passLog).toEqual(expect.arrayContaining(['blurH', 'blurV']));
  });

  it('two effect-laden 3D layers split into two depth sub-passes (shared depth, no 2D break)', async () => {
    const backend = await render(
      scene([
        rect('fxa', 100, 100, true, { effects: [{ type: 'blur', radiusPx: 4 }] }),
        rect('fxb', 140, 130, true, { effects: [{ type: 'blur', radiusPx: 4 }] }),
      ]),
    );
    // Each resolved texture lives in the same scratch target, so the first
    // draw must flush before the second resolve overwrites it — two depth
    // sub-passes, one draw each, both still 3D (no ordinary 2D pass between).
    expect(backend.depthPassLog).toEqual(['composition-3d', 'composition-3d']);
    expect(backend.draws.filter((d) => d.pass === 'composition-3d')).toHaveLength(2);
    expect(backend.passLog).not.toContain('composition');
  });

  it('a motion-blurred 3D layer STAYS excluded (breaks the run, offscreen route)', async () => {
    const m = Mat3.multiply(Mat3.compose(200, 200, 0, 100, 100), Mat3.translation(-0.5, -0.5));
    const backend = await render(
      scene([
        rect('a', 100, 100, true),
        rect('mb', 200, 200, true, {
          motionSamples: [
            { modelMatrix: m, opacity: 1 },
            { modelMatrix: m, opacity: 1 },
          ],
        }),
        rect('b', 300, 300, true),
      ]),
    );
    // Motion blur needs an accumulation target (no single-texture resolve), so
    // it remains on the affine/offscreen fallback and breaks the run into two
    // depth groups; the layer itself is NOT drawn inside any depth pass.
    expect(backend.depthPassLog).toEqual(['composition-3d', 'composition-3d']);
    expect(backend.passLog).toContain('layer');
  });

  it('invisible/offscreen 3D layers are culled from the group', async () => {
    const backend = await render(scene([rect('a', 100, 100, true), rect('far', 99999, 99999, true)]));
    expect(backend.draws.filter((d) => d.pass === 'composition-3d')).toHaveLength(1);
  });
});
