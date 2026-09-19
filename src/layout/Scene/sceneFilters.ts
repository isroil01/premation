/**
 * sceneFilters — the pure rules behind the Layers panel's filter row.
 *
 * A layer tree with forty rows and one filter (the name search) is a tree
 * you scroll. These narrow it by KIND (show me the cameras), by LABEL colour
 * (the shots I tagged red), by whether a layer is ANIMATED and whether it
 * carries EFFECTS — the four questions a compositor actually asks of a
 * stack — and they compose with the search.
 *
 * Ancestors of a match are kept, the way `filterTree` already keeps them for
 * the search: a match inside a closed group has to be reachable, and the
 * only way to reach it is through its parents. The facts about a node are
 * injected (`SceneNodeFacts`) so this file needs no scene graph and no
 * animation engine, and the panel can hand it the live ones.
 */

import type { TreeNode } from '@components/TreeView';
import type { SceneKind } from '@core/scene/seedDefaultScene';
import type { SearchField } from '@stores/sceneViewStore';

export interface SceneFilter {
  /** Kinds to show; null = every kind. */
  kinds: ReadonlySet<SceneKind> | null;
  /** A label colour to match; `'none'` = unlabelled only; null = any. */
  label: string | 'none' | null;
  animatedOnly: boolean;
  effectsOnly: boolean;
  /** Lower-cased, trimmed search. */
  query: string;
  /**
   * Which fields `query` is matched against. A layer is a match when ANY
   * selected field contains it — the union, not the intersection, because
   * "glow" is one question whether it names the layer or the effect on it.
   * Omitted (or empty) means name only, which is what this filter did before
   * the other three fields existed.
   */
  fields?: ReadonlyArray<SearchField>;
  /**
   * Hide layers marked shy. Not part of `isSceneFilterActive`'s "you are
   * filtering" answer on purpose: shy is a property of the LAYERS, armed one at
   * a time and left armed, so counting it as an active filter would leave the
   * clear-filters button lit permanently in any project that uses shy at all.
   * It still removes rows, so it is applied here.
   */
  hideShy?: boolean;
}

export interface SceneNodeFacts {
  kind: SceneKind;
  label: string | undefined;
  animated: boolean;
  hasEffects: boolean;
  name: string;
  /** Applied effect names, lower-cased — the `effects` search field. */
  effectNames?: string;
  /** Every expression on the layer, concatenated and lower-cased. */
  expressions?: string;
  /** Source filename / comp name behind the layer, lower-cased. */
  source?: string;
  shy?: boolean;
}

export const EMPTY_SCENE_FILTER: SceneFilter = {
  kinds: null,
  label: null,
  animatedOnly: false,
  effectsOnly: false,
  query: '',
};

export function isSceneFilterActive(f: SceneFilter): boolean {
  return f.kinds !== null || f.label !== null || f.animatedOnly || f.effectsOnly || f.query.length > 0;
}

/** Does the query hit any of the fields the filter is searching? */
function queryMatches(facts: SceneNodeFacts, f: SceneFilter): boolean {
  const fields = f.fields && f.fields.length > 0 ? f.fields : (['name'] as const);
  for (const field of fields) {
    switch (field) {
      case 'name': if (facts.name.toLowerCase().includes(f.query)) return true; break;
      case 'effects': if (facts.effectNames?.includes(f.query)) return true; break;
      case 'expressions': if (facts.expressions?.includes(f.query)) return true; break;
      case 'source': if (facts.source?.includes(f.query)) return true; break;
    }
  }
  return false;
}

/** Does one node, on its own facts, pass the filter? */
export function nodeMatches(facts: SceneNodeFacts, f: SceneFilter): boolean {
  if (f.hideShy && facts.shy) return false;
  if (f.kinds && !f.kinds.has(facts.kind)) return false;
  if (f.label === 'none' ? facts.label !== undefined : f.label !== null && facts.label !== f.label) return false;
  if (f.animatedOnly && !facts.animated) return false;
  if (f.effectsOnly && !facts.hasEffects) return false;
  if (f.query && !queryMatches(facts, f)) return false;
  return true;
}

/**
 * Filter a tree, keeping the ancestors of any match. A branch whose own
 * facts fail but which holds a match survives with only the matching
 * descendants; a branch that matches keeps ALL its children, because the
 * user asked for "the group called Titles", not for its parts.
 *
 * That last shortcut is right for a SEARCH and wrong for an EXCLUSION. "Hide
 * shy layers" is the second kind: a shy layer must not be on screen whoever its
 * parent is, and handing a matching group its untouched child list put every
 * shy layer inside it straight back. So the shortcut is taken only when nothing
 * in the filter excludes rows outright — the recursion then still prunes, and a
 * shy branch survives exactly as far as it is the path to something visible.
 */
export function filterSceneTree<T>(
  nodes: ReadonlyArray<TreeNode<T>>,
  f: SceneFilter,
  factsOf: (id: string) => SceneNodeFacts | null,
): TreeNode<T>[] {
  // `hideShy` is not an "active filter" for the footer's purposes (see the
  // field's note) but it does remove rows, so it has to reach the walk.
  if (!isSceneFilterActive(f) && !f.hideShy) return [...nodes];
  const excludes = f.hideShy === true;
  const out: TreeNode<T>[] = [];
  for (const node of nodes) {
    const facts = factsOf(node.id);
    const self = facts ? nodeMatches(facts, f) : false;
    const kids = node.children ? filterSceneTree(node.children, f, factsOf) : [];
    if (self || kids.length > 0) {
      out.push({ ...node, children: self && !excludes ? node.children : kids });
    }
  }
  return out;
}

/**
 * How many rows of a FILTERED tree pass the filter on their own facts.
 *
 * This is the number the footer reports as matching. It is not the row
 * count: `filterSceneTree` keeps an ancestor purely as the path to a match,
 * and a matching group drags all of its children along — both are on screen,
 * neither is a match, and counting them said "12 shown" for a search that
 * hit one layer inside one group.
 */
export function countSceneMatches<T>(
  nodes: ReadonlyArray<TreeNode<T>>,
  f: SceneFilter,
  factsOf: (id: string) => SceneNodeFacts | null,
): number {
  let n = 0;
  for (const node of nodes) {
    const facts = factsOf(node.id);
    if (facts && nodeMatches(facts, f)) n += 1;
    if (node.children) n += countSceneMatches(node.children, f, factsOf);
  }
  return n;
}

/**
 * The expansion set a CONTROLLED tree should show: everything the filter
 * expanded plus whatever the host asked to reveal.
 *
 * TreeView merges `revealIds` into its own state only while it owns that
 * state; with `expandedIds` supplied the host owns it, and a reveal that
 * arrives then (parenting a layer while a search is active) has to be merged
 * here or it is dropped. Returns `expanded` itself when there is nothing to
 * add, so the tree's memo on the array's identity is not defeated.
 */
export function withRevealed(
  expanded: ReadonlyArray<string>,
  reveal: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const have = new Set(expanded);
  const missing = reveal.filter((id) => !have.has(id));
  return missing.length === 0 ? expanded : [...expanded, ...missing];
}

/** Toggle a kind in the set; an empty set collapses back to "every kind". */
export function toggleKind(kinds: ReadonlySet<SceneKind> | null, kind: SceneKind): ReadonlySet<SceneKind> | null {
  const next = new Set(kinds ?? []);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next.size === 0 ? null : next;
}
