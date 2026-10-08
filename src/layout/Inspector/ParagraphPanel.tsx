/**
 * ParagraphPanel — After Effects' Paragraph panel: alignment and justification,
 * indents, space before / after, paragraph spacing, direction and orientation.
 *
 * The rows are the Character panel's own: both panels render the one
 * `TextSettingsBody` (CharacterPanel.tsx), this one with the `paragraph`
 * variant and Character with `character`, so a paragraph property has exactly
 * one implementation whichever panel — or the Properties panel's Text section —
 * draws it. Until 2026-10 this file was a re-export of `CharacterPanel`.
 */

import { useSelectionStore } from '@stores/selectionStore';
import { TextSettingsBody } from './CharacterPanel';

/** The selection's text layer, or the defaults a new text layer would take when nothing is selected. */
export function ParagraphPanel(): JSX.Element {
  const selected = useSelectionStore((s) => s.ids);
  return <TextSettingsBody nodeId={selected[0]} nodeIds={selected} variant="paragraph" />;
}

export default ParagraphPanel;
