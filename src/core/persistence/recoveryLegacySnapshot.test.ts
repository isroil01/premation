/**
 * The seam between a legacy recovery snapshot and the animation engine.
 *
 * ── RULE 4c, ASKED PROSPECTIVELY ────────────────────────────────────────────
 *
 * Document 1.6.0 changes the SHAPE of `animation.expressions`, and
 * `AnimationEngine.restore` deliberately reads one shape only — so anything
 * carrying the old shape past the migration loses its expressions silently.
 * The question the rule asks is: for that value, which guard observes the
 * crossing?
 *
 * The migration test watches migrate → restore. The engine test watches the
 * engine. Neither of them names `restoreRecovery`, which had a branch calling
 * `defaultAnimation.restore(snap.anim)` DIRECTLY — the one path from persisted
 * state into the engine with no migration in between, on the code whose entire
 * purpose is not losing work after a crash. The branch was correct while every
 * schema change was additive, and it had no test because until 1.6.0 there was
 * nothing for one to catch.
 *
 * It now assembles a document at the implied legacy version and goes through
 * `restoreDocument` like every other foreign state — §2·0's "guarantee one
 * reader". These tests hold that.
 */

import { restoreRecovery, type RecoverySnapshot } from './recovery';
import { defaultAnimation } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { SCENE_KIND_PROP } from '@core/scene/seedDefaultScene';
import type { ProjectFile, SceneNode } from '@core/types';

function node(id: string): SceneNode {
  return {
    id, name: id, parent: null, children: [], visible: true, locked: false,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [{ id: `${id}_meta`, type: 'group', props: { [SCENE_KIND_PROP]: 'group' } }],
  } as unknown as SceneNode;
}

function scene(): ProjectFile {
  return { nodes: [node('layer_a')] } as unknown as ProjectFile;
}

/**
 * A snapshot written by a build older than 1.1: no `doc`, so no version field
 * anywhere, and `anim` in the pre-1.6.0 expression shape — a bare source
 * string. x is keyframed 0 → 100 over 0..2s, so x@1 = 50 without the
 * expression and 250 with it.
 */
function legacySnapshot(): RecoverySnapshot {
  return {
    projectId: 'proj_1',
    savedAt: 1,
    time: 0,
    scene: scene(),
    anim: {
      tracks: {
        layer_a: {
          x: { nodeId: 'layer_a', prop: 'x', keyframes: [{ t: 0, value: 0 }, { t: 2, value: 100 }] },
        },
      },
      expressions: { layer_a: { x: 'value + 200' } },
    } as unknown as RecoverySnapshot['anim'],
  };
}

beforeEach(() => {
  const ids: string[] = [];
  defaultSceneGraph.traverse((n) => ids.push(n.id));
  for (const id of ids) defaultSceneGraph.removeNode(id);
  defaultAnimation.clear();
});

describe('a pre-1.1 recovery snapshot', () => {
  test('its expressions survive the restore, migrated on the way in', () => {
    restoreRecovery(legacySnapshot());

    expect(defaultAnimation.hasExpression('layer_a', 'x')).toBe(true);
    expect(defaultAnimation.getExpressionSrc('layer_a', 'x')).toBe('value + 200');
    expect(defaultAnimation.isExpressionEnabled('layer_a', 'x')).toBe(true);
    // Named number, not "an expression exists": 50 keyframed + 200.
    expect(defaultAnimation.sample('layer_a', 'x', 1)).toBeCloseTo(250);
  });

  test('its keyframes survive too — the migration is not eating the tracks', () => {
    const snap = legacySnapshot();
    (snap.anim as unknown as { expressions: unknown }).expressions = {};
    restoreRecovery(snap);
    expect(defaultAnimation.sample('layer_a', 'x', 1)).toBeCloseTo(50);
  });

  /**
   * A snapshot from before expressions existed has no `expressions` key at all
   * — an absent optional field. `restore` used to throw on
   * `Object.keys(undefined)`, which nothing noticed while this branch bypassed
   * it. The clean fixture always has the key, so only this one reaches it.
   */
  test('a snapshot with NO expressions key at all restores rather than throwing', () => {
    const snap = legacySnapshot();
    delete (snap.anim as unknown as { expressions?: unknown }).expressions;
    expect(() => restoreRecovery(snap)).not.toThrow();
    expect(defaultAnimation.sample('layer_a', 'x', 1)).toBeCloseTo(50);
  });

  test('the time is returned unchanged', () => {
    expect(restoreRecovery({ ...legacySnapshot(), time: 1.75 })).toBeCloseTo(1.75);
  });
});

describe('a modern snapshot still takes the document path', () => {
  test('a snapshot carrying `doc` restores its expression state including DISABLED', () => {
    restoreRecovery({
      projectId: 'proj_1',
      savedAt: 1,
      time: 0,
      scene: scene(),
      anim: { tracks: {}, expressions: {} },
      doc: {
        version: '1.6.0',
        scene: scene(),
        animation: {
          tracks: {
            layer_a: {
              x: { nodeId: 'layer_a', prop: 'x', keyframes: [{ t: 0, value: 0 }, { t: 2, value: 100 }] },
            },
          },
          expressions: { layer_a: { x: { src: 'value + 200', enabled: false } } },
        },
      },
    } as unknown as RecoverySnapshot);

    expect(defaultAnimation.hasExpression('layer_a', 'x')).toBe(true);
    expect(defaultAnimation.isExpressionEnabled('layer_a', 'x')).toBe(false);
  });
});
