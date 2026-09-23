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
  // B3-legacy: engine gap — text component props (strings / runs) are not API properties yet.
  runDocumentEdit('Swap Fill and Stroke', () => {
    for (const { node, compId, props } of targets) {
      const write = (key: string, value: unknown): void => {
        updateNodeComponentProp(defaultSceneGraph, node.id, compId, key, value);
      };
      const fill = typeof props.fill === 'string' ? props.fill : DEFAULT_TEXT_FILL;
      const stroke = typeof props.stroke === 'string' ? props.stroke : DEFAULT_TEXT_STROKE;
      const noFill = props.noFill === true;
      const noStroke = props.noStroke === true;
      write('fill', stroke);
      write('stroke', fill);
      if (noFill !== noStroke) {
        write('noFill', noStroke);
        write('noStroke', noFill);
      }
      if (!(typeof props.strokeWidth === 'number' && props.strokeWidth > 0)) write('strokeWidth', 2);
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
  // B3-legacy: engine gap — text component props (strings / runs) are not API properties yet.
  runDocumentEdit(next === 'vertical' ? 'Convert to Vertical Text' : 'Convert to Horizontal Text', () => {
    for (const { node, compId } of targets) {
      updateNodeComponentProp(defaultSceneGraph, node.id, compId, 'orientation', next);
    }
  });
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
