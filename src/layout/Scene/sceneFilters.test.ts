import type { TreeNode } from '@components/TreeView';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import {
  EMPTY_SCENE_FILTER,
  countSceneMatches,
  filterSceneTree,
  isSceneFilterActive,
  nodeMatches,
  toggleKind,
  withRevealed,
  type SceneFilter,
  type SceneNodeFacts,
} from './sceneFilters';

const FACTS: Record<string, SceneNodeFacts> = {
  comp: { kind: 'comp', label: undefined, animated: false, hasEffects: false, name: 'Main' },
  // The four searchable fields, so a query can be pointed at each in turn.
  titles: { kind: 'group', label: 'coral', animated: false, hasEffects: false, name: 'Titles' },
  t1: { kind: 'text', label: undefined, animated: true, hasEffects: false, name: 'Headline', expressions: 'wiggle(2, 30)' },
  t2: { kind: 'text', label: 'coral', animated: false, hasEffects: true, name: 'Sub', effectNames: 'gaussian blur', shy: true },
  cam: { kind: 'camera', label: undefined, animated: true, hasEffects: false, name: 'Camera 1' },
  bg: { kind: 'image', label: 'teal', animated: false, hasEffects: true, name: 'Backdrop', source: 'skyline.png', effectNames: 'levels' },
};

const n = (id: string, children?: TreeNode<unknown>[]): TreeNode<unknown> => ({ id, label: FACTS[id]!.name, children });
const TREE: TreeNode<unknown>[] = [n('comp', [n('titles', [n('t1'), n('t2')]), n('cam'), n('bg')])];
const factsOf = (id: string): SceneNodeFacts | null => FACTS[id] ?? null;
const ids = (nodes: TreeNode<unknown>[]): string[] =>
  nodes.flatMap((x) => [x.id, ...(x.children ? ids(x.children as TreeNode<unknown>[]) : [])]);

