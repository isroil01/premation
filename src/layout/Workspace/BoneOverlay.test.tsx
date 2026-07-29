/**
 * BoneOverlay — the canvas skeleton UI.
 *
 * Covers the pointer plumbing that until now was only ever verified by hand:
 * bone drawing/selection, FK posing, IK targets and pole handles, the skinning
 * mesh preview, and weight-paint strokes.
 */

import { render, act, fireEvent } from '@testing-library/react';
import { BoneOverlay } from './BoneOverlay';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { defaultAnimation } from '@motion/animation';
import { clearRestMeshCache } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { isWeightPaintEmpty } from '@core/rig/weightPaint';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';

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

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      {
        id: `${id}_t`,
        type: 'Transform',
        props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, width: 200, height: 160 },
      },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

const TWO_BONES = [
  { id: 'upper', name: 'Upper', parentId: null, length: 50, x: -60, y: 0, rotation: 0 },
  { id: 'fore', name: 'Fore', parentId: 'upper', length: 50, x: 50, y: 0, rotation: 0 },
];

const skelOf = () => readNodeSkeleton(defaultSceneGraph.getNode('b1')!);
const bonePolys = (c: HTMLElement) => c.querySelectorAll('polygon[stroke="#ffaa00"]');

/** Select the first bone by pressing on its group. */
function selectFirstBone(container: HTMLElement): void {
  const g = bonePolys(container)[0]!.parentElement!;
  fireEvent.pointerDown(g, { clientX: -60, clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(container.querySelector('svg')!, { clientX: -60, clientY: 0, pointerId: 1 });
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  clearRestMeshCache();
  try { defaultSceneGraph.removeNode('b1'); } catch { /* fresh */ }
  defaultSceneGraph.addNode(shapeNode('b1'));
  defaultSceneGraph.setSkeleton('b1', {
    bones: TWO_BONES.map((b) => ({ ...b })),
    ikTargets: [],
    meshDensity: 6,
    meshExpansion: 0,
  });
  useSelectionStore.getState().set(['b1']);
  useUIStore.getState().setActiveTool('bone');
});

describe('gating and drawing', () => {
  it('renders nothing unless the bone tool is active', () => {
    act(() => useUIStore.getState().setActiveTool('select'));
    const { container } = render(<BoneOverlay />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws one tapered polygon per bone', () => {
    const { container } = render(<BoneOverlay />);
    expect(bonePolys(container)).toHaveLength(2);
  });

  it('draws the skinning MESH preview (§12.9 — the bone tool never showed it)', () => {
    const { container } = render(<BoneOverlay />);
    // density 6 ⇒ 72 mesh triangles, drawn with the mesh stroke.
    expect(container.querySelectorAll('polygon[stroke="rgba(255, 170, 0, 0.22)"]')).toHaveLength(72);
  });

  it('shows the weight heatmap only once a bone is selected', () => {
    const { container } = render(<BoneOverlay />);
    const heat = () =>
      [...container.querySelectorAll('polygon')].filter((p) =>
        /^rgba\(\d+, \d+, \d+, 0\.45\)$/.test(p.getAttribute('fill') ?? ''),
      ).length;
    expect(heat()).toBe(0);
    selectFirstBone(container);
    expect(heat()).toBeGreaterThan(0);
  });
});

describe('bone authoring', () => {
  it('clicking empty canvas adds a bone with a distinct id', () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: 70, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 70, clientY: 40, pointerId: 1 });
    fireEvent.click(svg, { clientX: 70, clientY: 40 });

    const bones = skelOf()!.bones;
    expect(bones).toHaveLength(3);
    expect(new Set(bones.map((b) => b.id)).size).toBe(3);
  });

  it('a real drag does NOT also add a bone (travel past the slop suppresses it)', () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 60, clientY: 60, pointerId: 1 });
    fireEvent.click(svg, { clientX: 60, clientY: 60 });
    expect(skelOf()!.bones).toHaveLength(2);
  });

  it('dragging a child bone writes its rotation track (FK)', () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    const foreG = bonePolys(container)[1]!.parentElement!;
    fireEvent.pointerDown(foreG, { clientX: -10, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: -10, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: -10, clientY: 40, pointerId: 1 });

    expect(defaultAnimation.getTrackKeyframes('b1', 'bone.fore.rotation')?.length).toBeGreaterThan(0);
  });
});

describe('IK', () => {
  beforeEach(() => {
    defaultSceneGraph.setSkeleton('b1', {
      bones: TWO_BONES.map((b) => ({ ...b })),
      ikTargets: [{ boneId: 'fore', x: 30, y: 30, enabled: true, pole: { x: 0, y: -80 } }],
      meshDensity: 6,
      meshExpansion: 0,
    });
  });

  it('renders the IK target crosshair and the pole handle', () => {
    const { container } = render(<BoneOverlay />);
    expect(container.querySelector('circle[stroke="#ff0055"]')).not.toBeNull();
    expect(container.querySelector('polygon[fill="#a855f7"]')).not.toBeNull();
  });

  it('dragging the pole writes the keyframeable ikPole tracks', () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    const poleG = container.querySelector('polygon[fill="#a855f7"]')!.parentElement!;
    fireEvent.pointerDown(poleG, { clientX: 0, clientY: -80, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 5, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 5, clientY: 90, pointerId: 1 });

    expect(defaultAnimation.getTrackKeyframes('b1', 'ikPole.fore.x')?.[0]?.value).toBeCloseTo(5, 3);
    expect(defaultAnimation.getTrackKeyframes('b1', 'ikPole.fore.y')?.[0]?.value).toBeCloseTo(90, 3);
  });

  it('bones in an active IK chain are tinted differently', () => {
    const { container } = render(<BoneOverlay />);
    expect(container.querySelector('polygon[stroke="#ff0055"]')).not.toBeNull();
  });
});

describe('weight painting', () => {
  const paintButton = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll('g')].find(
      (g) =>
        g.children.length === 2 &&
        g.children[0]!.tagName === 'rect' &&
        g.children[1]!.textContent === label,
    );

  it('offers the brush modes, disabled until a bone is selected', () => {
    const { container } = render(<BoneOverlay />);
    expect(paintButton(container, 'Paint +')).toBeTruthy();
    expect(paintButton(container, 'Paint −')).toBeTruthy();
    expect(paintButton(container, 'Smooth')).toBeTruthy();
    expect(
      [...container.querySelectorAll('text')].some((t) => /Select a bone to paint/.test(t.textContent ?? '')),
    ).toBe(true);
  });

  it('a stroke writes a paint map, and only for the selected bone', () => {
    const { container } = render(<BoneOverlay />);
    selectFirstBone(container);
    fireEvent.click(paintButton(container, 'Paint +')!);

    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: -40, clientY: 0, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: -20, clientY: 0, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: -20, clientY: 0, pointerId: 2 });

    const paint = skelOf()!.weightPaint;
    expect(isWeightPaintEmpty(paint)).toBe(false);
    expect(Object.keys(paint!.bones)).toEqual(['upper']);
    // Indices are positional, so the map records the mesh it was painted at.
    expect(paint!.vertexCount).toBe(49); // density 6 ⇒ 7×7 vertices
  });

  it('painting is a no-op with no bone selected', () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: -40, clientY: 0, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: -40, clientY: 0, pointerId: 2 });
    expect(isWeightPaintEmpty(skelOf()!.weightPaint)).toBe(true);
  });
});
