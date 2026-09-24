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
 *
 * The fixture is the app's engine (B3): layers are created through the engine
 * API (a model mesh is inserted the way every insert lands — one
 * `pasteLayers` of an off-document build), every control's write is an engine
 * command, and the sections read the document mirror.
 */

import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import type { Command, PropertyInit } from '@motion/engine-api';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { readNode3D } from '@core/scene/threeD';
import { MODEL_COMPONENT } from '@core/scene/modelMesh';
import { defaultAnimation } from '@motion/animation';
import { getCommandSystem } from '@core/commands/CommandSystem';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { insertBuiltLayers } from '@core/engine/offDocument';
import { values } from '@core/engine/propRefs';
import { ThreeDControl } from './ThreeDControl';
import { ModelSection } from './ModelSection';
import { Ik3DSection, isIk3DTip } from './Ik3DSection';
import type { SceneNode } from '@core/types';

jest.useFakeTimers();

let h: Harness & { engine: LocalEngine };

beforeEach(async () => {
  h = await setupAppEngine();
});

afterEach(async () => {
  cleanup();
  await h.dispose();
});

const idle = async (): Promise<void> => { await act(async () => { await engineIdle(); }); };
const undo = async (): Promise<void> => { await act(async () => { await h.run({ type: 'undo' }); }); };
/** No second entry from the 700 ms recorder on top of the engine's. */
const settle = (): void => { act(() => { jest.advanceTimersByTime(2000); }); };

/** ValueField labels its wrapper AND its inner span; the wrapper is the control. */
const field = (name: string): HTMLElement => screen.getByRole('spinbutton', { name });

type Kind = 'shape' | 'text';
interface LayerOpts {
  parent?: string;
  init?: PropertyInit[];
  /** Turn the 3D switch on. */
  threeD?: boolean;
  /** Numeric properties written after the switch (geometry/…), path → value. */
  set?: Record<string, number>;
}

/** Create a layer through the engine and start from an empty history. */
async function layer(kind: Kind, name: string, opts: LayerOpts = {}): Promise<string> {
  let id = '';
  await act(async () => {
    ({ layer: id } = await h.run({
      type: 'createLayer', comp: 'comp_root', kind, name, init: opts.init ?? [],
      ...(opts.parent ? { parent: opts.parent } : {}),
    }));
    const cmds: Command[] = [];
    if (opts.threeD) cmds.push({ type: 'setLayerSwitches', layers: [id], patch: { threeD: true } });
    for (const [path, v] of Object.entries(opts.set ?? {})) {
      cmds.push({ type: 'setProperty', prop: { layer: id, path }, value: values.scalar(v) });
    }
    if (cmds.length > 0) await h.batch('fixture', cmds);
  });
  getCommandSystem().getHistory().clear();
  return id;
}

const transformProps = (id: string): Record<string, unknown> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, unknown>;

describe('Bevel style', () => {
  const mount = async (bevelDepth: number): Promise<string> => {
    const box = await layer('shape', 'box', {
      threeD: true,
      set: { 'geometry/extrusionDepth': 60, 'geometry/bevelDepth': bevelDepth },
    });
    render(<ThreeDControl nodeId={box} />);
    return box;
  };

  it('offers every profile in the union and writes the picked one — one undo entry', async () => {
    const box = await mount(8);
    const before = h.doc();
    const select = screen.getByLabelText('Bevel style') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['angular', 'concave', 'convex']);
    expect(select.value).toBe('angular');

    fireEvent.change(select, { target: { value: 'convex' } });
    await idle();
    expect(readNode3D(defaultSceneGraph.getNode(box)!).bevelStyle).toBe('convex');
    expect((screen.getByLabelText('Bevel style') as HTMLSelectElement).value).toBe('convex');
    settle();
    expect(historyLabels()).toEqual(['Bevel Style']);

    await undo();
    expect(readNode3D(defaultSceneGraph.getNode(box)!).bevelStyle).toBe('angular');
    expect(h.doc()).toBe(before);
  });

  it('back to the default clears the stored prop rather than writing "angular"', async () => {
    const box = await mount(8);
    const select = screen.getByLabelText('Bevel style') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'concave' } });
    await idle();
    expect(transformProps(box).bevelStyle).toBe('concave');
    fireEvent.change(screen.getByLabelText('Bevel style'), { target: { value: 'angular' } });
    await idle();
    expect(transformProps(box).bevelStyle).toBeUndefined();
    expect(readNode3D(defaultSceneGraph.getNode(box)!).bevelStyle).toBe('angular');
  });

  it('stays hidden while there is no chamfer to shape', async () => {
    await mount(0);
    // The section is drawn (a guard that this absence is not an empty panel)…
    expect(field('Extrusion depth')).toBeTruthy();
    expect(screen.queryByLabelText('Bevel style')).toBeNull();
  });
});

