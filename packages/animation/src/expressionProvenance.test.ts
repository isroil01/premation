/**
 * Who wrote this expression.
 *
 * `animation.setExpression` needs only `animation:write`, and what it writes
 * does not stay in the session that wrote it: the source is saved into the
 * document, survives uninstalling the plugin, and re-evaluates on the machine
 * of every collaborator who opens the project. Before this field there was no
 * way to tell a formula a user typed from one a plugin left behind — and so no
 * way to label it, warn about it, or revert it in bulk.
 *
 * The property that makes the field worth anything is the ROUND TRIP. A stamp
 * that exists in memory answers "who wrote this" for the session that already
 * knew, and for nobody who opens the file later — which is the only audience
 * that ever needs to ask.
 */

import { AnimationEngine } from './AnimationEngine';

const PLUGIN = 'studio.acme.easing-lab';

function engine(): AnimationEngine {
  return new AnimationEngine();
}

describe('expression provenance', () => {
  it('records the plugin that wrote an expression', () => {
    const a = engine();
    a.setExpression('n1', 'x' as never, 'value + 10', PLUGIN);
    expect(a.snapshot().expressions.n1!.x!.authoredBy).toBe(PLUGIN);
  });

  it('leaves a hand-written expression unattributed', () => {
    // Absent, not `'user'`. A sentinel would have to be kept in step with every
    // reader, and "nobody claimed this" is exactly what absence already means.
    const a = engine();
    a.setExpression('n1', 'x' as never, 'value + 10');
    expect(a.snapshot().expressions.n1!.x!.authoredBy).toBeUndefined();
  });

  it('survives a snapshot and restore', () => {
    // The whole point. This is the seam the saved document goes through.
    const a = engine();
    a.setExpression('n1', 'x' as never, 'value + 10', PLUGIN);
    const saved = JSON.parse(JSON.stringify(a.snapshot())) as ReturnType<AnimationEngine['snapshot']>;

    const b = engine();
    b.restore(saved);
    expect(b.snapshot().expressions.n1!.x!.authoredBy).toBe(PLUGIN);
  });

  it('restores a document written before the field existed', () => {
    // Every project saved by an earlier build. It must load, and it must read
    // as unattributed rather than as an error or a guess.
    const b = engine();
    b.restore({
      tracks: {},
      expressions: { n1: { x: { src: 'value + 10', enabled: true } } },
    } as never);
    const state = b.snapshot().expressions.n1!.x!;
    expect({ src: state.src, authoredBy: state.authoredBy })
      .toEqual({ src: 'value + 10', authoredBy: undefined });
  });

  it('transfers authorship when a person edits a plugin s expression', () => {
    // Editing by hand makes it yours. Carrying the plugin id forward would
    // mislabel the user's own work — and a bulk "revert everything this plugin
    // wrote" would then silently discard it.
    const a = engine();
    a.setExpression('n1', 'x' as never, 'value + 10', PLUGIN);
    a.setExpression('n1', 'x' as never, 'value + 20');
    expect(a.snapshot().expressions.n1!.x!.authoredBy).toBeUndefined();
  });

  it('finds every expression a given plugin wrote', () => {
    // The read that makes the field useful: an origin label, a "you do not have
    // this plugin" notice, and a bulk revert all need exactly this list.
    const a = engine();
    a.setExpression('n1', 'x' as never, 'value + 1', PLUGIN);
    a.setExpression('n2', 'y' as never, 'value + 2', PLUGIN);
    a.setExpression('n3', 'z' as never, 'value + 3', 'other.plugin');
    a.setExpression('n4', 'w' as never, 'value + 4');

    expect(a.expressionsAuthoredBy(PLUGIN)).toEqual([
      { nodeId: 'n1', prop: 'x' },
      { nodeId: 'n2', prop: 'y' },
    ]);
  });

  it('keeps authorship across an enable/disable round trip', () => {
    // `setExpressionEnabled` rewrites the entry. Losing the stamp there would
    // make provenance disappear the first time a user toggled the property.
    const a = engine();
    a.setExpression('n1', 'x' as never, 'value + 10', PLUGIN);
    a.setExpressionEnabled('n1', 'x' as never, false);
    expect(a.snapshot().expressions.n1!.x!.authoredBy).toBe(PLUGIN);
  });
});
