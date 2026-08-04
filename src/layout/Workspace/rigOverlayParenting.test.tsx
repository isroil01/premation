/**
 * Where the rig overlays draw their handles on a PARENTED layer.
 *
 * ## Why this file exists before the fix, not after
 *
 * `PuppetOverlay` and `BoneOverlay` position handles through
 * `worldMatrix(readGeometry(node))`, which composes that node's OWN
 * translate/rotate/scale and nothing else — no parent chain. So on a parented
 * layer the pins draw at the unparented position while the artwork renders at
 * the parented one (F23).
 *
 * The render-test suite CANNOT capture this. Its harness is
 * `createRenderBackend -> buildSnapshot -> renderFrame`, and the overlays are
 * React chrome that never enters the rendered frame — a parented-rig golden
 * would stay byte-identical through the fix and prove nothing, which is F15's
 * dead golden in a new costume. This file is the medium that can, so the
 * repeater's ordering applies here instead: assert CURRENT behaviour first,
 * predict the diff, then let the fix visibly change these numbers.
 *
 * The parented expectation landed deliberately WRONG-BUT-CURRENT at (30, 0) and
 * was re-blessed to (100, 110) by the fix, matching the prediction below.
 *
 * ## The rig, hand-derived
 *
 * The mocked camera is 1:1 and centred on the origin, so screen == comp.
 *
 *   parent P at (100, 50), rotation 90, scale (2, 3)
 *   child  C parented to P, local (0, 0), 200x160
 *   P = translate(100,50).rotate(90).scale(2,3) = {a:0, b:2, c:-3, d:0, e:100, f:50}
 *   C_local = identity, so the child's true world matrix IS P.
 *
 * A pin at layer-local (30, 0):
 *   BEFORE   worldMatrix(readGeometry(C)) is the IDENTITY (C's own x/y are 0,
 *            its rotation 0, its scale 1), so the pin drew at (30, 0).
 *   AFTER    comp.x = 0*30 + (-3)*0 + 100 = 100
 *            comp.y = 2*30 +   0 *0 +  50 = 110   -> (100, 110)
 *
 * The unparented case must not move at all, and is asserted alongside so the
 * fix is scoped to what it claims.
 */

import { render, act } from '@testing-library/react';
import { PuppetOverlay } from './PuppetOverlay';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { defaultAnimation } from '@motion/animation';
import { clearRestMeshCache } from '@core/rig/puppet';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    onRender: () => () => undefined,
    requestRender: () => undefined,
    ws: {
      camera: {
        zoom: 1,
        worldToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
        screenToWorld: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      },
    },
  }),
}));

