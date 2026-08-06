/**
 * Renaming a layer, and the expressions that named it.
 *
 * Driven against the REAL `AnimationEngine` and the REAL scene graph rather
 * than stubs, because every interesting case here lives in the interaction
 * between name resolution and expression text. A stub resolver would agree with
 * whatever this file assumed, and the bug worth catching — a rewrite that
 * retargets a reference to a layer the author never meant — is invisible to any
 * test that does not resolve names the way the engine does.
 */

import defaultSceneGraph from './DefaultSceneGraph';
import { renameLayer } from './renameLayer';
import { defaultAnimation, resolveLayerRef } from '@motion/animation';
import { CommandSystem, setCommandSystem, getCommandSystem } from '@core/commands/CommandSystem';
import type { SceneNode } from '@core/types';

/** The app's own name lookup, as `Providers.tsx` wires it: FIRST match wins. */
const byName = (name: string): string | null => {
  let found: string | null = null;
  defaultSceneGraph.traverse((n) => {
    if (found === null && n.name === name) found = n.id;
  });
  return found;
};

beforeAll(() => {
  // `runDocumentEdit` needs a command system, and the engine's `layer()` needs
  // a resolver — without one every reference silently returns 0, which would
  // make this whole suite pass for a broken implementation.
  setCommandSystem(new CommandSystem({ services: {} as never, getState: () => ({}) } as never));
  defaultAnimation.setLayerResolver(byName);
});

beforeEach(() => {
  defaultSceneGraph.clear();
  // `defaultSceneGraph.clear()` does NOT clear the engine — it is a separate
  // module singleton, and expressions leak between tests without this.
  for (const e of defaultAnimation.allExpressions()) {
    defaultAnimation.removeExpression(e.nodeId, e.prop);
  }
});

let seq = 0;

/** A bare named node. Returns its id. */
function layer(name: string): string {
  const id = `n_${++seq}`;
  const node: SceneNode = {
    id,
    name,
    children: [],
    parent: null,
    transform: { position: { x: 0, y: 0 }, rotation: 0, scale: { x: 1, y: 1 } },
    components: [],
  };
  defaultSceneGraph.addNode(node);
  return id;
}

const srcOf = (nodeId: string, prop: string) => defaultAnimation.getExpressionSrc(nodeId, prop);

describe('following the rename', () => {
  it('rewrites a reference to the new name, not to an id', () => {
    /*
      The whole point. `#n_a1b2c3` would also work and would also survive the
      next rename — and would make the author's own expression unreadable to
      them, to fix a problem they have not hit. The name is what they typed.
    */
    const hero = layer('Hero');
    const follower = layer('Follower');
    defaultAnimation.setExpression(follower, 'opacity', "layer('Hero', 'opacity') * 2");

    const result = renameLayer(hero, 'Hero Glow');

    expect(srcOf(follower, 'opacity')).toBe("layer('Hero Glow', 'opacity') * 2");
    expect(result.repaired).toEqual([{ nodeId: follower, prop: 'opacity' }]);
  });

  it('keeps the reference RESOLVING after the rename', () => {
    // The assertion that survives a refactor of the rewriting itself: whatever
    // the text ends up being, it has to point at the same layer.
    const hero = layer('Hero');
    const follower = layer('Follower');
    defaultAnimation.setExpression(follower, 'opacity', "layer('Hero', 'opacity')");

    renameLayer(hero, 'Hero Glow');

    const ref = /layer\('([^']*)'/.exec(srcOf(follower, 'opacity') ?? '')?.[1] ?? '';
    expect(resolveLayerRef(ref, byName)).toBe(hero);
  });

  it('rewrites layerAt as well as layer', () => {
    const hero = layer('Hero');
    const follower = layer('Follower');
    defaultAnimation.setExpression(follower, 'x', "layerAt('Hero', 'x', time - 0.1)");

    renameLayer(hero, 'Hero Glow');

    expect(srcOf(follower, 'x')).toBe("layerAt('Hero Glow', 'x', time - 0.1)");
  });

  it('repairs a layer s reference to its own old name', () => {
    const self = layer('Hero');
    defaultAnimation.setExpression(self, 'y', "layer('Hero', 'x')");

    renameLayer(self, 'Hero Glow');

    expect(srcOf(self, 'y')).toBe("layer('Hero Glow', 'x')");
  });

  it('preserves provenance and the disabled state', () => {
    /*
      Both would be silently destroyed by a rewrite that went through
      `setExpression`. Losing `enabled` re-enables an expression the user turned
      off; losing `authoredBy` strips the only handle on a plugin's leftovers
      after the plugin is uninstalled.
    */
    const hero = layer('Hero');
    const follower = layer('Follower');
    defaultAnimation.setExpression(follower, 'opacity', "layer('Hero', 'opacity')", 'studio.acme.depth');
    defaultAnimation.setExpressionEnabled(follower, 'opacity', false);

    const result = renameLayer(hero, 'Hero Glow');

    expect(defaultAnimation.isExpressionEnabled(follower, 'opacity')).toBe(false);
    expect(result.repaired[0]?.authoredBy).toBe('studio.acme.depth');
    expect(
      defaultAnimation.expressionsAuthoredBy('studio.acme.depth'),
    ).toContainEqual({ nodeId: follower, prop: 'opacity' });
  });
});

