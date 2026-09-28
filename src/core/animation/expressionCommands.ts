/**
 * Add / Remove / Enable-Disable Expression — After Effects' Animation ▸ Add
 * Expression (Alt+Shift+=) and a property's right-click expression entries, as
 * ONE helper every surface calls.
 *
 * Two surfaces had their own idea of "an expression": the inspector's `=`
 * toggle opened an editor and wrote nothing until you typed, and the timeline's
 * property rows had no expression entry at all. Both now come through here, so
 * an Add from either is the same single undo step — the default source `value`
 * (the property's own keyframed or static value: attaching it changes nothing
 * on screen until it is edited) — followed by the same request to open that
 * row's ExpressionEditor.
 *
 * Opening the editor is a REQUEST, not a call into a component: core cannot
 * import the inspector, and the row may not be mounted yet (Properties panel
 * closed, another layer shown). A mounted `MultiPropertyRow` hears it through
 * `onExpressionEditorRequest`; one that mounts shortly after claims it with
 * `consumeExpressionEditorRequest`.
 */

import { defaultAnimation } from '@motion/animation';
import type { PropertyRef } from '@stores/propertySelectionStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useLayoutStore } from '@stores/layoutStore';
import type { ContextMenuItem } from '@stores/contextMenuStore';
import { runAnimEdit } from './animationCommands';
import { ADD_EXPRESSION_COMMAND, DEFAULT_EXPRESSION, requestExpressionEditor } from './expressionEditorRequests';

// The request plumbing and the shortcut targets live in expressionEditorRequests (no document reads);
// re-exported here for the TypeScript-engine callers below and their tests.
export {
  ADD_EXPRESSION_COMMAND,
  DEFAULT_EXPRESSION,
  consumeExpressionEditorRequest,
  expressionTargets,
  onExpressionEditorRequest,
  requestExpressionEditor,
  setFocusedExpressionRow,
} from './expressionEditorRequests';

/** Bring the row on screen: its layer selected, the Properties panel open; then ask it to open its editor. */
function revealExpressionEditor(ref: PropertyRef): void {
  const selection = useSelectionStore.getState();
  if (!selection.ids.includes(ref.nodeId)) selection.set([ref.nodeId]);
  try {
    useLayoutStore.getState().openPanel('properties');
  } catch {
    /* headless: no layout to open */
  }
  requestExpressionEditor(ref);
}

// ── The three writes ────────────────────────────────────────────────────────

const hasExpr = (r: PropertyRef): boolean => defaultAnimation.hasExpression(r.nodeId, r.prop);

/**
 * Attach `value` to every ref that has no expression — ONE undo step — and
 * (unless `openEditor: false`) open the first ref's editor. A ref that already
 * has an expression keeps it; Add on it just opens the editor, as in AE.
 * Returns how many expressions were added.
 */
export function addExpression(
  refs: ReadonlyArray<PropertyRef>,
  opts: { openEditor?: boolean } = {},
): number {
  const fresh = refs.filter((r) => !hasExpr(r));
  if (fresh.length > 0) {
    runAnimEdit(fresh.length === 1 ? 'Add Expression' : 'Add Expressions', () =>
      defaultAnimation.batch(() => {
        for (const r of fresh) defaultAnimation.setExpression(r.nodeId, r.prop, DEFAULT_EXPRESSION);
      }),
    );
  }
  const first = refs[0];
  if (first && opts.openEditor !== false) revealExpressionEditor(first);
  return fresh.length;
}

/** Drop the expression from every ref that has one — ONE undo step. Returns how many. */
export function removeExpression(refs: ReadonlyArray<PropertyRef>): number {
  const had = refs.filter(hasExpr);
  if (had.length === 0) return 0;
  runAnimEdit(had.length === 1 ? 'Remove Expression' : 'Remove Expressions', () =>
    defaultAnimation.batch(() => {
      for (const r of had) defaultAnimation.removeExpression(r.nodeId, r.prop);
    }),
  );
  return had.length;
}

/**
 * Enable every attached expression if any is off, else disable them all — ONE
 * undo step, source kept. Returns the new state, or null when none has one.
 */
export function toggleExpressionEnabled(refs: ReadonlyArray<PropertyRef>): boolean | null {
  const had = refs.filter(hasExpr);
  if (had.length === 0) return null;
  const enable = had.some((r) => !defaultAnimation.isExpressionEnabled(r.nodeId, r.prop));
  runAnimEdit(enable ? 'Enable Expression' : 'Disable Expression', () =>
    defaultAnimation.batch(() => {
      for (const r of had) defaultAnimation.setExpressionEnabled(r.nodeId, r.prop, enable);
    }),
  );
  return enable;
}

// ── Surfaces ────────────────────────────────────────────────────────────────

/**
 * The expression entries of a property row's right-click menu. `props` is every
 * real track behind the row (a merged Position row is x and y).
 */
export function expressionMenuItems(nodeId: string, props: ReadonlyArray<string>): ContextMenuItem[] {
  const refs = props.map((prop) => ({ nodeId, prop }));
  const withExpr = refs.filter(hasExpr);
  const allHave = refs.length > 0 && withExpr.length === refs.length;
  const anyOff = withExpr.some((r) => !defaultAnimation.isExpressionEnabled(r.nodeId, r.prop));
  return [
    {
      id: 'expr-add',
      label: 'Add Expression',
      commandId: ADD_EXPRESSION_COMMAND,
      disabled: refs.length === 0 || allHave,
      onSelect: () => {
        addExpression(refs);
      },
    },
    {
      id: 'expr-toggle',
      label: withExpr.length > 0 && anyOff ? 'Enable Expression' : 'Disable Expression',
      disabled: withExpr.length === 0,
      onSelect: () => {
        toggleExpressionEnabled(refs);
      },
    },
    {
      id: 'expr-remove',
      label: 'Remove Expression',
      disabled: withExpr.length === 0,
      onSelect: () => {
        removeExpression(refs);
      },
    },
  ];
}
