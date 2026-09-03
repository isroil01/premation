/**
 * The three 3D surfaces that shipped as engine features with no control.
 *
 * Each of these was reachable from code and unreachable from the app:
 *   • `setNodeBevelStyle` had zero callers outside its own module, so the
 *     concave / convex profiles could not be selected at all;
 *   • morph weights were animatable props with no row — a 52-shape face rig
 *     was editable only by typing prop names into an expression;
 *   • 3D IK existed as two palette commands whose selection protocol
 *     ("tip first, then Ctrl-click the target") is not discoverable.
 *
 * So what is pinned here is REACHABILITY: the control exists, and driving it
 * moves the value the engine reads. Solver maths lives in boneIK3d.test.ts and
 * blend maths in modelMorph.test.ts; this suite is about the wiring between
 * them and a pointer.
 */

import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNode3D } from '@core/scene/threeD';
import { MODEL_COMPONENT } from '@core/scene/modelMesh';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { ThreeDControl } from './ThreeDControl';
import { ModelSection } from './ModelSection';
import { Ik3DSection, isIk3DTip } from './Ik3DSection';
import type { SceneNode } from '@core/types';

const layer = (
  id: string,
  props: Record<string, unknown>,
  extra: SceneNode['components'] = [],
): SceneNode => ({
  id, name: id, parent: null, children: [], visible: true, locked: false,
  transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
  components: [
    {
      id: `${id}_t`, type: 'Transform',
      props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 100, height: 100, ...props },
    },
    { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
    ...extra,
  ],
} as unknown as SceneNode);

// Keyframe writes go through the CommandSystem (runAnimEdit), so the harness
// needs the same one boot installs or the stopwatch throws.
beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
});

afterEach(() => {
  cleanup();
  defaultAnimation.clear();
  defaultSceneGraph.clear();
});

/** ValueField labels its wrapper AND its inner span; the wrapper is the control. */
const field = (name: string): HTMLElement => screen.getByRole('spinbutton', { name });

describe('Bevel style', () => {
  const mount = (bevelDepth: number): void => {
    defaultSceneGraph.clear();
    defaultSceneGraph.addNode(layer('box', {
      z: 0, rotationX: 0, rotationY: 0, extrusionDepth: 60, bevelDepth,
    }));
    render(<ThreeDControl nodeId="box" />);
  };

  it('offers every profile in the union and writes the picked one', () => {
    mount(8);
    const select = screen.getByLabelText('Bevel style') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['angular', 'concave', 'convex']);
    expect(select.value).toBe('angular');

    fireEvent.change(select, { target: { value: 'convex' } });
    expect(readNode3D(defaultSceneGraph.getNode('box')!).bevelStyle).toBe('convex');
  });

  it('back to the default clears the stored prop rather than writing "angular"', () => {
    mount(8);
    const select = screen.getByLabelText('Bevel style') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'concave' } });
    fireEvent.change(screen.getByLabelText('Bevel style'), { target: { value: 'angular' } });
    const t = defaultSceneGraph.getNode('box')!.components.find((c) => c.type === 'Transform')!;
    expect(t.props.bevelStyle).toBeUndefined();
    expect(readNode3D(defaultSceneGraph.getNode('box')!).bevelStyle).toBe('angular');
  });

  it('stays hidden while there is no chamfer to shape', () => {
    mount(0);
    expect(screen.queryByLabelText('Bevel style')).toBeNull();
  });
});

