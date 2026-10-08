/**
 * BoneOverlay — the canvas skeleton UI.
 *
 * Covers the pointer plumbing that until now was only ever verified by hand:
 * bone drawing/selection, FK posing, IK targets and pole handles, the skinning
 * mesh preview, and weight-paint strokes.
 */

import { render, act, fireEvent, waitFor } from '@testing-library/react';
import { BoneOverlay } from './BoneOverlay';
import { useSelectionStore } from '@stores/selectionStore';
import { useUIStore } from '@stores/uiStore';
import { clearRestMeshCache } from '@core/rig/puppet';
import { readNodeSkeleton } from '@core/rig/skeletonCommands';
import { isWeightPaintEmpty } from '@core/rig/weightPaint';
import { clearHistory, setupAppEngine, historyLabels, settleEdits, waitForFrame } from '@core/engine/__testHelpers__/appEngine';
import { docView } from '@core/engine/__testHelpers__/docView';
import { rigTestLayer } from './__testHelpers__/rigLayer';
import { selectedRigBone, useRigSelectionStore } from '@stores/rigSelectionStore';
import { usePreferenceStore } from '@stores/preferenceStore';

jest.mock('@core/workspace/WorkspaceController', () => ({
  getWorkspaceController: () => ({
    onRender: () => () => undefined,
    requestRender: () => undefined,
    // 1:1, unpanned — the comp → stage view the overlays map through (useDisplayedCamera2D).
    getView: () => ({ scale: 1, offsetX: 0, offsetY: 0 }),
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

/** The overlay's SVG, once a frame has carried the geometry it draws from. */
async function svgOf(container: HTMLElement): Promise<SVGSVGElement> {
  await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
  return container.querySelector('svg')!;
}

let h: Awaited<ReturnType<typeof setupAppEngine>>;
/** The rig layer (engine-created). */
let L = '';
const skelOf = async () => readNodeSkeleton((await docView()).getNode(L)!);
/** Let the engine apply what the overlay sent (and React re-render). */
/** Let the engine apply what the overlay sent (and React re-render) — several rounds: the rig push's
 * subscription lands, and pointer input goes through getRigPose before it writes (B4 round 5). */
const idle = (): Promise<void> => act(async () => { await settleEdits(); await waitForFrame(300); await settleEdits(); });
/** The overlay's SVG as mounted NOW (a frame may have re-rendered it since it was found). */
const live = (container: HTMLElement, fallback: Element): Element => container.querySelector('svg') ?? fallback;
const bonePolys = (c: HTMLElement) => c.querySelectorAll('polygon[stroke="var(--color-overlay-rig-bone)"]');

/** Select the first bone by pressing on its group — the group as mounted now (a frame may
 * have re-rendered it), pressed again until the rig selection holds it. */
async function selectFirstBone(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    if (!selectedRigBone(L)) {
      const g = bonePolys(container)[0]!.parentElement!;
      fireEvent.pointerDown(g, { clientX: -60, clientY: 0, pointerId: 1 });
      fireEvent.pointerUp(container.querySelector('svg')!, { clientX: -60, clientY: 0, pointerId: 1 });
    }
    expect(selectedRigBone(L)).not.toBeNull();
  });
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

    await idle();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('draws one tapered polygon per bone', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    expect(bonePolys(container)).toHaveLength(2);
  });

  it('draws the skinning MESH preview (§12.9 — the bone tool never showed it)', async () => {
    act(() => useUIStore.getState().setBoneRigMode('weights'));
    const { container } = render(<BoneOverlay />);

    await idle();
    // density 6 ⇒ 72 mesh triangles, drawn with the mesh stroke.
    expect(container.querySelectorAll('polygon[stroke="var(--color-overlay-rig-mesh-edge)"]')).toHaveLength(72);
  });

  it('shows the weight heatmap only once a bone is selected', async () => {
    act(() => useUIStore.getState().setBoneRigMode('weights'));
    const { container } = render(<BoneOverlay />);

    await idle();
    const heat = () =>
      [...container.querySelectorAll('polygon')].filter((p) =>
        /^rgba\(\d+, \d+, \d+, 0\.45\)$/.test(p.getAttribute('fill') ?? ''),
      ).length;
    expect(heat()).toBe(0);
    await selectFirstBone(container);
    expect(heat()).toBeGreaterThan(0);
  });
});

describe('bone authoring', () => {
  it('a plain click creates no fixed-length bone', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.pointerDown(live(container, svg), { clientX: 70, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: 70, clientY: 40, pointerId: 1 });
    fireEvent.click(svg, { clientX: 70, clientY: 40 });
    await idle();

    const bones = (await skelOf())!.bones;
    expect(bones).toHaveLength(2);
  });

  it('dragging empty canvas creates a measured root bone', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.pointerDown(live(container, svg), { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(live(container, svg), { clientX: 160, clientY: 160, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: 160, clientY: 160, pointerId: 1 });
    fireEvent.click(svg, { clientX: 160, clientY: 160 });
    await idle();
    const bones = (await skelOf())!.bones;
    expect(bones).toHaveLength(3);
    expect(bones[2]!.id).toBe('bone_1');
    expect((await historyLabels()).at(-1)).toBe('Add Bone');
    expect(bones[2]!.parentId).toBeNull();
    expect(bones[2]!.length).toBeCloseTo(Math.hypot(60, 60));
  });

  it('dragging from an existing tip creates a connected child', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    const svg = await svgOf(container);
    const foreG = bonePolys(container)[1]!.parentElement!;
    fireEvent.pointerDown(foreG, { clientX: 40, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(live(container, svg), { clientX: 40, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: 40, clientY: 40, pointerId: 1 });
    await idle();
    expect((await skelOf())!.bones.at(-1)?.parentId).toBe('fore');
  });

  it('Escape cancels the live bone preview', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.pointerDown(live(container, svg), { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(live(container, svg), { clientX: 60, clientY: 10, pointerId: 1 });
    expect(container.querySelector('[data-bone-draft]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('[data-bone-draft]')).toBeNull();
    expect((await skelOf())!.bones).toHaveLength(2);
  });

  it('posing keys only when auto-key is enabled', async () => {
    act(() => {
      useUIStore.getState().setBoneRigMode('pose');
      usePreferenceStore.setState({ timelineAutoKeyframe: true });
    });
    const { container } = render(<BoneOverlay />);

    await idle();
    const svg = await svgOf(container);
    const foreG = bonePolys(container)[1]!.parentElement!;
    fireEvent.pointerDown(foreG, { clientX: -10, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(live(container, svg), { clientX: -10, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: -10, clientY: 40, pointerId: 1 });
    await idle();
    expect((await docView()).getTrackKeyframes(L, 'bone.fore.rotation')?.length).toBeGreaterThan(0);
    expect((await historyLabels()).at(-1)).toBe('Pose Bone fore');
  });
});

describe('IK', () => {
  beforeEach(async () => {
    useUIStore.getState().setBoneRigMode('pose');
    await h.run({ type: 'setProperty', prop: { layer: L, path: 'layer/skeleton' }, value: { kind: 'json', value: JSON.stringify({
      bones: TWO_BONES.map((b) => ({ ...b })),
      ikTargets: [{ boneId: 'fore', x: 30, y: 30, enabled: true, pole: { x: 0, y: -80 } }],
      meshDensity: 6,
      meshExpansion: 0,
    }) } });
    await clearHistory();
  });

  it('renders the IK target crosshair and the pole handle', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    expect(container.querySelector('circle[stroke="var(--color-overlay-rig-ik)"]')).not.toBeNull();
    expect(container.querySelector('polygon[fill="var(--color-overlay-rig-pole)"]')).not.toBeNull();
  });

  it('dragging the pole writes the keyframeable ikPole tracks', async () => {
    act(() => usePreferenceStore.setState({ timelineAutoKeyframe: true }));
    const { container } = render(<BoneOverlay />);

    await idle();
    const svg = await svgOf(container);
    const poleG = container.querySelector('polygon[fill="var(--color-overlay-rig-pole)"]')!.parentElement!;
    fireEvent.pointerDown(poleG, { clientX: 0, clientY: -80, pointerId: 1 });
    fireEvent.pointerMove(live(container, svg), { clientX: 5, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(live(container, svg), { clientX: 5, clientY: 90, pointerId: 1 });
    await idle();

    expect((await docView()).getTrackKeyframes(L, 'ikPole.fore.x')?.[0]?.value).toBeCloseTo(5, 3);
    expect((await docView()).getTrackKeyframes(L, 'ikPole.fore.y')?.[0]?.value).toBeCloseTo(90, 3);
    expect((await historyLabels()).at(-1)).toBe('Move IK Pole fore');
  });

  it('bones in an active IK chain are tinted differently', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
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

    await idle();
    expect(container.querySelectorAll('polygon[stroke="var(--color-overlay-rig-mesh-edge)"]').length).toBeGreaterThan(0);
    act(() => useUIStore.getState().setBoneRigMode('pose'));
    expect(container.querySelectorAll('polygon[stroke="var(--color-overlay-rig-mesh-edge)"]')).toHaveLength(0);
  });

  it('a stroke writes a paint map, and only for the selected bone', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    await selectFirstBone(container);

    const svg = await svgOf(container);
    fireEvent.pointerDown(live(container, svg), { clientX: -40, clientY: 0, pointerId: 2 });
    fireEvent.pointerMove(live(container, svg), { clientX: -20, clientY: 0, pointerId: 2 });
    fireEvent.pointerUp(live(container, svg), { clientX: -20, clientY: 0, pointerId: 2 });
    await idle();

    const paint = (await skelOf())!.weightPaint;
    expect((await historyLabels()).at(-1)).toBe('Paint Bone Weights');
    expect(isWeightPaintEmpty(paint)).toBe(false);
    expect(Object.keys(paint!.bones)).toEqual(['upper']);
    // Indices are positional, so the map records the mesh it was painted at.
    expect(paint!.vertexCount).toBe(49); // density 6 ⇒ 7×7 vertices
  });

  it('painting is a no-op with no bone selected', async () => {
    const { container } = render(<BoneOverlay />);

    await idle();
    const svg = await svgOf(container);
    fireEvent.pointerDown(live(container, svg), { clientX: -40, clientY: 0, pointerId: 2 });
    fireEvent.pointerUp(live(container, svg), { clientX: -40, clientY: 0, pointerId: 2 });
    await idle();
    expect(isWeightPaintEmpty((await skelOf())!.weightPaint)).toBe(true);
  });
});
