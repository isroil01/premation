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
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { engineIdle } from '@core/engine/engineInstance';
import { rigTestLayer } from './__testHelpers__/rigLayer';
import { useRigSelectionStore } from '@stores/rigSelectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';

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

const TWO_BONES = [
  { id: 'upper', name: 'Upper', parentId: null, length: 50, x: -60, y: 0, rotation: 0 },
  { id: 'fore', name: 'Fore', parentId: 'upper', length: 50, x: 50, y: 0, rotation: 0 },
];

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created). */
let L = '';
const skelOf = () => readNodeSkeleton(defaultSceneGraph.getNode(L)!);
/** Let the engine apply what the overlay sent (and React re-render). */
const idle = (): Promise<void> => act(async () => { await engineIdle(); });
const bonePolys = (c: HTMLElement) => c.querySelectorAll('polygon[stroke="var(--color-overlay-rig-bone)"]');

/** Select the first bone by pressing on its group. */
function selectFirstBone(container: HTMLElement): void {
  const g = bonePolys(container)[0]!.parentElement!;
  fireEvent.pointerDown(g, { clientX: -60, clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(container.querySelector('svg')!, { clientX: -60, clientY: 0, pointerId: 1 });
}

beforeEach(async () => {
  h = await setupAppEngine();
  clearRestMeshCache();
  L = await rigTestLayer(h, {
    skeleton: { bones: TWO_BONES.map((b) => ({ ...b })), ikTargets: [], meshDensity: 6, meshExpansion: 0 },
  });
  useSelectionStore.getState().set([L]);
  useUIStore.getState().setActiveTool('bone');
  useUIStore.getState().setBoneRigMode('draw');
  useUIStore.getState().setBoneWeightMode('add');
  useRigSelectionStore.getState().clear();
  usePreferenceStore.setState({ timelineAutoKeyframe: false });
});
afterEach(async () => { await h.dispose(); });

describe('gating and drawing', () => {
  it('renders nothing unless the bone tool is active', async () => {
    act(() => useUIStore.getState().setActiveTool('select'));
    const { container } = render(<BoneOverlay />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws one tapered polygon per bone', async () => {
    const { container } = render(<BoneOverlay />);
    expect(bonePolys(container)).toHaveLength(2);
  });

  it('draws the skinning MESH preview (§12.9 — the bone tool never showed it)', async () => {
    act(() => useUIStore.getState().setBoneRigMode('weights'));
    const { container } = render(<BoneOverlay />);
    // density 6 ⇒ 72 mesh triangles, drawn with the mesh stroke.
    expect(container.querySelectorAll('polygon[stroke="var(--color-overlay-rig-mesh-edge)"]')).toHaveLength(72);
  });

  it('shows the weight heatmap only once a bone is selected', async () => {
    act(() => useUIStore.getState().setBoneRigMode('weights'));
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
  it('a plain click creates no fixed-length bone', async () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: 70, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 70, clientY: 40, pointerId: 1 });
    fireEvent.click(svg, { clientX: 70, clientY: 40 });
    await idle();

    const bones = skelOf()!.bones;
    expect(bones).toHaveLength(2);
  });

  it('dragging empty canvas creates a measured root bone', async () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 160, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 160, clientY: 160, pointerId: 1 });
    fireEvent.click(svg, { clientX: 160, clientY: 160 });
    await idle();
    const bones = skelOf()!.bones;
    expect(bones).toHaveLength(3);
    expect(bones[2]!.id).toBe('bone_1');
    expect(historyLabels().at(-1)).toBe('Add Bone');
    expect(bones[2]!.parentId).toBeNull();
    expect(bones[2]!.length).toBeCloseTo(Math.hypot(60, 60));
  });

  it('dragging from an existing tip creates a connected child', async () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    const foreG = bonePolys(container)[1]!.parentElement!;
    fireEvent.pointerDown(foreG, { clientX: 40, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 40, clientY: 40, pointerId: 1 });
    await idle();
    expect(skelOf()!.bones.at(-1)?.parentId).toBe('fore');
  });

  it('Escape cancels the live bone preview', async () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 60, clientY: 10, pointerId: 1 });
    expect(container.querySelector('[data-bone-draft]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('[data-bone-draft]')).toBeNull();
    expect(skelOf()!.bones).toHaveLength(2);
  });

  it('posing keys only when auto-key is enabled', async () => {
    act(() => {
      useUIStore.getState().setBoneRigMode('pose');
      usePreferenceStore.setState({ timelineAutoKeyframe: true });
    });
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    const foreG = bonePolys(container)[1]!.parentElement!;
    fireEvent.pointerDown(foreG, { clientX: -10, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: -10, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: -10, clientY: 40, pointerId: 1 });
    await idle();
    expect(defaultAnimation.getTrackKeyframes(L, 'bone.fore.rotation')?.length).toBeGreaterThan(0);
    expect(historyLabels().at(-1)).toBe('Pose Bone fore');
  });
});