describe('sceneFilters', () => {
  it('an empty filter is a no-op and reports inactive', () => {
    expect(isSceneFilterActive(EMPTY_SCENE_FILTER)).toBe(false);
    expect(ids(filterSceneTree(TREE, EMPTY_SCENE_FILTER, factsOf))).toEqual(ids(TREE));
  });

  it('filters by kind, keeping ancestors of matches', () => {
    const f: SceneFilter = { ...EMPTY_SCENE_FILTER, kinds: new Set<SceneKind>(['camera']) };
    expect(ids(filterSceneTree(TREE, f, factsOf))).toEqual(['comp', 'cam']);
  });

  it('filters by label colour and by "no label"', () => {
    const coral: SceneFilter = { ...EMPTY_SCENE_FILTER, label: 'coral' };
    // The group matches on its own, so it keeps ALL its children.
    expect(ids(filterSceneTree(TREE, coral, factsOf))).toEqual(['comp', 'titles', 't1', 't2']);
    const none: SceneFilter = { ...EMPTY_SCENE_FILTER, label: 'none', kinds: new Set<SceneKind>(['text', 'image']) };
    expect(ids(filterSceneTree(TREE, none, factsOf))).toEqual(['comp', 'titles', 't1']);
  });

  it('filters animated and effect-carrying layers, and composes with search', () => {
    const anim: SceneFilter = { ...EMPTY_SCENE_FILTER, animatedOnly: true };
    expect(ids(filterSceneTree(TREE, anim, factsOf))).toEqual(['comp', 'titles', 't1', 'cam']);
    const fx: SceneFilter = { ...EMPTY_SCENE_FILTER, effectsOnly: true, query: 'back' };
    expect(ids(filterSceneTree(TREE, fx, factsOf))).toEqual(['comp', 'bg']);
    expect(nodeMatches(FACTS.t2!, { ...EMPTY_SCENE_FILTER, effectsOnly: true, animatedOnly: true })).toBe(false);
  });

  it('drops a branch with no match anywhere in it', () => {
    const f: SceneFilter = { ...EMPTY_SCENE_FILTER, query: 'zzz' };
    expect(filterSceneTree(TREE, f, factsOf)).toEqual([]);
  });

  it('counts the rows that match on their own facts, not the rows on screen', () => {
    // 'cam' is the one camera; the comp root is kept only as its path.
    const cam: SceneFilter = { ...EMPTY_SCENE_FILTER, kinds: new Set<SceneKind>(['camera']) };
    const camTree = filterSceneTree(TREE, cam, factsOf);
    expect(ids(camTree)).toHaveLength(2);
    expect(countSceneMatches(camTree, cam, factsOf)).toBe(1);
    // The coral group matches and drags both children along; only the group
    // and the coral child are matches.
    const coral: SceneFilter = { ...EMPTY_SCENE_FILTER, label: 'coral' };
    const coralTree = filterSceneTree(TREE, coral, factsOf);
    expect(ids(coralTree)).toHaveLength(4);
    expect(countSceneMatches(coralTree, coral, factsOf)).toBe(2);
    expect(countSceneMatches([], coral, factsOf)).toBe(0);
  });


  describe('search fields', () => {
    const q = (query: string, fields: SceneFilter['fields']): SceneFilter =>
      ({ ...EMPTY_SCENE_FILTER, query, fields });

    it('searches the name alone by default, as it always did', () => {
      expect(ids(filterSceneTree(TREE, q('blur', undefined), factsOf))).toEqual([]);
      expect(ids(filterSceneTree(TREE, q('head', ['name']), factsOf))).toEqual(['comp', 'titles', 't1']);
    });

    it('finds a layer by an EFFECT on it', () => {
      // "Where is that blur" is one question whether the word names the layer
      // or the effect applied to it.
      expect(ids(filterSceneTree(TREE, q('blur', ['effects']), factsOf))).toEqual(['comp', 'titles', 't2']);
    });

    it('finds a layer by its EXPRESSION text', () => {
      expect(ids(filterSceneTree(TREE, q('wiggle', ['expressions']), factsOf))).toEqual(['comp', 'titles', 't1']);
    });

    it('finds a layer by its SOURCE file', () => {
      expect(ids(filterSceneTree(TREE, q('skyline', ['source']), factsOf))).toEqual(['comp', 'bg']);
    });

    it('is the UNION of the chosen fields, not the intersection', () => {
      const hit = filterSceneTree(TREE, q('levels', ['name', 'effects']), factsOf);
      expect(ids(hit)).toEqual(['comp', 'bg']);
    });

    it('treats an empty field list as "name", so the box is never inert', () => {
      expect(ids(filterSceneTree(TREE, q('head', []), factsOf))).toEqual(['comp', 'titles', 't1']);
    });
  });

  describe('hide shy', () => {
    const shyOff: SceneFilter = { ...EMPTY_SCENE_FILTER, hideShy: true };

    it('removes shy rows even with no other filter set', () => {
      // `isSceneFilterActive` is false here — shy is a property of the layers,
      // not a question the user is asking — so the walk has to run anyway.
      expect(isSceneFilterActive(shyOff)).toBe(false);
      expect(ids(filterSceneTree(TREE, shyOff, factsOf))).not.toContain('t2');
      expect(ids(filterSceneTree(TREE, shyOff, factsOf))).toContain('t1');
    });

    it('still removes a shy layer inside a branch that matches on its own', () => {
      // The "a matching branch keeps ALL its children" shortcut is right for a
      // search and wrong for an exclusion: it handed the coral group its
      // untouched child list and put the shy layer straight back.
      const coralNoShy: SceneFilter = { ...EMPTY_SCENE_FILTER, label: 'coral', hideShy: true };
      const out = ids(filterSceneTree(TREE, coralNoShy, factsOf));
      expect(out).toContain('titles');
      expect(out).not.toContain('t2');
    });
  });

  it('withRevealed adds only the missing ids and keeps identity when none are', () => {
    const expanded = ['comp', 'titles'];
    expect(withRevealed(expanded, ['titles', 'comp'])).toBe(expanded);
    expect(withRevealed(expanded, [])).toBe(expanded);
    expect(withRevealed(expanded, ['cam', 'titles'])).toEqual(['comp', 'titles', 'cam']);
  });

  it('toggleKind adds, removes and collapses to "any"', () => {
    const one = toggleKind(null, 'text');
    expect([...one!]).toEqual(['text']);
    const two = toggleKind(one, 'camera');
    expect(two!.size).toBe(2);
    expect(toggleKind(toggleKind(two, 'text'), 'camera')).toBeNull();
  });
});
