/**
 * Which property an expression shortcut acts on, and the request that opens a
 * row's ExpressionEditor. No document reads: the targets are the focused
 * inspector row or the timeline's selected property rows (editor state), and
 * opening the editor is a REQUEST a mounted `MultiPropertyRow` hears through
 * `onExpressionEditorRequest` (one that mounts shortly after claims it with
 * `consumeExpressionEditorRequest`) — core cannot import the inspector, and the
 * row may not be mounted yet.
 */

import { usePropertySelectionStore, type PropertyRef } from '@stores/propertySelectionStore';

/** AE's default: the property's own value, so adding one is visually a no-op. */
export const DEFAULT_EXPRESSION = 'value';

export const ADD_EXPRESSION_COMMAND = 'anim.addExpression';

const sameRef = (a: PropertyRef, b: PropertyRef): boolean => a.nodeId === b.nodeId && a.prop === b.prop;

type EditorRequestListener = (ref: PropertyRef) => void;
const editorListeners = new Set<EditorRequestListener>();
/** A request no mounted row answered yet, and when it was made. */
let pending: { ref: PropertyRef; at: number } | null = null;
/** A row mounting later than this after the request does not pop open. */
const PENDING_TTL_MS = 3000;

export function requestExpressionEditor(ref: PropertyRef): void {
  pending = { ref, at: Date.now() };
  for (const listener of [...editorListeners]) listener(ref);
}

export function onExpressionEditorRequest(listener: EditorRequestListener): () => void {
  editorListeners.add(listener);
  return () => {
    editorListeners.delete(listener);
  };
}

/** True (once) when an editor was requested for this row and nobody has opened it yet. */
export function consumeExpressionEditorRequest(nodeId: string, prop: string): boolean {
  if (!pending || !sameRef(pending.ref, { nodeId, prop })) return false;
  const fresh = Date.now() - pending.at <= PENDING_TTL_MS;
  pending = null;
  return fresh;
}

let focusedRow: PropertyRef | null = null;

/** The inspector row holding keyboard focus (set/cleared by the row itself). */
export function setFocusedExpressionRow(ref: PropertyRef | null): void {
  focusedRow = ref;
}

/** The focused inspector row wins; otherwise the timeline's selected property rows. */
export function expressionTargets(): PropertyRef[] {
  if (focusedRow) return [focusedRow];
  return [...usePropertySelectionStore.getState().entries];
}
