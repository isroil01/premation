/**
 * The 2D tools write through the engine API (B3): every tool interaction is
 * ONE engine gesture = one undo entry, each message carries ABSOLUTE values
 * (drag-start state + total drag), Esc reverts, a burst of arrow presses is
 * one entry. Pinned against the real app engine: the label, the document the
 * gesture produced, and an exact undo / redo round trip.
 */

import { commands } from '@motion/workspace';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeMask } from '@core/effects/mask';
import { engineIdle as engineQueueIdle } from '@core/engine/engineInstance';
import { setupAppEngine, historyLabels } from '@core/engine/__testHelpers__/appEngine';
import { buildScene, type Scene } from '@core/engine/__testHelpers__/scene';
import type { Harness } from '@core/engine/__testHelpers__/harness';
import type { LocalEngine } from '@core/engine/LocalEngine';
import { usePreferenceStore } from '@stores/preferenceStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useGuidesStore } from '@stores/guidesStore';
import { createCommandPort, nudgeNodes, NUDGE_BURST_MS } from './ports';
import {
  beginViewportGesture,
  cancelToolGesture,
  endViewportGesture,
  flushToolBursts,
  settleToolEdits,
  toolBurstOpen,
} from './viewportGesture';
import { orbitCameraBy, trackCameraBy, dollyCameraBy } from './cameraNav';
import { dragDeviceHandleTo } from './deviceHandles';

/** Every tool action closed AND the engine queue drained. */
async function engineIdle(): Promise<void> {
  await settleToolEdits();
  await engineQueueIdle();
  await settleToolEdits();
  await engineQueueIdle();
}

let h: Harness & { engine: LocalEngine };
let s: Scene;

beforeEach(async () => {
  h = await setupAppEngine();
  s = await buildScene(h);
  usePreferenceStore.setState({ timelineAutoKeyframe: false });
});

afterEach(async () => {
  flushToolBursts();
  endViewportGesture();
  await engineIdle();
  await h.dispose();
});

const port = () => createCommandPort();

const tp = (id: string): Record<string, number> =>
  defaultSceneGraph.getNode(id)!.components.find((c) => c.type === 'Transform')!.props as Record<string, number>;

/** One pointer gesture: press, the tool's messages, release. */
async function drag(run: () => void): Promise<void> {
  beginViewportGesture();
  run();
  endViewportGesture();
  await engineIdle();
}

/** One action = one entry named `label`; undo restores the exact document, redo reapplies. */
async function oneEntry(label: string, run: () => Promise<void>): Promise<void> {
  const before = h.doc();
  const n = historyLabels().length;
  await run();
  await engineIdle();
  const after = h.doc();
  expect(after).not.toBe(before);
  expect(historyLabels().length).toBe(n + 1);
  expect(historyLabels().at(-1)).toBe(label);
  await h.run({ type: 'undo' });
  expect(h.doc()).toBe(before);
  await h.run({ type: 'redo' });
  expect(h.doc()).toBe(after);
}

