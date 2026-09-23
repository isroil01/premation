/**
 * Text — Character + Paragraph settings for the selected text layer, in the
 * Properties panel.
 *
 * NOT a second implementation. An earlier `TextSection` was deleted because it
 * had drifted from `CharacterPanel` while nothing mounted it; this one renders
 * the panel's own `TextSettingsBody` in its section layout, so the standalone
 * Text panel (now on demand) and this section are one component arranged two
 * ways.
 */

import { memo, useCallback } from 'react';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { readNodeKind } from '@core/scene/sceneDerive';
import { captureTextPreset } from '@core/inspector/sectionPresets';
import type { PresetValues } from '@stores/sectionPresetStore';
import { useSceneRevision } from '@stores/sceneStore';
import { TextSettingsBody } from './CharacterPanel';
import { SectionPresetMenu } from './SectionPresetMenu';
import { useInspectorSelection } from './inspectorSelection';
import { textPresetEdit } from '@layout/Text/textEdits';

/**
 * Whether the Text section belongs on this layer. The Text component is checked
 * as well as the stored kind: a layer built without the kind stamp still draws
 * as text, and hiding its font controls would strand it. Tolerant by design.
 */
export function hasTextSection(nodeId: string): boolean {
  try {
    const node = defaultSceneGraph.getNode(nodeId);
    if (!node) return false;
    return readNodeKind(node) === 'text' || node.components.some((c) => c.type === 'Text');
  } catch {
    return false;
  }
}

function TextSectionInner({ nodeId }: { nodeId: string }): JSX.Element | null {
  useSceneRevision((s) => s.rev);
  const nodeIds = useInspectorSelection(nodeId);
  // After every hook: the node can vanish between renders (a deleted layer).
  if (!hasTextSection(nodeId)) return null;
  return <TextSettingsBody nodeId={nodeId} nodeIds={nodeIds} variant="section" />;
}

/*
 * Memoized like every registry section — see `inspectorRenderScope.test.tsx`.
 * The body subscribes to the scene revision itself, so a parent re-render with
 * the same `nodeId` has nothing to tell it.
 */
export const TextSection = memo(TextSectionInner);

/** Header action: save / apply text style presets across the selection. */
export function TextPresetAction({
  nodeId,
  nodeIds,
}: {
  nodeId: string;
  nodeIds?: ReadonlyArray<string>;
}): JSX.Element {
  const selection = useInspectorSelection(nodeId);
  const targets = nodeIds && nodeIds.length > 0 ? nodeIds : selection;
  const capture = useCallback(() => captureTextPreset(nodeId), [nodeId]);
  const apply = useCallback((values: PresetValues) => { textPresetEdit(targets, values); }, [targets]);
  return <SectionPresetMenu sectionId="text" label="Text style presets" capture={capture} apply={apply} />;
}

export default TextSection;
