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
