/**
 * Puppet INTERACTION path — reproduces the exact gesture the PuppetOverlay runs
 * (add pin → begin anim transaction → live setDataTrack on each move → commit +
 * record), across TWO playhead times, then rebuilds the snapshot and asserts the
 * rendered mesh actually animates. Guards the whole write→persist→sample→deform
 * chain the UI depends on (the parity test only sets tracks directly).
 */

import { buildSnapshot } from '@core/rendering/buildSnapshot';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation, upsertDataKeyframe } from '@motion/animation';
import { addPuppetPin } from './puppetCommands';
import { beginAnimEdit, recordAnimEdit } from '@core/animation/animationCommands';
import { setCommandSystem, CommandSystem } from '@core/commands/CommandSystem';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { SceneNode } from '@core/types';

const comp = { width: 800, height: 600, background: '#101014' };

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 400, y: 300 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [
      { id: `${id}_t`, type: 'Transform', props: { [SCENE_KIND_PROP]: 'shape', x: 400, y: 300, rotation: 0, width: 200, height: 160 } },
      { id: `${id}_s`, type: 'Style', props: { opacity: 100, fill: '#2b7eff' } },
    ],
  } as unknown as SceneNode;
}

/** Exactly what PuppetOverlay.onPointerMove writes for a move-mode drag. */
function dragPinTo(nodeId: string, pinId: string, layerT: number, x: number, y: number): void {
  const prop = `puppet.${pinId}.position`;
  const track = defaultAnimation.getDataTrack(nodeId, prop) || { nodeId, prop, kind: 'points' as const, keyframes: [] };
  const value = [{ x, y }];
  const keyframes = upsertDataKeyframe(track.keyframes, { t: layerT, value });
  defaultAnimation.setDataTrack(nodeId, prop, { ...track, keyframes });
}

function meshAt(t: number): Float32Array {
  const snap = buildSnapshot(defaultSceneGraph, defaultAnimation, t, undefined, undefined, undefined, undefined, comp);
  const layer = snap.layers.find((l) => l.id === 'm');
  expect(layer).toBeDefined();
  expect(layer!.deformedMesh).toBeDefined();
  return layer!.deformedMesh!.vertices;
}

describe('Puppet interaction → animation (full overlay gesture)', () => {
  beforeEach(() => {
    setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
    defaultSceneGraph.clear();
    defaultSceneGraph.addNode(shapeNode('m'));
    // Reset any animation state from a prior test.
    defaultAnimation.setDataTrack('m', 'puppet.p1.position', null);
  });

  it('two keyframes at different times animate the rendered mesh', () => {
    // Place a pin (undoable structural command, like clicking on the layer).
    addPuppetPin('m', { id: 'p1', name: 'Pin 1', x: 0, y: 0 });

    // Gesture 1: at t=0, drag the pin to rest (0,0).
    let tx = beginAnimEdit();
    dragPinTo('m', 'p1', 0, 0, 0);
    recordAnimEdit(tx.commit('Move Puppet Pin p1'));

    // Gesture 2: at t=1, drag the pin to (60, 40).
    tx = beginAnimEdit();
    dragPinTo('m', 'p1', 1, 60, 40);
    recordAnimEdit(tx.commit('Move Puppet Pin p1'));

    // The keyframes must PERSIST after the commit transactions (not reverted).
    const persisted = defaultAnimation.getDataTrack('m', 'puppet.p1.position');
    expect(persisted?.keyframes.length).toBe(2);

    // And the rendered mesh must differ between the two times.
    const v0 = meshAt(0);
    const v1 = meshAt(1);
    expect(v0.length).toBe(v1.length);
    let differs = false;
    for (let i = 0; i < v0.length; i++) { if (v0[i] !== v1[i]) { differs = true; break; } }
    expect(differs).toBe(true);
  });
});
