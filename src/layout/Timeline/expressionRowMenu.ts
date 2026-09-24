/**
 * The expression entries of a timeline property row's right-click menu (AE's
 * Add / Enable-Disable / Remove Expression) — the entries of
 * `expressionCommands.expressionMenuItems`, with the row's STATE read from the
 * document mirror (B4) and each action ONE engine batch of `setExpression`
 * (B3: the inspector's `expressionCommands`, per member for an unseparated
 * vector) instead of the legacy animation writers.
 *
 * `props` is every real track behind the row (a merged Position row is x and
 * y); a track's expression is its property member's (`trackExpressionFacts`).
 * Add attaches AE's default `value` (visually a no-op until edited) and asks
 * the row's inline editor to open, as the inspector's `=` toggle does.
 */

import { ADD_EXPRESSION_COMMAND, DEFAULT_EXPRESSION, requestExpressionEditor } from '@core/animation/expressionCommands';
import { edit } from '@core/engine/uiEdits';
import { trackExpressionFacts } from '@core/mirror/memberExpressions';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import { documentMirror } from '@stores/documentMirror';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import { expressionCommands } from '@layout/Inspector/inspectorEdits';

type Pair = { nodeId: string; track: string; source: string };

function send(label: string, pairs: Pair[], enabled: boolean): void {
  const cmds = pairs.length > 0 ? expressionCommands(pairs, enabled) : null;
  if (cmds && cmds.length > 0) void edit(label, cmds);
}

/** Bring the row on screen — its layer selected, the Properties panel open — and ask it to open its editor. */
function revealEditor(nodeId: string, prop: string): void {
  const selection = useSelectionStore.getState();
  if (!selection.ids.includes(nodeId)) selection.set([nodeId]);
  try {
    useLayoutStore.getState().openPanel('properties');
  } catch {
    /* headless: no layout to open */
  }
  requestExpressionEditor({ nodeId, prop });
}

export function expressionRowMenuItems(nodeId: string, props: ReadonlyArray<string>): ContextMenuItem[] {
  const m = documentMirror();
  const rows = props.map((track) => ({ track, facts: trackExpressionFacts(m, nodeId, track) }));
  const had = rows.filter((r) => r.facts !== null);
  const allHave = rows.length > 0 && had.length === rows.length;
  const anyOff = had.some((r) => r.facts?.enabled === false);
  const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
  return [
    {
      id: 'expr-add',
      label: 'Add Expression',
      commandId: ADD_EXPRESSION_COMMAND,
      disabled: rows.length === 0 || allHave,
      onSelect: () => {
        const fresh = rows.filter((r) => r.facts === null).map((r) => ({ nodeId, track: r.track, source: DEFAULT_EXPRESSION }));
        send(plural(fresh.length, 'Add Expression', 'Add Expressions'), fresh, true);
        const first = props[0];
        if (first !== undefined) revealEditor(nodeId, first);
      },
    },
    {
      id: 'expr-toggle',
      label: had.length > 0 && anyOff ? 'Enable Expression' : 'Disable Expression',
      disabled: had.length === 0,
      onSelect: () => {
        // Enable every attached expression if any is off, else disable them all; the source is kept.
        send(anyOff ? 'Enable Expression' : 'Disable Expression', had.map((r) => ({ nodeId, track: r.track, source: r.facts!.source })), anyOff);
      },
    },
    {
      id: 'expr-remove',
      label: 'Remove Expression',
      disabled: had.length === 0,
      onSelect: () => {
        send(plural(had.length, 'Remove Expression', 'Remove Expressions'), had.map((r) => ({ nodeId, track: r.track, source: '' })), false);
      },
    },
  ];
}
