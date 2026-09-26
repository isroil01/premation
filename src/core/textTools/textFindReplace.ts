/**
 * Find and Replace Text across layers — scope and counting.
 *
 * The string/run rules live in `findReplaceText.ts`; this module decides WHICH
 * text is searched. Replace All is engine commands (layout/Text/textEdits.ts).
 *
 * What is searched, per text layer:
 *   • its static content (the Text component's `content`), with its rich-text
 *     runs shifted so styling stays on the right characters;
 *   • every Source Text keyframe value — a keyframed layer shows those strings,
 *     not `content`, so a replace that skipped them would appear to do nothing.
 */

import { defaultAnimation, SOURCE_TEXT_PROP } from '@motion/animation';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind, flattenComposition } from '@core/scene/sceneDerive';
import { activeCompRootId } from '@core/scene/activeComp';
import { useSelectionStore } from '@stores/selectionStore';
import type { SceneNode } from '@core/types';
import { findMatches, type FindOptions } from './findReplaceText';

/** AE-style scopes: the selection, the active comp, or every comp in the project. */
export type FindScope = 'selected' | 'comp' | 'all';

export interface ScopeCount {
  /** Total matches, keyframe values included. */
  matches: number;
  /** Text layers with at least one match. */
  layers: number;
}

const isText = (n: SceneNode | undefined | null): n is SceneNode => !!n && readNodeKind(n) === 'text';

/** The text layers a scope covers, in stacking order. */
export function textLayersInScope(scope: FindScope): SceneNode[] {
  if (scope === 'selected') {
    return useSelectionStore.getState().ids
      .map((id) => defaultSceneGraph.getNode(id))
      .filter(isText);
  }
  if (scope === 'comp') {
    return flattenComposition(defaultSceneGraph, activeCompRootId()).filter(isText);
  }
  const out: SceneNode[] = [];
  defaultSceneGraph.traverse((n) => { if (isText(n)) out.push(n); });
  return out;
}

function contentOf(node: SceneNode): { compId: string; content: string } | null {
  const comp = node.components.find((c) => c.type === 'Text');
  const content = (comp?.props as Record<string, unknown> | undefined)?.content;
  return comp && typeof content === 'string' ? { compId: comp.id, content } : null;
}

/** Matches in one layer: content + Source Text keyframe values. */
export function countInLayer(node: SceneNode, find: string, opts: FindOptions): number {
  let n = 0;
  const c = contentOf(node);
  if (c) n += findMatches(c.content, find, opts).length;
  for (const kf of defaultAnimation.getDataTrack(node.id, SOURCE_TEXT_PROP)?.keyframes ?? []) {
    if (typeof kf.value === 'string') n += findMatches(kf.value, find, opts).length;
  }
  return n;
}

export function countInScope(scope: FindScope, find: string, opts: FindOptions): ScopeCount {
  let matches = 0;
  let layers = 0;
  if (!find) return { matches, layers };
  for (const node of textLayersInScope(scope)) {
    const n = countInLayer(node, find, opts);
    matches += n;
    if (n > 0) layers += 1;
  }
  return { matches, layers };
}