describe('move (selection drag / move tool)', () => {
  it('per-move INCREMENTS become one absolute gesture: start + total', async () => {
    const x0 = tp(s.A).x!;
    const y0 = tp(s.A).y!;
    await oneEntry('Move', () => drag(() => {
      for (let i = 0; i < 6; i++) port().execute(commands.moveNodes([s.A], { x: 10, y: -5 }));
    }));
    expect(tp(s.A).x).toBeCloseTo(x0 + 60, 6);
    expect(tp(s.A).y).toBeCloseTo(y0 - 30, 6);
  });

  it('multi-select moves every layer by the same world delta, one entry', async () => {
    const a0 = tp(s.A).x!;
    const p0 = tp(s.P).x!;
    await oneEntry('Move', () => drag(() => {
      port().execute(commands.moveNodes([s.A, s.P], { x: 25, y: 0 }));
      port().execute(commands.moveNodes([s.A, s.P], { x: 25, y: 0 }));
    }));
    expect(tp(s.A).x).toBeCloseTo(a0 + 50, 6);
    expect(tp(s.P).x).toBeCloseTo(p0 + 50, 6);
  });

  it('an animated Position keys at the playhead instead of a static write', async () => {
    const keys0 = defaultAnimation.getTrackKeyframes(s.B, 'x')!.length;
    await oneEntry('Move', () => drag(() => {
      port().execute(commands.moveNodes([s.B], { x: 40, y: 0 }));
      port().execute(commands.moveNodes([s.B], { x: 40, y: 0 }));
    }));
    // The key at 0 (x = 100) was replaced, none added.
    expect(defaultAnimation.getTrackKeyframes(s.B, 'x')!.length).toBe(keys0);
    expect(defaultAnimation.sample(s.B, 'x', 0)).toBeCloseTo(180, 6);
  });

  it('Auto-Keyframe keys an unanimated Position', async () => {
    usePreferenceStore.setState({ timelineAutoKeyframe: true });
    await oneEntry('Move', () => drag(() => {
      port().execute(commands.moveNodes([s.A], { x: 5, y: 0 }));
      port().execute(commands.moveNodes([s.A], { x: 5, y: 0 }));
    }));
    expect(defaultAnimation.isAnimated(s.A, 'x')).toBe(true);
  });

  it('a PARENTED layer moves by the world delta through the parent inverse', async () => {
    // P scaled 2× and turned 90°: a world +20 x is parent-space (0, −10).
    await h.run({ type: 'setProperties', writes: [
      { prop: { layer: s.P, path: 'transform/scale' }, value: { kind: 'vec2', value: { x: 200, y: 200 } } },
      { prop: { layer: s.P, path: 'transform/rotation' }, value: { kind: 'scalar', value: 90 } },
    ] });
    await h.run({ type: 'setParent', layers: [s.A], parent: s.P, keepWorldTransform: true });
    const x0 = tp(s.A).x!;
    const y0 = tp(s.A).y!;
    await oneEntry('Move', () => drag(() => {
      port().execute(commands.moveNodes([s.A], { x: 12, y: 0 }));
      port().execute(commands.moveNodes([s.A], { x: 8, y: 0 }));
    }));
    expect(tp(s.A).x).toBeCloseTo(x0, 6);
    expect(tp(s.A).y).toBeCloseTo(y0 - 10, 6);
  });

  it('a 3D layer dragged in Top view moves in depth, not in y', async () => {
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { threeD: true } });
    useGuidesStore.setState({ camera3dMode: 'top' });
    try {
      const y0 = tp(s.A).y!;
      const z0 = tp(s.A).z ?? 0;
      await oneEntry('Move', () => drag(() => {
        port().execute(commands.moveNodes([s.A], { x: 0, y: 15 }));
        port().execute(commands.moveNodes([s.A], { x: 0, y: 15 }));
      }));
      expect(tp(s.A).y).toBeCloseTo(y0, 6);
      expect(Math.abs((tp(s.A).z ?? 0) - z0)).toBeCloseTo(30, 6);
    } finally {
      useGuidesStore.setState({ camera3dMode: 'active' });
    }
  });

  it('Esc reverts the drag: no entry, the document as before', async () => {
    const before = h.doc();
    const n = historyLabels().length;
    beginViewportGesture();
    port().execute(commands.moveNodes([s.A], { x: 50, y: 50 }));
    await engineIdle();
    expect(cancelToolGesture()).toBe(true);
    // The tool keeps sending until release; those are ignored.
    port().execute(commands.moveNodes([s.A], { x: 50, y: 50 }));
    endViewportGesture();
    await engineIdle();
    expect(h.doc()).toBe(before);
    expect(historyLabels().length).toBe(n);
  });

  it('a click that writes nothing records nothing', async () => {
    const n = historyLabels().length;
    await drag(() => {});
    expect(historyLabels().length).toBe(n);
  });
});

describe('nudge (arrow keys)', () => {
  it('a burst of five presses is ONE entry, absolute from the burst start', async () => {
    const x0 = tp(s.A).x!;
    const y0 = tp(s.A).y!;
    await oneEntry('Nudge', async () => {
      for (let i = 0; i < 5; i++) nudgeNodes([s.A], 1, 0);
      nudgeNodes([s.A], 0, 10);
      expect(toolBurstOpen()).toBe(true);
      await new Promise((r) => setTimeout(r, NUDGE_BURST_MS + 50));
      expect(toolBurstOpen()).toBe(false);
    });
    expect(tp(s.A).x).toBeCloseTo(x0 + 5, 6);
    expect(tp(s.A).y).toBeCloseTo(y0 + 10, 6);
  });

  it('another action ends the burst: two bursts, two entries, the second starts where the first ended', async () => {
    const n = historyLabels().length;
    const x0 = tp(s.A).x!;
    nudgeNodes([s.A], 1, 0);
    flushToolBursts();
    nudgeNodes([s.A], 1, 0);
    flushToolBursts();
    await engineIdle();
    expect(historyLabels().length).toBe(n + 2);
    expect(tp(s.A).x).toBeCloseTo(x0 + 2, 6);
  });

  it('a drag right after a burst starts from the nudged position', async () => {
    const x0 = tp(s.A).x!;
    nudgeNodes([s.A], 3, 0);
    // The press flushes the burst (beginViewportGesture); its commit is async.
    await drag(() => port().execute(commands.moveNodes([s.A], { x: 10, y: 0 })));
    expect(tp(s.A).x).toBeCloseTo(x0 + 13, 6);
  });
});

