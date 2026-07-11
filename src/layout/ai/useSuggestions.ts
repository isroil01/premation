/**
 * Live contextual suggestions for the current selection.
 *
 * Shared by the auto suggestion card and the toolbar sparkle button so both
 * stay in sync and there is one source of truth for "what does AI suggest for
 * the selected object, minus what the user already dismissed".
 */

import { useSelectionStore } from '@stores/selectionStore';
import { useSceneRevision } from '@stores/sceneStore';
import { useAiSuggestionStore } from '@stores/aiSuggestionStore';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { suggestionsForKind, type AiSuggestion } from '@core/ai/suggestions';
import type { SceneKind } from '@core/scene/seedDefaultScene';

export interface ContextualSuggestions {
  nodeId: string | null;
  name: string | null;
  kind: SceneKind | null;
  suggestions: AiSuggestion[];
}

export function useContextualSuggestions(): ContextualSuggestions {
  const primary = useSelectionStore((s) => s.primary);
  // Recompute when the scene changes or a suggestion is dismissed.
  useSceneRevision((s) => s.rev);
  const dismissed = useAiSuggestionStore((s) => s.dismissed);

  if (!primary) return { nodeId: null, name: null, kind: null, suggestions: [] };
  const node = defaultSceneGraph.getNode(primary);
  if (!node) return { nodeId: null, name: null, kind: null, suggestions: [] };

  const kind = readNodeKind(node);
  const suggestions = suggestionsForKind(kind).filter(
    (s) => !dismissed[`${primary}:${s.id}`],
  );
  return { nodeId: primary, name: node.name ?? 'Layer', kind, suggestions };
}
