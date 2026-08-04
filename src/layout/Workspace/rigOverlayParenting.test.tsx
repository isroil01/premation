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
 * Every expectation below is therefore deliberately WRONG-BUT-CURRENT at the
 * moment it lands, and each is labelled with what it will become.
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
 *   CURRENT  worldMatrix(readGeometry(C)) is the IDENTITY (C's own x/y are 0,
 *            its rotation 0, its scale 1), so the pin draws at (30, 0).
 *   CORRECT  comp.x = 0*30 + (-3)*0 + 100 = 100
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
   * CURRENT BEHAVIOUR, asserted so the fix has something to visibly change.
   * Predicted to become (100, 110) — see the derivation in the file header.
   */
  it('PARENTED: draws the pin at the UNPARENTED position (F23, current)', () => {
    const container = setup(true);
    act(() => undefined);
    expect(pinDot(container)).toEqual({ x: 30, y: 0 });
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
