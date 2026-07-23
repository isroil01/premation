/**
 * Gizmo3D — projection, hit-testing and viewport↔comp mapping math.
 *
 * Uses the default 1920×1080 camera: a point at the comp centre (960, 540, 0)
 * projects exactly onto (960, 540), and buildRenderedGizmo3D normalises axis
 * length so the axis tips land ~gizmoLengthPx away on screen.
 */

import {
  buildRenderedGizmo3D,
  hitTestGizmo3D,
  viewportToComp,
  compToViewport,
  buildGroundGridLines,
  type Gizmo3DConfig,
} from '../selection/gizmo3d';
import { buildDimensionalGuideData, type DimensionalGuideState } from '../selection/dimensionalGuides';
import { Project3D } from '@motion/scene';

const W = 1920;
const H = 1080;
const CENTER = { x: W / 2, y: H / 2, z: 0 };
const NO_ROT = { rotX: 0, rotY: 0, rotZ: 0 };
const cam = Project3D.defaultCamera(W, H);

function build(gizmoState: Gizmo3DConfig['gizmoState'], axisMode: Gizmo3DConfig['axisMode'] = 'world') {
  return buildRenderedGizmo3D(CENTER, NO_ROT, cam, null, { gizmoState, axisMode, gizmoLengthPx: 85 }, W, H);
}