describe('Morph Targets section', () => {
  const modelComp = (props: Record<string, unknown>): SceneNode['components'] =>
    [{ id: 'm_model', type: MODEL_COMPONENT, props }] as unknown as SceneNode['components'];

  it('renders one named row per target and writes the static weight', () => {
    defaultSceneGraph.addNode(layer(
      'mesh',
      { morph0: 0, morph1: 0.5 },
      modelComp({ modelKey: 'k', mesh: 0, prim: 0, morphNames: ['jawOpen', ''] }),
    ));
    render(<ModelSection nodeId="mesh" />);

    expect(screen.getByText('2 targets')).toBeInTheDocument();
    const slider = screen.getByLabelText('jawOpen slider') as HTMLInputElement;
    expect(screen.getByLabelText('Target 2 slider')).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: '0.75' } });
    const t = defaultSceneGraph.getNode('mesh')!.components.find((c) => c.type === 'Transform')!;
    expect(t.props.morph0).toBeCloseTo(0.75);
  });

  it('the stopwatch creates a real track, and edits then land as keyframes', () => {
    defaultSceneGraph.addNode(layer('mesh', { morph0: 0.2 }, modelComp({ modelKey: 'k', mesh: 0, prim: 0 })));
    const view = render(<ModelSection nodeId="mesh" />);

    fireEvent.click(screen.getByTitle('Animate Target 1 — adds a keyframe at the playhead'));
    expect(defaultAnimation.isAnimated('mesh', 'morph0')).toBe(true);

    // In the app the row repaints itself off `AnimationChanged`; this harness
    // has no bus bridge to the engine, so the re-render is explicit.
    view.rerender(<ModelSection nodeId="mesh" />);
    expect(screen.getByTitle('Stop animating Target 1')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Target 1 slider'), { target: { value: '0.9' } });
    expect(defaultAnimation.sample('mesh', 'morph0', 0)).toBeCloseTo(0.9);
    // The static prop is untouched — the track is what the renderer samples.
    const t = defaultSceneGraph.getNode('mesh')!.components.find((c) => c.type === 'Transform')!;
    expect(t.props.morph0).toBeCloseTo(0.2);
  });

  it('Reset all zeroes every weight', () => {
    defaultSceneGraph.addNode(layer('mesh', { morph0: 0.4, morph1: 0.6 }, modelComp({ modelKey: 'k', mesh: 0, prim: 0 })));
    render(<ModelSection nodeId="mesh" />);
    fireEvent.click(screen.getByText('Reset all'));
    const t = defaultSceneGraph.getNode('mesh')!.components.find((c) => c.type === 'Transform')!;
    expect([t.props.morph0, t.props.morph1]).toEqual([0, 0]);
  });

  it('is absent for a layer with no morph props', () => {
    defaultSceneGraph.addNode(layer('plain', {}));
    const { container } = render(<ModelSection nodeId="plain" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('3D IK section', () => {
  /** root → mid → tip, every one of them 3D, plus a separate target layer. */
  const buildChain = (): void => {
    defaultSceneGraph.addNode(layer('root', { z: 0, rotationX: 0, rotationY: 0 }));
    defaultSceneGraph.addChild('root', layer('mid', { z: 0, rotationX: 0, rotationY: 0, x: 50 }));
    defaultSceneGraph.addChild('mid', layer('tip', { z: 0, rotationX: 0, rotationY: 0, x: 50 }));
    defaultSceneGraph.addNode(layer('goal', { z: 0, rotationX: 0, rotationY: 0, x: 200, y: 40 }));
  };

  it('appears for a chain tip and reports the ancestor count', () => {
    buildChain();
    expect(isIk3DTip('tip')).toBe(true);
    render(<Ik3DSection nodeId="tip" />);
    expect(screen.getByText('2 3D parents (3 joints)')).toBeInTheDocument();
  });

  it('stays away from a 3D layer with no 3D parent, and from a 2D layer', () => {
    defaultSceneGraph.addNode(layer('lonely', { z: 0, rotationX: 0, rotationY: 0 }));
    defaultSceneGraph.addNode(layer('flat', {}));
    expect(isIk3DTip('lonely')).toBe(false);
    expect(isIk3DTip('flat')).toBe(false);
    expect(render(<Ik3DSection nodeId="lonely" />).container).toBeEmptyDOMElement();
    expect(render(<Ik3DSection nodeId="flat" />).container).toBeEmptyDOMElement();
  });

  it('exposes the solver options and both actions', () => {
    buildChain();
    render(<Ik3DSection nodeId="tip" />);
    expect(field('IK iterations')).toHaveAttribute('aria-valuenow', '12');
    expect(field('IK damping')).toHaveAttribute('aria-valuenow', '34');
    expect(field('IK tolerance')).toHaveAttribute('aria-valuenow', '0.5');
    // Both buttons are inert until a target is named — the palette form's
    // failure mode was firing with an unusable selection and warning after.
    expect(screen.getByText('Pose at target').closest('button')).toBeDisabled();
    expect(screen.getByText('Bake to target').closest('button')).toBeDisabled();
  });
});