describe('Geometry Options — Hole Bevel Depth', () => {
  const mountText = async (bevelDepth: number): Promise<string> => {
    const txt = await layer('text', 'txt', {
      init: [
        { path: 'text/sourceText', value: { kind: 'textDocument', value: { text: 'O', runs: [], paragraphs: [], orientation: 'horizontal', kerning: 'metrics' } } },
        { path: 'text/fontSize', value: values.scalar(80) },
      ],
      threeD: true,
      set: { 'geometry/extrusionDepth': 40, 'geometry/bevelDepth': bevelDepth },
    });
    render(<ThreeDControl nodeId={txt} />);
    return txt;
  };

  it('a bevelled text layer offers it, defaulting to 100 % (holes bevel like the rim)', async () => {
    const txt = await mountText(6);
    expect(field('Hole bevel depth')).toBeTruthy();
    expect(readNode3D(defaultSceneGraph.getNode(txt)!).holeBevelDepth).toBe(100);
  });

  it('is absent without a bevel, and on a rect that has no counters', async () => {
    await mountText(0);
    expect(field('Extrusion depth')).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: 'Hole bevel depth' })).toBeNull();
    cleanup();
    // An engine-created shape layer is a rectangle (`shapeType: 'rect'`).
    const box = await layer('shape', 'box', {
      threeD: true,
      set: { 'geometry/extrusionDepth': 60, 'geometry/bevelDepth': 8 },
    });
    expect(transformProps(box).shapeType).toBe('rect');
    render(<ThreeDControl nodeId={box} />);
    expect(field('Bevel depth')).toBeTruthy();
    expect(screen.queryByRole('spinbutton', { name: 'Hole bevel depth' })).toBeNull();
  });

  it('every depth row carries a stopwatch', async () => {
    await mountText(6);
    for (const name of ['Extrusion Depth', 'Bevel Depth', 'Hole Bevel Depth']) {
      expect(screen.getAllByRole('button', { name: new RegExp(name, 'i') }).length).toBeGreaterThan(0);
    }
  });
});

