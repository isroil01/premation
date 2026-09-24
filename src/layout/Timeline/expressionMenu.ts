/**
 * AE's Add / Enable-Disable / Remove Expression on a timeline property row's
 * context menu — the same three items (and undo labels) as the inspector's `=`
 * toggle, read from the document MIRROR (B4) and written through the engine
 * API (`setExpression`, one entry per action).
 *
 * A row names TRACKS (`x`, `scaleY`, the Source Text track); a member of an
 * unseparated vector carries its own per-dimension expression
 * (`PropertyInfo.memberExpressions`), which is exactly what the legacy
 * per-track question asked.
 */

import { SOURCE_TEXT_PROP } from '@motion/animation';
import { ADD_EXPRESSION_COMMAND, DEFAULT_EXPRESSION, requestExpressionEditor } from '@core/animation/expressionCommands';
import { memberExpressionOf, type MemberExpressionFacts } from '@core/mirror/memberExpressions';
import { trackRefIn } from '@core/mirror/trackIndex';
import { edit } from '@core/engine/uiEdits';
import { expressionCommands } from '@layout/Inspector/inspectorEdits';
import { documentMirror } from '@stores/documentMirror';
import { useLayoutStore } from '@stores/layoutStore';
import { useSelectionStore } from '@stores/selectionStore';
import type { ContextMenuItem } from '@stores/contextMenuStore';

/** The Source Text row's track is the `text/sourceText` property. */
function apiTrack(prop: string): string {
  return prop === SOURCE_TEXT_PROP ? 'text/sourceText' : prop;
}

/** The expression one row track carries, or null. */
function expressionOn(nodeId: string, prop: string): MemberExpressionFacts | null {
  const r = trackRefIn(documentMirror().tree(nodeId), apiTrack(prop));
  return r ? memberExpressionOf(r.info, r.member) : null;
}

function send(label: string, pairs: Array<{ nodeId: string; track: string; source: string }>, enabled = true): void {
  const cmds = expressionCommands(pairs.map((p) => ({ ...p, track: apiTrack(p.track) })), enabled);
  if (cmds && cmds.length > 0) void edit(label, cmds);
}

/** Select the layer, bring the Properties panel up and open the row's expression editor. */
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

/** The three expression items for the props behind one timeline row. */
export function timelineExpressionMenuItems(nodeId: string, props: ReadonlyArray<string>): ContextMenuItem[] {
  const refs = props.map((prop) => ({ prop, expr: expressionOn(nodeId, prop) }));
  const withExpr = refs.filter((r) => r.expr !== null);
  const allHave = refs.length > 0 && withExpr.length === refs.length;
  const anyOff = withExpr.some((r) => r.expr?.enabled === false);
  return [
    {
      id: 'expr-add',
      label: 'Add Expression',
      commandId: ADD_EXPRESSION_COMMAND,
      disabled: refs.length === 0 || allHave,
      onSelect: () => {
        const fresh = props.filter((prop) => expressionOn(nodeId, prop) === null);
        if (fresh.length > 0) {
          send(fresh.length === 1 ? 'Add Expression' : 'Add Expressions', fresh.map((track) => ({ nodeId, track, source: DEFAULT_EXPRESSION })));
        }
        const first = props[0];
        if (first) revealEditor(nodeId, first);
      },
    },
    {
      id: 'expr-toggle',
      label: withExpr.length > 0 && anyOff ? 'Enable Expression' : 'Disable Expression',
      disabled: withExpr.length === 0,
      onSelect: () => {
        const had = props.map((prop) => ({ prop, expr: expressionOn(nodeId, prop) })).filter((r) => r.expr !== null);
        if (had.length === 0) return;
        const enable = had.some((r) => r.expr?.enabled === false);
        send(enable ? 'Enable Expression' : 'Disable Expression', had.map((r) => ({ nodeId, track: r.prop, source: r.expr!.source })), enable);
      },
    },
    {
      id: 'expr-remove',
      label: 'Remove Expression',
      disabled: withExpr.length === 0,
      onSelect: () => {
        const had = props.filter((prop) => expressionOn(nodeId, prop) !== null);
        if (had.length === 0) return;
        send(had.length === 1 ? 'Remove Expression' : 'Remove Expressions', had.map((track) => ({ nodeId, track, source: '' })));
      },
    },
  ];
}