describe('rotate / scale / anchor', () => {
  it('rotate: the absolute world angle, one entry', async () => {
    await oneEntry('Rotate', () => drag(() => {
      port().execute(commands.rotateNode(s.A, Math.PI / 6, { x: 0, y: 0 }));
      port().execute(commands.rotateNode(s.A, Math.PI / 4, { x: 0, y: 0 }));
    }));
    expect(tp(s.A).rotation).toBeCloseTo(45, 6);
  });

  it('rotate under a rotated parent stores angle − parent', async () => {
    await h.run({ type: 'setProperty', prop: { layer: s.P, path: 'transform/rotation' }, value: { kind: 'scalar', value: 30 } });
    await h.run({ type: 'setParent', layers: [s.A], parent: s.P, keepWorldTransform: true });
    await drag(() => port().execute(commands.rotateNode(s.A, (50 * Math.PI) / 180, { x: 0, y: 0 })));
    expect(tp(s.A).rotation).toBeCloseTo(20, 6);
  });

  it('scale (corner / Alt): scale in stored multipliers, centre as position, one entry', async () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    await oneEntry('Scale', () => drag(() => {
      port().execute(commands.resizeNode(s.A, box, { x: 1.5, y: 1.5 }, { x: 900, y: 500 }));
      port().execute(commands.resizeNode(s.A, box, { x: 2, y: 3 }, { x: 910, y: 520 }));
    }));
    expect(tp(s.A).scaleX).toBeCloseTo(2, 6);
    expect(tp(s.A).scaleY).toBeCloseTo(3, 6);
    expect(tp(s.A).x).toBeCloseTo(910, 6);
    expect(tp(s.A).y).toBeCloseTo(520, 6);
  });

  it('Ctrl-resize writes Size and leaves Scale, one entry "Resize"', async () => {
    const sx = tp(s.A).scaleX ?? 1;
    await oneEntry('Resize', () => drag(() => {
      port().execute(commands.resizeNode(s.A, { x: 0, y: 0, width: 1, height: 1 }, { x: sx, y: sx }, { x: 500, y: 400 }, { x: 640, y: 360 }));
    }));
    expect(tp(s.A).width).toBe(640);
    expect(tp(s.A).height).toBe(360);
    expect(tp(s.A).scaleX ?? 1).toBeCloseTo(sx, 9);
  });

  it('multi scale and multi rotate: every layer in one entry', async () => {
    await oneEntry('Scale', () => drag(() => {
      port().execute(commands.multiResizeNodes([
        { id: s.A, scale: { x: 2, y: 2 }, position: { x: 100, y: 100 } },
        { id: s.P, scale: { x: 2, y: 2 }, position: { x: 300, y: 100 } },
      ]));
    }));
    expect(tp(s.A).scaleX).toBeCloseTo(2, 6);
    expect(tp(s.P).x).toBeCloseTo(300, 6);
    await oneEntry('Rotate', () => drag(() => {
      port().execute(commands.multiRotateNodes([
        { id: s.A, rotation: Math.PI / 2, position: { x: 50, y: 60 } },
        { id: s.P, rotation: Math.PI / 2, position: { x: 70, y: 80 } },
      ]));
    }));
    expect(tp(s.A).rotation).toBeCloseTo(90, 6);
    expect(tp(s.P).y).toBeCloseTo(80, 6);
  });

  it('pan behind: anchor + compensated position from the DRAG-START state', async () => {
    await h.run({ type: 'setProperties', writes: [
      { prop: { layer: s.A, path: 'transform/rotation' }, value: { kind: 'scalar', value: 90 } },
      { prop: { layer: s.A, path: 'transform/scale' }, value: { kind: 'vec2', value: { x: 200, y: 200 } } },
    ] });
    const x0 = tp(s.A).x!;
    const y0 = tp(s.A).y!;
    const ax0 = tp(s.A).anchorX ?? 0;
    const ay0 = tp(s.A).anchorY ?? 0;
    await oneEntry('Pan Behind', () => drag(() => {
      port().execute(commands.moveAnchor(s.A, { x: ax0 + 5, y: ay0 }));
      port().execute(commands.moveAnchor(s.A, { x: ax0 + 10, y: ay0 }));
    }));
    expect(tp(s.A).anchorX).toBeCloseTo(ax0 + 10, 6);
    // Δanchor (10, 0) · S 2 · R 90° = world (0, 20).
    expect(tp(s.A).x).toBeCloseTo(x0, 6);
    expect(tp(s.A).y).toBeCloseTo(y0 + 20, 6);
  });
});

