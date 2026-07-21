import { projectOrtho, projectPoint, defaultCamera, type OrthoView } from './project3d';

const W = 1920;
const H = 1080;
const CX = W / 2;
const CY = H / 2;

describe('projectOrtho', () => {
  it('front view is the identity for the composition plane', () => {
    // A point anywhere on z=0 maps to itself, so switching to the Front
    // orthographic view leaves a flat comp exactly where the 2D view had it.
    for (const [x, y] of [[0, 0], [100, 250], [CX, CY], [W, H]]) {
      const p = projectOrtho({ x, y, z: 0 }, 'front', W, H);
      expect(p.x).toBeCloseTo(x);
      expect(p.y).toBeCloseTo(y);
    }
  });

  it('never foreshortens — scale is always 1', () => {
    const views: OrthoView[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];
    for (const v of views) {
      for (const z of [-500, 0, 500]) {
        expect(projectOrtho({ x: 300, y: 300, z }, v, W, H).scale).toBe(1);
      }
    }
  });

  it('collapses the flat comp to the horizontal centre line in a top view', () => {
    // From the top a flat (z=0) comp is edge-on: every point lands on one
    // horizontal line at the comp's vertical centre. This is the defining
    // behaviour of an orthographic top view.
    for (const [x, y] of [[0, 0], [W, H], [500, 900]]) {
      expect(projectOrtho({ x, y, z: 0 }, 'top', W, H).y).toBeCloseTo(CY);
    }
  });

  it('collapses the flat comp to the vertical centre line in a side view', () => {
    for (const view of ['left', 'right'] as OrthoView[]) {
      for (const [x, y] of [[0, 0], [W, H], [500, 900]]) {
        expect(projectOrtho({ x, y, z: 0 }, view, W, H).x).toBeCloseTo(CX);
      }
    }
  });

  it('spreads depth: a +z layer moves off the centre line in a top view', () => {
    // Only a layer with real z-extent has anywhere to go in a side/top view —
    // that is what makes these views useful for arranging depth.
    const flat = projectOrtho({ x: CX, y: CY, z: 0 }, 'top', W, H);
    const pushed = projectOrtho({ x: CX, y: CY, z: 400 }, 'top', W, H);
    expect(flat.y).toBeCloseTo(CY);
    expect(pushed.y).not.toBeCloseTo(CY);
    // Horizontal stays put — only depth (z) moved.
    expect(pushed.x).toBeCloseTo(flat.x);
  });

  it('mirrors X in the back view', () => {
    // Looking from behind, left and right swap. A point right-of-centre in
    // front reads left-of-centre in back.
    const front = projectOrtho({ x: CX + 300, y: CY, z: 0 }, 'front', W, H);
    const back = projectOrtho({ x: CX + 300, y: CY, z: 0 }, 'back', W, H);
    expect(front.x - CX).toBeCloseTo(-(back.x - CX));
  });

  it('reports a depth for painter sorting', () => {
    // Front depth is the world z (farther = larger), matching the perspective
    // path's convention so back-to-front sorting is unchanged.
    expect(projectOrtho({ x: CX, y: CY, z: 500 }, 'front', W, H).depth).toBeCloseTo(500);
    expect(projectOrtho({ x: CX, y: CY, z: -500 }, 'front', W, H).depth).toBeCloseTo(-500);
  });

  it('matches the perspective front view for a flat comp (near-identical)', () => {
    // The default perspective camera renders z=0 at scale ~1 too, so switching
    // Front perspective -> Front ortho barely moves a flat comp. This is why
    // making Front orthographic is safe.
    const cam = defaultCamera(W, H);
    for (const [x, y] of [[100, 100], [CX, CY], [1500, 800]]) {
      const persp = projectPoint({ x, y, z: 0 }, cam);
      const ortho = projectOrtho({ x, y, z: 0 }, 'front', W, H);
      expect(ortho.x).toBeCloseTo(persp.x, 3);
      expect(ortho.y).toBeCloseTo(persp.y, 3);
    }
  });
});