describe('viewport ↔ comp mapping (RenderView: canvasPx = compPx·scale + offset)', () => {
  const view = { scale: 2, offsetX: 100, offsetY: 50 };

  it('maps comp → viewport with known values', () => {
    expect(compToViewport({ x: 10, y: 10 }, view)).toEqual({ x: 120, y: 70 });
    expect(compToViewport({ x: 0, y: 0 }, view)).toEqual({ x: 100, y: 50 });
  });

  it('maps viewport → comp (inverse)', () => {
    expect(viewportToComp({ x: 120, y: 70 }, view)).toEqual({ x: 10, y: 10 });
  });

  it('round-trips', () => {
    const pt = { x: 313.25, y: -47.5 };
    const rt = viewportToComp(compToViewport(pt, view), view);
    expect(rt.x).toBeCloseTo(pt.x, 10);
    expect(rt.y).toBeCloseTo(pt.y, 10);
  });

  it('survives a zero scale without producing NaN', () => {
    const p = viewportToComp({ x: 10, y: 10 }, { scale: 0, offsetX: 0, offsetY: 0 });
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('buildRenderedGizmo3D', () => {
  it('projects the gizmo centre of a comp-centred node onto the comp centre', () => {
    const g = build('universal');
    expect(g.centerScreen.x).toBeCloseTo(W / 2, 3);
    expect(g.centerScreen.y).toBeCloseTo(H / 2, 3);
  });

  it('normalises the X axis tip to ~gizmoLengthPx on screen', () => {
    const g = build('position');
    const posX = g.axes.find((a) => a.type === 'pos_x');
    expect(posX).toBeDefined();
    const len = Math.hypot(posX!.endScreen.x - posX!.startScreen.x, posX!.endScreen.y - posX!.startScreen.y);
    expect(len).toBeCloseTo(85, 0);
  });

  it('stays screen-constant across view zoom levels (gizmoLengthPx = 85 / scale)', () => {
    // The overlay wraps the gizmo in a group scaled by the viewport zoom, and
    // compensates by requesting 85 / scale comp px. The resulting SCREEN length
    // (comp length × view scale) must stay ~85px at any zoom.
    const screenLenAt = (viewScale: number): number => {
      const g = buildRenderedGizmo3D(
        CENTER,
        NO_ROT,
        cam,
        null,
        { gizmoState: 'position', axisMode: 'world', gizmoLengthPx: 85 / viewScale },
        W,
        H,
      );
      const posX = g.axes.find((a) => a.type === 'pos_x')!;
      const compLen = Math.hypot(posX.endScreen.x - posX.startScreen.x, posX.endScreen.y - posX.startScreen.y);
      return compLen * viewScale;
    };

    const atFit = screenLenAt(0.19);
    const at100 = screenLenAt(1.0);
    const at400 = screenLenAt(4.0);
    expect(atFit).toBeCloseTo(85, 0);
    expect(at100).toBeCloseTo(85, 0);
    expect(at400).toBeCloseTo(85, 0);
    expect(Math.abs(atFit - at100)).toBeLessThan(1);
    expect(Math.abs(at400 - at100)).toBeLessThan(1);
  });

  it('emits only the handles the state asks for', () => {
    const pos = build('position');
    expect(pos.axes.map((a) => a.type).sort()).toEqual(['pos_x', 'pos_y', 'pos_z']);
    expect(pos.arcs).toHaveLength(0);
    expect(pos.planes).toHaveLength(3);

    const rot = build('rotation');
    expect(rot.axes).toHaveLength(0);
    expect(rot.arcs.map((a) => a.type).sort()).toEqual(['rot_x', 'rot_y', 'rot_z']);

    const scl = build('scale');
    expect(scl.axes.map((a) => a.type).sort()).toEqual(['scale_x', 'scale_y', 'scale_z']);
  });
});

describe('hitTestGizmo3D', () => {
  it('hits a point midway along the +X axis as pos_x', () => {
    const g = build('position');
    expect(hitTestGizmo3D({ x: W / 2 + 40, y: H / 2 }, g, 10)).toBe('pos_x');
  });

  it('hits a point midway along the +Y axis as pos_y', () => {
    const g = build('position');
    expect(hitTestGizmo3D({ x: W / 2, y: H / 2 + 40 }, g, 10)).toBe('pos_y');
  });

  it('hits the scale axis tips in scale mode', () => {
    const g = build('scale');
    const tip = g.axes.find((a) => a.type === 'scale_x')!.endScreen;
    expect(hitTestGizmo3D({ x: tip.x, y: tip.y }, g, 10)).toBe('scale_x');
  });

  it('hits a rotation ring point as its arc handle', () => {
    const g = build('rotation');
    const rotZ = g.arcs.find((a) => a.type === 'rot_z')!;
    // Point on the ring at 45° — away from the near-degenerate projections of
    // the rot_x (≈vertical) and rot_y (≈horizontal) rings.
    const pt = rotZ.pointsScreen[4]!;
    expect(hitTestGizmo3D(pt, g, 6)).toBe('rot_z');
  });

  it('misses points far from every handle', () => {
    const g = build('universal');
    expect(hitTestGizmo3D({ x: 10, y: 10 }, g, 10)).toBeNull();
    expect(hitTestGizmo3D({ x: W - 10, y: H - 10 }, g, 10)).toBeNull();
  });

  it('scales its threshold: a near-miss passes with a larger tolerance', () => {
    const g = build('position');
    const probe = { x: W / 2 + 40, y: H / 2 + 14 };
    expect(hitTestGizmo3D(probe, g, 10)).toBeNull();
    expect(hitTestGizmo3D(probe, g, 20)).toBe('pos_x');
  });
});

describe('buildGroundGridLines (AE-style floor centred under the comp)', () => {
  it('emits (2·count+1) lines per direction', () => {
    const lines = buildGroundGridLines(W, H, 200, 5);
    expect(lines).toHaveLength(11 * 2);
  });

  it('lies on the y = compHeight plane (comp bottom = floor)', () => {
    for (const l of buildGroundGridLines(W, H)) {
      expect(l.start.y).toBe(H);
      expect(l.end.y).toBe(H);
    }
  });

  it('is centred on the comp: x symmetric about compWidth/2, z symmetric about 0', () => {
    const lines = buildGroundGridLines(W, H, 200, 5);
    const xs = lines.map((l) => l.start.x).concat(lines.map((l) => l.end.x));
    const zs = lines.map((l) => l.start.z).concat(lines.map((l) => l.end.z));
    expect(Math.min(...xs) + Math.max(...xs)).toBeCloseTo(W, 6); // symmetric about W/2
    expect(Math.min(...zs) + Math.max(...zs)).toBeCloseTo(0, 6); // symmetric about 0
  });

  it('marks exactly the two centre lines as major (x = W/2 and z = 0)', () => {
    const lines = buildGroundGridLines(W, H, 200, 5);
    const major = lines.filter((l) => l.major);
    expect(major).toHaveLength(2);
    const zParallel = major.find((l) => l.start.x === l.end.x)!;
    const xParallel = major.find((l) => l.start.z === l.end.z)!;
    expect(zParallel.start.x).toBeCloseTo(W / 2, 6);
    expect(xParallel.start.z).toBeCloseTo(0, 6);
  });

  it('the old bug shape does NOT come back: no line touches the world origin corner cluster', () => {
    // Origin-centred grid had its centre line at x = 0 (comp's top-left edge).
    const lines = buildGroundGridLines(W, H, 200, 5);
    const majorVertical = lines.filter((l) => l.major && l.start.x === l.end.x);
    expect(majorVertical.every((l) => l.start.x !== 0)).toBe(true);
  });
});

describe('buildDimensionalGuideData (drag feedback, keyed by `handle`)', () => {
  const identity = (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y });

  const base: DimensionalGuideState = {
    handle: 'pos_x',
    startPos3D: { x: 0, y: 0, z: 0 },
    currentPos3D: { x: 25, y: 0, z: 0 },
    startRot3D: { rotX: 0, rotY: 0, rotZ: 0 },
    currentRot3D: { rotX: 0, rotY: 0, rotZ: 0 },
    startScale3D: { scaleX: 1, scaleY: 1, scaleZ: 1 },
    currentScale3D: { scaleX: 1, scaleY: 1, scaleZ: 1 },
    mouseScreen: { x: 100, y: 100 },
  };

  it('reports a ΔX badge and trajectory line for pos_x', () => {
    const d = buildDimensionalGuideData(base, identity);
    expect(d.badgeText).toContain('ΔX');
    expect(d.badgeText).toContain('+25.0');
    expect(d.originLineScreen).toEqual({ start: { x: 0, y: 0 }, end: { x: 25, y: 0 } });
    expect(d.axisDropLinesScreen).toHaveLength(1);
  });

  it('reports the rotation delta for rot_z', () => {
    const d = buildDimensionalGuideData(
      { ...base, handle: 'rot_z', currentRot3D: { rotX: 0, rotY: 0, rotZ: 30 } },
      identity,
    );
    expect(d.rotationArcAngleDeg).toBe(30);
    expect(d.badgeText).toContain('Rotation Z');
  });

  it('reports uniform scale for scale_center', () => {
    const d = buildDimensionalGuideData(
      { ...base, handle: 'scale_center', currentScale3D: { scaleX: 1.5, scaleY: 1.5, scaleZ: 1 } },
      identity,
    );
    expect(d.badgeText).toBe('Uniform Scale: 1.50×');
  });

  it('positions the badge beside the cursor', () => {
    const d = buildDimensionalGuideData(base, identity);
    expect(d.badgeScreen).toEqual({ x: 116, y: 76 });
  });
});