describe('delete, masks', () => {
  it('Delete: one entry, the deleted layers leave the selection', async () => {
    useSelectionStore.getState().set([s.A, s.P]);
    await oneEntry('Delete layer', async () => {
      port().execute(commands.deleteNodes([s.A]));
      await engineIdle();
    });
    expect(defaultSceneGraph.getNode(s.A)).toBeFalsy();
    expect(useSelectionStore.getState().ids).toEqual([s.P]);
  });

  it('mask tools: a drawn mask is one "New Mask" entry', async () => {
    const n0 = readNodeMask(defaultSceneGraph.getNode(s.B)!)?.paths.length ?? 0;
    await oneEntry('New Mask', () => drag(() => {
      port().execute(commands.createNode('Path', { x: 0, y: 0, width: 40, height: 40 }, [
        { x: -20, y: -20, inX: -20, inY: -20, outX: -20, outY: -20 },
        { x: 20, y: -20, inX: 20, inY: -20, outX: 20, outY: -20 },
        { x: 20, y: 20, inX: 20, inY: 20, outX: 20, outY: 20 },
      ], s.B));
    }));
    expect(readNodeMask(defaultSceneGraph.getNode(s.B)!)!.paths.length).toBe(n0 + 1);
  });

  it('Direct Selection mask reshape: one "Edit Mask" entry with the final outline', async () => {
    const pts = (dx: number) => [
      { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
      { x: 100 + dx, y: 0, inX: 100 + dx, inY: 0, outX: 100 + dx, outY: 0 },
      { x: 100, y: 100, inX: 100, inY: 100, outX: 100, outY: 100 },
    ];
    await oneEntry('Edit Mask', () => drag(() => {
      for (const dx of [5, 10, 15]) port().execute(commands.updateMaskPath(s.A, s.mask, pts(dx)));
    }));
    expect(readNodeMask(defaultSceneGraph.getNode(s.A)!)!.paths[0]!.points[1]!.x).toBe(115);
  });
});

describe('camera navigation and device handles', () => {
  async function camera(extra: Record<string, number> = {}): Promise<string> {
    const cam = (await h.run({ type: 'createLayer', comp: s.comp, kind: 'camera', name: 'Cam', init: [] })).layer;
    const t = defaultSceneGraph.getNode(cam)!.components.find((c) => c.type === 'Transform')!;
    // Seeded the way the legacy writes leave a camera that has been orbited.
    for (const [k, v] of Object.entries(extra)) defaultSceneGraph.writeProp(cam, t.id, k, v);
    await h.run({ type: 'setLayerSwitches', layers: [s.A], patch: { threeD: true } });
    return cam;
  }

  it('orbit drag: incremental steps read back the action\'s own writes, one entry', async () => {
    const cam = await camera({ orbitYaw: 0, orbitPitch: 0 });
    const nav = { nodeId: cam, transId: `${cam}_t` };
    await oneEntry('Orbit Camera', () => drag(() => {
      for (let i = 0; i < 5; i++) orbitCameraBy(nav, 10, 5);
    }));
    expect(tp(cam).orbitYaw).toBeCloseTo(20, 6);
    expect(tp(cam).orbitPitch).toBeCloseTo(10, 6);
  });

  it('track and dolly: one entry each', async () => {
    const cam = await camera();
    const nav = { nodeId: cam, transId: `${cam}_t` };
    const x0 = tp(cam).x!;
    const z0 = tp(cam).z!;
    await oneEntry('Track Camera', () => drag(() => {
      trackCameraBy(nav, 10, 0, 1, 1920, 1080);
      trackCameraBy(nav, 10, 0, 1, 1920, 1080);
    }));
    expect(tp(cam).x).toBeCloseTo(x0 - 20, 6);
    await oneEntry('Dolly Camera', () => drag(() => {
      dollyCameraBy(nav, -10, 1920);
      dollyCameraBy(nav, -10, 1920);
    }));
    expect(tp(cam).z).toBeCloseTo(z0 + 40, 6);
  });

  it('a wheel dolly (no pointer gesture) is one entry per burst', async () => {
    const cam = await camera();
    const nav = { nodeId: cam, transId: `${cam}_t` };
    const z0 = tp(cam).z!;
    await oneEntry('Dolly Camera', async () => {
      for (let i = 0; i < 4; i++) dollyCameraBy(nav, -5, 1920);
      flushToolBursts();
    });
    expect(tp(cam).z).toBeCloseTo(z0 + 40, 6);
  });

  it('a device handle drag: absolute world target, one entry', async () => {
    const cam = await camera();
    await oneEntry('Move Camera', () => drag(() => {
      dragDeviceHandleTo({ nodeId: cam, device: 'camera', kind: 'position', world: { x: 0, y: 0, z: 0 } }, { x: 100, y: 200, z: -300 }, 0);
      dragDeviceHandleTo({ nodeId: cam, device: 'camera', kind: 'position', world: { x: 0, y: 0, z: 0 } }, { x: 110, y: 220, z: -330 }, 0);
    }));
    expect(tp(cam).x).toBeCloseTo(110, 6);
    expect(tp(cam).z).toBeCloseTo(-330, 6);
  });
});