interface Opts { x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number; parent?: string | null }
function node(id: string, o: Opts = {}): SceneNode {
  const { x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1, parent = null } = o;
  return {
    id, name: id, parent, children: [], visible: true, locked: false,
    transform: { position: { x, y }, rotation, scale: { x: scaleX, y: scaleY } },
    components: [
      {
        id: `${id}_t`, type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x, y, rotation, scaleX, scaleY, width: 200, height: 160 },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

/**
 * The pin dot's centre, read off the rendered SVG.
 *
 * Matches BOTH styles the overlay uses — `#00bfff` when the pin is unselected
 * and the white-on-amber pair when it is. Matching only the selected style
 * silently found nothing and read as "the overlay drew no pin", which is the
 * wrong diagnosis for a positioning test.
 */
function pinDot(container: HTMLElement): { x: number; y: number } | null {
  const c = [...container.querySelectorAll('circle')].find((el) => {
    const fill = el.getAttribute('fill');
    return fill === '#00bfff' || (fill === '#ffffff' && el.getAttribute('stroke') === '#ffc107');
  });
  if (!c) return null;
  return { x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) };
}

function setup(parented: boolean): HTMLElement {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  clearRestMeshCache();
  defaultAnimation.clear?.();
  for (const id of ['P', 'C']) { try { defaultSceneGraph.removeNode(id); } catch { /* fresh */ } }
  if (parented) {
    defaultSceneGraph.addNode(node('P', { x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 3 }));
    defaultSceneGraph.addChild('P', node('C', { parent: 'P' }));
  } else {
    defaultSceneGraph.addNode(node('C'));
  }
  defaultSceneGraph.setPuppet('C', {
    meshDensity: 6, meshExpansion: 0,
    pins: [{ id: 'pin1', x: 30, y: 0, rotation: 0, scale: 1 }],
  });
  useSelectionStore.getState().set(['C']);
  useUIStore.getState().setActiveTool('puppet-pin');
  const { container } = render(<PuppetOverlay />);
  return container;
}

describe('PuppetOverlay handle position under layer parenting', () => {
  /**
   * RE-BLESSED by the F23 fix. This asserted (30, 0) — the unparented position —
   * in the commit before it, and the number predicted for the fix was (100, 110)
   * from the derivation in the file header. That is what it became, so the diff
   * is the evidence rather than a golden that moved for unexamined reasons.
   */
  it('PARENTED: the pin follows the parent chain', () => {
    const container = setup(true);
    act(() => undefined);
    expect(pinDot(container)).toEqual({ x: 100, y: 110 });
  });

  /**
   * The scoping assertion. An unparented layer must be byte-identical before
   * and after, or the fix has changed more than it claims.
   */
  it('UNPARENTED: the pin draws at its layer-local position, and must not move', () => {
    const container = setup(false);
    act(() => undefined);
    expect(pinDot(container)).toEqual({ x: 30, y: 0 });
  });
});

/**
 * The boundary fixtures the main rig's clean values exclude (rule 3a).
 *
 * The rig is rotation 90 / scale (2,3) / parented, chosen so the composed
 * matrix is exact integers. Each of those choices hides something:
 *   rotation 90   -> zero DIAGONAL, so a/d errors contribute nothing
 *   scale (2,3)   -> a one-axis read still differs
 *   parented      -> the unparented path is never taken
 *   static props  -> an animated transform is never sampled
 */
describe('boundary fixtures', () => {
  const pinAt = (build: () => void): { x: number; y: number } | null => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    clearRestMeshCache();
    defaultAnimation.clear?.();
    for (const id of ['P', 'C']) { try { defaultSceneGraph.removeNode(id); } catch { /* fresh */ } }
    build();
    defaultSceneGraph.setPuppet('C', {
      meshDensity: 6, meshExpansion: 0,
      pins: [{ id: 'pin1', x: 30, y: 0, rotation: 0, scale: 1 }],
    });
    useSelectionStore.getState().set(['C']);
    useUIStore.getState().setActiveTool('puppet-pin');
    const { container } = render(<PuppetOverlay />);
    act(() => undefined);
    const d = pinDot(container);
    // Rounded to 6dp: sin(180 degrees) is 1.2e-16 rather than 0, so a rotated
    // rig lands at y = 7.3e-15 and an exact comparison fails on arithmetic
    // rather than on geometry. The x term is exact either way.
    return d ? { x: Math.round(d.x * 1e6) / 1e6, y: Math.round(d.y * 1e6) / 1e6 } : null;
  };

  /** IDENTITY: nothing composed at all, so the pin is its own local position. */
  it('BOUNDARY identity: an untransformed unparented layer is a passthrough', () => {
    expect(pinAt(() => defaultSceneGraph.addNode(node('C')))).toEqual({ x: 30, y: 0 });
  });

  /**
   * 180 degrees, the complementary matrix pattern to 90's zero diagonal.
   *   W = translate(0,0).rotate(180).scale(2,3) = {a:-2, b:0, c:0, d:-3}
   *   pin (30,0) -> (-2*30, 0) = (-60, 0)
   */
  it('BOUNDARY 180 degrees: the diagonal terms the 90-degree rig cannot see', () => {
    expect(pinAt(() => defaultSceneGraph.addNode(node('C', { rotation: 180, scaleX: 2, scaleY: 3 }))))
      .toEqual({ x: -60, y: 0 });
  });

  /**
   * Uniform scale isolates the rotation from the (2,3) rigs.
   *   W = rotate(90); pin (30,0) -> (0*30, 1*30) = (0, 30)
   */
  it('BOUNDARY uniform scale: rotation alone', () => {
    expect(pinAt(() => defaultSceneGraph.addNode(node('C', { rotation: 90 }))))
      .toEqual({ x: 0, y: 30 });
  });

  /**
   * A PARENTED layer whose parent is the identity must equal the unparented
   * answer — the fix must not invent a transform where there is none.
   */
  it('BOUNDARY identity parent: composing nothing changes nothing', () => {
    expect(pinAt(() => {
      defaultSceneGraph.addNode(node('P'));
      defaultSceneGraph.addChild('P', node('C', { parent: 'P' }));
    })).toEqual({ x: 30, y: 0 });
  });

  /**
   * THE SECOND BEHAVIOUR CHANGE, asserted rather than absorbed.
   *
   * `layerSpaceAt` samples the layer's ANIMATED transform, where
   * `worldMatrix(readGeometry(node))` read the static props only. So an overlay
   * on a layer whose own x is keyframed now tracks the artwork instead of
   * sitting at the rest pose. Same defect class as the parenting bug, but it
   * arrives with the consolidation rather than being chosen — so it gets a
   * guard and a line in the report.
   *
   * x keyframed 0 -> 400 over 2s; the overlay renders at time 0, so the pin
   * stays at (30, 0) here and the assertion is that the SAMPLING path is live
   * rather than that it has moved.
   */
  it('follows the ANIMATED layer transform, not the static rest pose', () => {
    const at0 = pinAt(() => {
      defaultSceneGraph.addNode(node('C'));
      defaultAnimation.setKeyframe('C', 'x', 0, 0);
      defaultAnimation.setKeyframe('C', 'x', 2, 400);
    });
    // At t=0 the animated x is 0, so the pin sits where an unanimated layer
    // would put it — which is what makes the NEXT assertion meaningful.
    expect(at0).toEqual({ x: 30, y: 0 });
    // A layer whose animated value at t=0 differs from its static prop is the
    // case that separates the two readers: static x = 0, animated x = 250.
    const shifted = pinAt(() => {
      defaultSceneGraph.addNode(node('C'));
      defaultAnimation.setKeyframe('C', 'x', 0, 250);
    });
    expect(shifted).toEqual({ x: 280, y: 0 });
  });
});

/**
 * 3D parenting, because `parentWorld3d` is in play once either layer takes the
 * 3D switch — a path the 2×3 `worldMatrix` could not express at all.
 *
 * Kept at z = 0 on purpose. A z = 0 layer projects to its own composition
 * position under the default camera (asserted in `layerSpace.test.ts`), so the
 * expected screen position stays hand-derivable instead of requiring the
 * perspective divide to be re-derived inside the assertion — which is rule 3's
 * "do not re-derive the implementation inside its own test".
 *
 *   3D parent P at (200, 0, 0); 3D child C parented, local (0, 0, 0)
 *   pin at layer (30, 0) -> world (230, 0, 0) -> comp (230, 0) at z = 0
 */
describe('3D parenting', () => {
  it('carries a 3D parent through parentWorld3d', () => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    clearRestMeshCache();
    defaultAnimation.clear?.();
    for (const id of ['P', 'C']) { try { defaultSceneGraph.removeNode(id); } catch { /* fresh */ } }
    const p3 = node('P', { x: 200, y: 0 }) as unknown as { components: Array<{ type: string; props: Record<string, unknown> }> };
    p3.components[0]!.props.is3D = true;
    p3.components[0]!.props.z = 0;
    defaultSceneGraph.addNode(p3 as never);
    const c3 = node('C', { parent: 'P' }) as unknown as { components: Array<{ type: string; props: Record<string, unknown> }> };
    c3.components[0]!.props.is3D = true;
    c3.components[0]!.props.z = 0;
    defaultSceneGraph.addChild('P', c3 as never);
    defaultSceneGraph.setPuppet('C', {
      meshDensity: 6, meshExpansion: 0,
      pins: [{ id: 'pin1', x: 30, y: 0, rotation: 0, scale: 1 }],
    });
    useSelectionStore.getState().set(['C']);
    useUIStore.getState().setActiveTool('puppet-pin');
    const { container } = render(<PuppetOverlay />);
    act(() => undefined);
    const d = pinDot(container)!;
    expect(Math.round(d.x)).toBe(230);
    expect(Math.round(d.y)).toBe(0);
  });
});