describe('IK', () => {
  beforeEach(() => {
    useUIStore.getState().setBoneRigMode('pose');
    defaultSceneGraph.setSkeleton(L, {
      bones: TWO_BONES.map((b) => ({ ...b })),
      ikTargets: [{ boneId: 'fore', x: 30, y: 30, enabled: true, pole: { x: 0, y: -80 } }],
      meshDensity: 6,
      meshExpansion: 0,
    });
  });

  it('renders the IK target crosshair and the pole handle', async () => {
    const { container } = render(<BoneOverlay />);
    expect(container.querySelector('circle[stroke="var(--color-overlay-rig-ik)"]')).not.toBeNull();
    expect(container.querySelector('polygon[fill="var(--color-overlay-rig-pole)"]')).not.toBeNull();
  });

  it('dragging the pole writes the keyframeable ikPole tracks', async () => {
    act(() => usePreferenceStore.setState({ timelineAutoKeyframe: true }));
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    const poleG = container.querySelector('polygon[fill="var(--color-overlay-rig-pole)"]')!.parentElement!;
    fireEvent.pointerDown(poleG, { clientX: 0, clientY: -80, pointerId: 1 });
    fireEvent.pointerMove(svg, { clientX: 5, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 5, clientY: 90, pointerId: 1 });
    await idle();

    expect(defaultAnimation.getTrackKeyframes(L, 'ikPole.fore.x')?.[0]?.value).toBeCloseTo(5, 3);
    expect(defaultAnimation.getTrackKeyframes(L, 'ikPole.fore.y')?.[0]?.value).toBeCloseTo(90, 3);
    expect(historyLabels().at(-1)).toBe('Move IK Pole fore');
  });

  it('bones in an active IK chain are tinted differently', async () => {
    const { container } = render(<BoneOverlay />);
    expect(container.querySelector('polygon[stroke="var(--color-overlay-rig-ik)"]')).not.toBeNull();
  });
});

describe('weight painting', () => {
  beforeEach(() => {
    useUIStore.getState().setBoneRigMode('weights');
    useUIStore.getState().setBoneWeightMode('add');
  });

  it('shows the mesh only in Weights mode', async () => {
    const { container } = render(<BoneOverlay />);
    expect(container.querySelectorAll('polygon[stroke="var(--color-overlay-rig-mesh-edge)"]').length).toBeGreaterThan(0);
    act(() => useUIStore.getState().setBoneRigMode('pose'));
    expect(container.querySelectorAll('polygon[stroke="var(--color-overlay-rig-mesh-edge)"]')).toHaveLength(0);
  });

  it('a stroke writes a paint map, and only for the selected bone', async () => {
    const { container } = render(<BoneOverlay />);
    selectFirstBone(container);

    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: -40, clientY: 0, pointerId: 2 });
    fireEvent.pointerMove(svg, { clientX: -20, clientY: 0, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: -20, clientY: 0, pointerId: 2 });
    await idle();

    const paint = skelOf()!.weightPaint;
    expect(historyLabels().at(-1)).toBe('Paint Bone Weights');
    expect(isWeightPaintEmpty(paint)).toBe(false);
    expect(Object.keys(paint!.bones)).toEqual(['upper']);
    // Indices are positional, so the map records the mesh it was painted at.
    expect(paint!.vertexCount).toBe(49); // density 6 ⇒ 7×7 vertices
  });

  it('painting is a no-op with no bone selected', async () => {
    const { container } = render(<BoneOverlay />);
    const svg = container.querySelector('svg')!;
    fireEvent.pointerDown(svg, { clientX: -40, clientY: 0, pointerId: 2 });
    fireEvent.pointerUp(svg, { clientX: -40, clientY: 0, pointerId: 2 });
    await idle();
    expect(isWeightPaintEmpty(skelOf()!.weightPaint)).toBe(true);
  });
});