describe('Morph Targets section', () => {
  /**
   * A model mesh layer, inserted as the importer's layers land: built
   * off-document and sent as ONE `pasteLayers` — Transform weights
   * `morph0…`, a Style, and the Model component (with the file's target names).
   */
  async function meshLayer(weights: Record<string, number>, model: Record<string, unknown>): Promise<string> {
    let ids: string[] | null = null;
    await act(async () => {
      ids = await insertBuiltLayers('Insert mesh', 'comp_root', () => {
        defaultSceneGraph.addChild('comp_root', {
          id: 'mesh', name: 'mesh', parent: null, children: [], visible: true, locked: false,
          transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
          components: [
            {
              id: 'mesh_t', type: 'Transform',
              props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 100, height: 100, ...weights },
            },
            { id: 'mesh_s', type: 'Style', props: { opacity: 100, fill: '#ffffff' } },
            { id: 'mesh_model', type: MODEL_COMPONENT, props: model },
          ],
        } as unknown as SceneNode);
      }, { select: false });
    });
    const inserted: string[] = ids ?? [];
    expect(inserted).toHaveLength(1);
    getCommandSystem().getHistory().clear();
    return inserted[0]!;
  }

  it('renders one named row per target and writes the static weight', async () => {
    const mesh = await meshLayer({ morph0: 0, morph1: 0.5 }, { modelKey: 'k', mesh: 0, prim: 0, morphNames: ['jawOpen', ''] });
    render(<ModelSection nodeId={mesh} />);

    expect(screen.getByText('2 targets')).toBeInTheDocument();
    const slider = screen.getByLabelText('jawOpen slider') as HTMLInputElement;
    expect(screen.getByLabelText('Target 2 slider')).toBeInTheDocument();

    fireEvent.change(slider, { target: { value: '0.75' } });
    await idle();
    expect(transformProps(mesh).morph0).toBeCloseTo(0.75);
  });

  it('the stopwatch creates a real track, and edits then land as keyframes', async () => {
    const mesh = await meshLayer({ morph0: 0.2 }, { modelKey: 'k', mesh: 0, prim: 0 });
    render(<ModelSection nodeId={mesh} />);

    fireEvent.click(screen.getByLabelText('Enable Target 1 animation'));
    await idle();
    expect(defaultAnimation.isAnimated(mesh, 'morph0')).toBe(true);
    // The row repaints itself off the engine's change (no explicit re-render).
    expect(screen.getByLabelText('Disable Target 1 animation')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Target 1 slider'), { target: { value: '0.9' } });
    await idle();
    expect(defaultAnimation.sample(mesh, 'morph0', 0)).toBeCloseTo(0.9);
    // The static prop is untouched — the track is what the renderer samples.
    expect(transformProps(mesh).morph0).toBeCloseTo(0.2);
  });

  it('Reset all zeroes every weight — one undo entry', async () => {
    const mesh = await meshLayer({ morph0: 0.4, morph1: 0.6 }, { modelKey: 'k', mesh: 0, prim: 0 });
    render(<ModelSection nodeId={mesh} />);
    const before = h.doc();
    fireEvent.click(screen.getByText('Reset all'));
    await idle();
    const t = transformProps(mesh);
    expect([t.morph0, t.morph1]).toEqual([0, 0]);
    settle();
    expect(historyLabels()).toEqual(['Reset morph targets']);

    await undo();
    const back = transformProps(mesh);
    expect([back.morph0, back.morph1]).toEqual([0.4, 0.6]);
    expect(h.doc()).toBe(before);
  });

  it('is absent for a layer with no morph props', async () => {
    const plain = await layer('shape', 'plain');
    const { container } = render(<ModelSection nodeId={plain} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('3D IK section', () => {
  /** root → mid → tip, every one of them 3D, plus a separate target layer. */
  const buildChain = async (): Promise<{ tip: string }> => {
    const at = (x: number, y = 0): PropertyInit[] => [{ path: 'transform/position', value: values.vec2(x, y) }];
    const root = await layer('shape', 'root', { threeD: true });
    const mid = await layer('shape', 'mid', { parent: root, init: at(50), threeD: true });
    const tip = await layer('shape', 'tip', { parent: mid, init: at(50), threeD: true });
    await layer('shape', 'goal', { init: at(200, 40), threeD: true });
    expect(defaultSceneGraph.getNode(tip)!.parent).toBe(mid);
    expect(defaultSceneGraph.getNode(mid)!.parent).toBe(root);
    return { tip };
  };

  it('appears for a chain tip and reports the ancestor count', async () => {
    const { tip } = await buildChain();
    expect(isIk3DTip(tip)).toBe(true);
    render(<Ik3DSection nodeId={tip} />);
    expect(screen.getByText('2 3D parents (3 joints)')).toBeInTheDocument();
  });

  it('stays away from a 3D layer with no 3D parent, and from a 2D layer', async () => {
    const lonely = await layer('shape', 'lonely', { threeD: true });
    const flat = await layer('shape', 'flat');
    expect(isIk3DTip(lonely)).toBe(false);
    expect(isIk3DTip(flat)).toBe(false);
    expect(render(<Ik3DSection nodeId={lonely} />).container).toBeEmptyDOMElement();
    expect(render(<Ik3DSection nodeId={flat} />).container).toBeEmptyDOMElement();
  });

  it('exposes the solver options and both actions', async () => {
    const { tip } = await buildChain();
    render(<Ik3DSection nodeId={tip} />);
    expect(field('IK iterations')).toHaveAttribute('aria-valuenow', '12');
    expect(field('IK damping')).toHaveAttribute('aria-valuenow', '34');
    expect(field('IK tolerance')).toHaveAttribute('aria-valuenow', '0.5');
    // Both buttons are inert until a target is named — the palette form's
    // failure mode was firing with an unusable selection and warning after.
    expect(screen.getByText('Pose at target').closest('button')).toBeDisabled();
    expect(screen.getByText('Bake to target').closest('button')).toBeDisabled();
  });
});
