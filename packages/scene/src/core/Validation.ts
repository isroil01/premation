/**
 * Structural validation — prevents circular parenting, duplicate ids, invalid
 * hierarchy, and broken references. Thrown errors carry a stable `code`.
 */

import type { NodeId } from '../types';
import type { SceneNode } from '../nodes/SceneNode';
import { dfs } from '../systems/traversal';

export type ValidationCode =
  | 'CYCLE'
  | 'DUPLICATE_ID'
  | 'ALREADY_ATTACHED'
  | 'NOT_FOUND'
  | 'BROKEN_REFERENCE';

export class SceneValidationError extends Error {
  constructor(public readonly code: ValidationCode, message: string) {
    super(message);
    this.name = 'SceneValidationError';
  }
}

/** True when attaching `child` under `parent` would create a cycle. */
export function wouldCreateCycle(parent: SceneNode, child: SceneNode): boolean {
  return parent === child || child.isAncestorOf(parent);
}

/** Collect the ids in a subtree; throws on any duplicate within the subtree. */
export function collectSubtreeIds(root: SceneNode): Set<NodeId> {
  const ids = new Set<NodeId>();
  for (const node of dfs(root)) {
    if (ids.has(node.id)) {
      throw new SceneValidationError('DUPLICATE_ID', `Duplicate node id "${node.id}" within subtree`);
    }
    ids.add(node.id);
  }
  return ids;
}

/**
 * Full graph audit — verifies parent/child back-references are consistent, no
 * id appears twice, and every child's parent link is correct. Returns the list
 * of problems (empty = healthy).
 */
export function auditGraph(root: SceneNode): string[] {
  const problems: string[] = [];
  const seen = new Set<NodeId>();
  for (const node of dfs(root)) {
    if (seen.has(node.id)) problems.push(`Duplicate id "${node.id}"`);
    seen.add(node.id);
    for (const child of node.children) {
      if (child.parent !== node) {
        problems.push(`Broken parent link: "${child.id}" is a child of "${node.id}" but its parent points elsewhere`);
      }
    }
  }
  return problems;
}
