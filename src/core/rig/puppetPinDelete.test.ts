/**
 * Deleting a puppet pin must take its animation with it.
 *
 * The list of tracks to remove used to be written out inside `deletePuppetPin`,
 * and it had gone stale: `position`, `rotation` and `stiffness` were removed,
 * `scale` and `overlap` were not. Both outlived their pin, and because pin ids
 * are reused across sessions a later pin could inherit a dead one's animation.
 *
 * The guard therefore derives its subject set from PIN_SCALAR_TRACKS — the same
 * constant `resolveLivePins` reads to decide what to sample — instead of listing
 * properties again. Restating them here would reproduce the exact defect one
 * level up: a fourth spelling of the same list, going stale on the next addition
 * while reading as coverage (F25's shape).
 */

import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { defaultAnimation } from '@motion/animation';
import { setCommandSystem, CommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import { addPuppetPin, deletePuppetPin } from './puppetCommands';
import { PIN_SCALAR_TRACKS, pinPropPath } from './livePins';
import type { SceneNode } from '@core/types';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';

function shapeNode(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{
      id: `${id}_t`, type: 'Transform',
      props: { [SCENE_KIND_PROP]: 'shape', x: 0, y: 0, rotation: 0, width: 200, height: 160 },
    }],
  } as unknown as SceneNode;
}

const PIN = 'pin_x';

/** Animate every track the pin model exposes. */
function animateEveryTrack(nodeId: string): void {
  defaultAnimation.setDataTrack(nodeId, pinPropPath(PIN, 'position'), {
    nodeId, prop: pinPropPath(PIN, 'position'), kind: 'points',
    keyframes: [{ t: 0, value: [{ x: 1, y: 2 }] }],
  } as never);
  for (const prop of PIN_SCALAR_TRACKS) {
    defaultAnimation.setKeyframe(nodeId, pinPropPath(PIN, prop), 0, 1);
    defaultAnimation.setKeyframe(nodeId, pinPropPath(PIN, prop), 1, 2);
  }
}

beforeEach(() => {
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) }));
  try { defaultSceneGraph.removeNode('n1'); } catch { /* fresh */ }
  defaultSceneGraph.addNode(shapeNode('n1'));
  defaultAnimation.clear?.();
});

describe('deletePuppetPin removes the pin\'s animation', () => {
  it('the fixture actually animates every track — otherwise it proves nothing', () => {
    // Without this the suite would pass on a build that deleted nothing, because
    // nothing had been created to delete.
    addPuppetPin('n1', { id: PIN, name: 'X', x: 0, y: 0 });
    animateEveryTrack('n1');
    expect(PIN_SCALAR_TRACKS.length).toBeGreaterThan(0);
    for (const prop of PIN_SCALAR_TRACKS) {
      expect(defaultAnimation.isAnimated('n1', pinPropPath(PIN, prop))).toBe(true);
    }
    expect(defaultAnimation.getDataTrack('n1', pinPropPath(PIN, 'position'))).toBeTruthy();
  });

  it('leaves NO track behind, for every property the pin model exposes', () => {
    addPuppetPin('n1', { id: PIN, name: 'X', x: 0, y: 0 });
    animateEveryTrack('n1');
    deletePuppetPin('n1', PIN);

    for (const prop of PIN_SCALAR_TRACKS) {
      expect({ prop, animated: defaultAnimation.isAnimated('n1', pinPropPath(PIN, prop)) })
        .toEqual({ prop, animated: false });
    }
    expect(defaultAnimation.getDataTrack('n1', pinPropPath(PIN, 'position'))).toBeNull();
  });

  it('leaves no puppet prop-path for this pin anywhere in the engine', () => {
    // Derived from the ENGINE's own view rather than from any list — this is the
    // assertion that still holds if a future pin property is added and forgotten
    // in both PIN_SCALAR_TRACKS and the delete path.
    addPuppetPin('n1', { id: PIN, name: 'X', x: 0, y: 0 });
    animateEveryTrack('n1');
    deletePuppetPin('n1', PIN);

    const prefix = `puppet.${PIN}.`;
    const left = [
      ...defaultAnimation.getAnimatedPropPaths('n1'),
      ...defaultAnimation.getDataAnimatedPropPaths('n1'),
    ].filter((p) => p.startsWith(prefix));
    expect(left).toEqual([]);
  });

  it('does not touch a SIBLING pin\'s tracks', () => {
    addPuppetPin('n1', { id: PIN, name: 'X', x: 0, y: 0 });
    addPuppetPin('n1', { id: 'keep', name: 'K', x: 20, y: 0 });
    animateEveryTrack('n1');
    for (const prop of PIN_SCALAR_TRACKS) {
      defaultAnimation.setKeyframe('n1', pinPropPath('keep', prop), 0, 5);
    }
    deletePuppetPin('n1', PIN);
    for (const prop of PIN_SCALAR_TRACKS) {
      expect({ prop, animated: defaultAnimation.isAnimated('n1', pinPropPath('keep', prop)) })
        .toEqual({ prop, animated: true });
    }
  });

  it('undo restores the removed keyframes', () => {
    addPuppetPin('n1', { id: PIN, name: 'X', x: 0, y: 0 });
    animateEveryTrack('n1');
    deletePuppetPin('n1', PIN);
    getCommandSystem().getHistory().undo();
    for (const prop of PIN_SCALAR_TRACKS) {
      expect({ prop, animated: defaultAnimation.isAnimated('n1', pinPropPath(PIN, prop)) })
        .toEqual({ prop, animated: true });
    }
    expect(defaultAnimation.getDataTrack('n1', pinPropPath(PIN, 'position'))).toBeTruthy();
  });
});