describe('what it refuses to guess', () => {
  it('does NOT retarget a reference that pointed at a different same-named layer', () => {
    /*
      ★ The case a text-match rewrite gets wrong, silently and permanently.

      Two layers named Panel. `layer('Panel')` resolves to the FIRST. Rename the
      SECOND, and a rewrite keyed on matching text would repoint every reference
      at the layer that was just renamed — which is not the one they were
      reading. Keyed on resolution, nothing is touched, which is correct.
    */
    const first = layer('Panel');
    const second = layer('Panel');
    const reader = layer('Reader');
    defaultAnimation.setExpression(reader, 'opacity', "layer('Panel', 'opacity')");

    const result = renameLayer(second, 'Sidebar');

    expect(srcOf(reader, 'opacity')).toBe("layer('Panel', 'opacity')");
    expect(result.repaired).toEqual([]);
    expect(byName('Panel')).toBe(first);
  });

  it('repairs, and does not warn, when renaming AWAY from a duplicated name', () => {
    /*
      The mirror of the case above, and deliberately NOT a warning. Rename the
      FIRST Panel and its own references are repaired to follow it; the second
      Panel takes over the old name, but no reference moved — the repaired ones
      point where they always did. A warning here would be one nobody reads.
    */
    const first = layer('Panel');
    const second = layer('Panel');
    const reader = layer('Reader');
    defaultAnimation.setExpression(reader, 'opacity', "layer('Panel', 'opacity')");

    const result = renameLayer(first, 'Sidebar');

    expect(result.repaired).toEqual([{ nodeId: reader, prop: 'opacity' }]);
    expect(srcOf(reader, 'opacity')).toBe("layer('Sidebar', 'opacity')");
    expect(result.captured).toEqual([]);
    expect(byName('Panel')).toBe(second);
  });

  it('★ names the expressions a rename STEALS from another layer', () => {
    /*
      The one genuinely silent retarget, and the reason `captured` is a list.

      `Reader` reads `layer('Panel')`, which resolves to the layer actually
      called Panel. Rename an EARLIER layer to `Panel` and it wins the name in
      traversal order — so `Reader` starts reading a completely different layer
      with no text change, no error, and nothing on screen to explain it.
    */
    const impostor = layer('Backdrop');   // earlier in traversal order
    const panel = layer('Panel');
    const reader = layer('Reader');
    defaultAnimation.setExpression(reader, 'opacity', "layer('Panel', 'opacity')");
    expect(byName('Panel')).toBe(panel);

    const result = renameLayer(impostor, 'Panel');

    expect(byName('Panel')).toBe(impostor);
    expect(result.captured).toEqual([{ nodeId: reader, prop: 'opacity' }]);
    // Reported, never rewritten — which layer the author meant is not ours to guess.
    expect(srcOf(reader, 'opacity')).toBe("layer('Panel', 'opacity')");
  });

  it('does not claim capture when resolution did not actually move', () => {
    /*
      Renaming a LATER layer to a name an earlier one already holds changes
      nothing about resolution: the earlier layer still wins. It is worth one
      quiet sentence that the name is taken, and it is not a retarget.
    */
    const panel = layer('Panel');
    const other = layer('Backdrop');
    const reader = layer('Reader');
    defaultAnimation.setExpression(reader, 'opacity', "layer('Panel', 'opacity')");

    const result = renameLayer(other, 'Panel');

    expect(byName('Panel')).toBe(panel);
    expect(result.captured).toEqual([]);
    expect(result.nameAlreadyInUse).toBe(true);
  });

  it('notes a taken name even when no expression references it', () => {
    const hero = layer('Hero');
    layer('Sidebar');

    const result = renameLayer(hero, 'Sidebar');
    expect(result.nameAlreadyInUse).toBe(true);
    expect(result.captured).toEqual([]);
  });

  it('leaves id references alone', () => {
    // They are immune by construction — that is what they are for. Touching
    // them would be the one way to break the mechanism that fixed this.
    const hero = layer('Hero');
    const follower = layer('Follower');
    defaultAnimation.setExpression(follower, 'opacity', `layer('#${hero}', 'opacity')`);

    renameLayer(hero, 'Hero Glow');

    expect(srcOf(follower, 'opacity')).toBe(`layer('#${hero}', 'opacity')`);
  });

  it('leaves a non-literal reference alone', () => {
    // `layer(someVar)` cannot be resolved without running the expression, and a
    // rename that guessed would corrupt the one case it cannot check.
    const hero = layer('Hero');
    const follower = layer('Follower');
    const src = "const n = 'Hero'; layer(n, 'opacity')";
    defaultAnimation.setExpression(follower, 'opacity', src);

    renameLayer(hero, 'Hero Glow');

    expect(srcOf(follower, 'opacity')).toBe(src);
  });
});

describe('the edit itself', () => {
  it('is refused for an empty name', () => {
    const hero = layer('Hero');
    expect(renameLayer(hero, '   ').ok).toBe(false);
    expect(defaultSceneGraph.getNode(hero)?.name).toBe('Hero');
  });

  it('is a no-op when the name did not change', () => {
    const hero = layer('Hero');
    const follower = layer('Follower');
    defaultAnimation.setExpression(follower, 'opacity', "layer('Hero', 'opacity')");

    expect(renameLayer(hero, 'Hero').repaired).toEqual([]);
    expect(srcOf(follower, 'opacity')).toBe("layer('Hero', 'opacity')");
  });

  it('undoes the rename and its repairs together', () => {
    /*
      They have to be one entry. A rename that undid while its repairs stayed
      behind would leave every reference naming a layer that no longer exists —
      strictly worse than never having repaired them.
    */
    const hero = layer('Hero');
    const follower = layer('Follower');
    defaultAnimation.setExpression(follower, 'opacity', "layer('Hero', 'opacity')");

    renameLayer(hero, 'Hero Glow');
    expect(srcOf(follower, 'opacity')).toBe("layer('Hero Glow', 'opacity')");

    getCommandSystem().getHistory().undo();

    expect(defaultSceneGraph.getNode(hero)?.name).toBe('Hero');
    expect(srcOf(follower, 'opacity')).toBe("layer('Hero', 'opacity')");
  });
});
