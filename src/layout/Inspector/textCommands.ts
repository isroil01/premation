/**
 * Text commands, registered as first-class COMMANDS.
 *
 * Same pattern as `timelineFitCommands.ts`: registered from the feature's own
 * module so the handler, the id and the shortcut ship together. The Character
 * panel advertised "Swap Fill and Stroke (Shift+X)" for a long time while no
 * such shortcut existed; this is that shortcut.
 *
 * Installed from `TextEditOverlay` (always mounted with the workspace) and from
 * the Character panel. Registration is idempotent and the shortcut manager
 * re-scans afterwards — bindings are a snapshot of the registry taken at boot.
 *
 * Menu row for the orchestrator: Layer ▸ Text ▸ "Swap Fill and Stroke"
 * (Shift+X), command `text.swapFillStroke`.
 */

import { asCommandId } from '@app-types/common';
import { getCommandRegistry, type Command } from '@core/commands/Command';
import { getShortcutManager } from '@core/commands/ShortcutManager';
import { runDocumentEdit } from '@core/commands/documentEdit';
import { updateNodeComponentProp } from '@core/inspector/InspectorAPI';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { useSelectionStore } from '@stores/selectionStore';
import { getTime } from '@stores/playbackClockStore';
import { edit } from '@core/engine/uiEdits';
import { fieldCommands } from '@layout/Text/textEdits';
import { componentPropsCommands } from './useComponentProp';
import type { SceneNode } from '@core/types';

export const TEXT_SWAP_FILL_STROKE_COMMAND = asCommandId('text.swapFillStroke');
/** Layer ▸ Text ▸ Convert to Vertical/Horizontal Text. */
export const TEXT_TOGGLE_ORIENTATION_COMMAND = asCommandId('text.toggleOrientation');

// Document colours (what a swap writes), not UI styling — the design-system
// hex rule only applies to .tsx UI files, so no disable comment is needed here.
const DEFAULT_TEXT_FILL = '#ffffff';
const DEFAULT_TEXT_STROKE = '#000000';

interface TextTarget {
  node: SceneNode;
  compId: string;
  props: Record<string, unknown>;
}

function textTarget(id: string): TextTarget | null {
  const node = defaultSceneGraph.getNode(id);
  const comp = node?.components.find((c) => c.type === 'Text');
  return node && comp ? { node, compId: comp.id, props: comp.props as Record<string, unknown> } : null;
}

/** Selected layers that are text layers. */
export function selectedTextLayerIds(): string[] {
  return useSelectionStore.getState().ids.filter((id) => textTarget(id) !== null);
}

/** True while focus is in something the user types into — Shift+X there is a
 *  capital X, not a command. */
export function isTypingInField(
  el: Element | null = typeof document !== 'undefined' ? document.activeElement : null,
): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * AE's Swap Fill and Stroke for text layers: exchanges the fill and stroke
 * colours and their "none" swatches, as ONE undo step. A layer with no stroke
 * width gets 2px so the swap is visible (the fill would otherwise vanish into
 * a zero-width stroke) — what the Character panel button has always done.
 */
export function swapTextFillStroke(nodeIds: ReadonlyArray<string>): boolean {
  const targets = nodeIds.map(textTarget).filter((t): t is TextTarget => t !== null);
  if (targets.length === 0) return false;
  const plans = targets.map(({ node, compId, props }) => {
    const values: Record<string, unknown> = {};
    const fill = typeof props.fill === 'string' ? props.fill : DEFAULT_TEXT_FILL;
    const stroke = typeof props.stroke === 'string' ? props.stroke : DEFAULT_TEXT_STROKE;
    const noFill = props.noFill === true;
    const noStroke = props.noStroke === true;
    values.fill = stroke;
    values.stroke = fill;
    if (noFill !== noStroke) {
      values.noFill = noStroke;
      values.noStroke = noFill;
    }
    if (!(typeof props.strokeWidth === 'number' && props.strokeWidth > 0)) values.strokeWidth = 2;
    return { id: node.id, compId, values, ...componentPropsCommands(node.id, compId, values, getTime()) };
  });
  // Engine API (G1): layer/fill, text/stroke, text/noFill… — ONE batch.
  if (plans.every((pl) => Object.keys(pl.rest).length === 0)) {
    void edit('Swap Fill and Stroke', plans.flatMap((pl) => pl.cmds));
    return true;
  }
  // B3-legacy: engine gap — a stroke width the text layer has never stored has no API property (layer/strokeWidth is listed only once stored).
  runDocumentEdit('Swap Fill and Stroke', () => {
    for (const { id, compId, values } of plans) {
      for (const [key, value] of Object.entries(values)) updateNodeComponentProp(defaultSceneGraph, id, compId, key, value);
    }
  });
  return true;
}

/**
 * AE's Convert to Vertical / Horizontal Text for the selected text layers, as
 * ONE undo step. A selection that holds any horizontal layer converts to
 * vertical; an all-vertical selection converts back.
 */
export function toggleTextOrientation(nodeIds: ReadonlyArray<string>): 'vertical' | 'horizontal' | null {
  const targets = nodeIds.map(textTarget).filter((t): t is TextTarget => t !== null);
  if (targets.length === 0) return null;
  const next = targets.some((t) => t.props.orientation !== 'vertical') ? 'vertical' : 'horizontal';
  // `text/orientation` (G1), one batch over the selection.
  void edit(
    next === 'vertical' ? 'Convert to Vertical Text' : 'Convert to Horizontal Text',
    targets.flatMap(({ node }) => fieldCommands(node.id, 'text/orientation', next)),
  );
  return next;
}

export function buildTextCommands(): ReadonlyArray<Command> {
  return [
    {
      id: TEXT_TOGGLE_ORIENTATION_COMMAND,
      label: 'Convert to Vertical/Horizontal Text',
      description: 'Switch the selected text layers between horizontal and vertical type.',
      enabled: () => selectedTextLayerIds().length > 0,
      execute: () => {
        toggleTextOrientation(selectedTextLayerIds());
      },
    },
    {
      id: TEXT_SWAP_FILL_STROKE_COMMAND,
      label: 'Swap Fill and Stroke',
      description: 'Exchange the fill and stroke colours of the selected text layers.',
      shortcut: { key: 'x', shift: true },
      enabled: () => !isTypingInField() && selectedTextLayerIds().length > 0,
      execute: () => {
        swapTextFillStroke(selectedTextLayerIds());
      },
    },
  ];
}

let installed = false;

/** Register the text commands and bind their shortcuts. Safe to call repeatedly. */
export function installTextCommands(): void {
  if (installed) return;
  installed = true;
  const registry = getCommandRegistry();
  for (const command of buildTextCommands()) registry.register(command);
  getShortcutManager().rehydrateFromRegistry();
}

/** Test seam — forget that the commands were installed. */
export function resetTextCommandsForTest(): void {
  installed = false;
}
