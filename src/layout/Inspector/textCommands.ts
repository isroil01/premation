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
import { documentMirror } from '@stores/documentMirror';
import { componentOfType } from '@core/engine/propRefs';
import { colorValueHex } from '@core/mirror/paintFields';
import { plainValue, storedNumber, trackRefIn } from '@core/mirror/trackIndex';
import { hasTextLayer } from '@layout/Text/textMirror';
import { useSelectionStore } from '@stores/selectionStore';
import { getTime } from '@stores/playbackClockStore';
import { edit } from '@core/engine/uiEdits';
import { isLayer } from '@core/mirror/docFacts';
import { fieldCommands } from '@layout/Text/textEdits';
import { componentPropsCommands } from './useComponentProp';

export const TEXT_SWAP_FILL_STROKE_COMMAND = asCommandId('text.swapFillStroke');
/** Layer ▸ Text ▸ Convert to Vertical/Horizontal Text. */
export const TEXT_TOGGLE_ORIENTATION_COMMAND = asCommandId('text.toggleOrientation');

// Document colours (what a swap writes), not UI styling — the design-system
// hex rule only applies to .tsx UI files, so no disable comment is needed here.
const DEFAULT_TEXT_FILL = '#ffffff';
const DEFAULT_TEXT_STROKE = '#000000';

interface TextTarget {
  id: string;
  compId: string;
  /** The STORED fill / stroke / width (unset = this module's defaults) and the switches. */
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  noFill: boolean;
  noStroke: boolean;
  orientation: unknown;
}

function textTarget(id: string): TextTarget | null {
  // B4: the values from the mirror — an UNSTORED fill / stroke / width
  // (PropertyInfo.stored unset) falls back to this module's defaults, which the
  // catalog's registry defaults do not match. The Text component's id is the
  // write seam's (`componentPropsCommands` composes the swap per component, B3).
  const m = documentMirror();
  if (!hasTextLayer(m, id)) return null;
  const compId = componentOfType(id, 'Text');
  const tree = m.tree(id);
  if (!compId || !tree) return null;
  const stored = (path: string) => { const info = tree.nodes.get(path); return info?.stored === true ? info : undefined; };
  const width = trackRefIn(tree, 'strokeWidth');
  return {
    id,
    compId,
    fill: colorValueHex(stored('layer/fill')?.value),
    stroke: colorValueHex(stored('text/stroke')?.value),
    strokeWidth: width && width.info.stored === true ? storedNumber(width, width.info.value) : undefined,
    noFill: plainValue(tree.nodes.get('text/noFill')?.value) === true,
    noStroke: plainValue(tree.nodes.get('text/noStroke')?.value) === true,
    orientation: plainValue(tree.nodes.get('text/orientation')?.value),
  };
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
 *
 * B3z: the engine API, one batch — `layer/fill`, `text/stroke`,
 * `text/noFill` / `text/noStroke` and the stroke width, a latent property
 * (`layer/strokeWidth`, homed on the Text component) until the layer stores it.
 * Only layers of a composition are addressed; any other node is left alone.
 */
export function swapTextFillStroke(nodeIds: ReadonlyArray<string>): boolean {
  const targets = nodeIds.filter((id) => isLayer(id)).map(textTarget).filter((t): t is TextTarget => t !== null);
  if (targets.length === 0) return false;
  const plans = targets.map((t) => {
    const values: Record<string, unknown> = {};
    const fill = t.fill ?? DEFAULT_TEXT_FILL;
    const stroke = t.stroke ?? DEFAULT_TEXT_STROKE;
    const { noFill, noStroke } = t;
    values.fill = stroke;
    values.stroke = fill;
    if (noFill !== noStroke) {
      values.noFill = noStroke;
      values.noStroke = noFill;
    }
    if (!(typeof t.strokeWidth === 'number' && t.strokeWidth > 0)) values.strokeWidth = 2;
    return componentPropsCommands(t.id, t.compId, values, getTime());
  });
  // ONE batch; a text layer addresses every one of these (latentPropSpecs.ts
  // makes an unstored stroke width a property too), so nothing is left over.
  void edit('Swap Fill and Stroke', plans.flatMap((pl) => pl.cmds));
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
  const next = targets.some((t) => t.orientation !== 'vertical') ? 'vertical' : 'horizontal';
  // `text/orientation` (G1), one batch over the selection.
  void edit(
    next === 'vertical' ? 'Convert to Vertical Text' : 'Convert to Horizontal Text',
    targets.flatMap(({ id }) => fieldCommands(id, 'text/orientation', next)),
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
