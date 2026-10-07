/**
 * The expression editor, opened FROM THE TIMELINE (2026-10-07).
 *
 * AE edits an expression where its property row is. The app's editor (the
 * Motion panel's `ExpressionEditor`: pick-whip, enable switch, completions,
 * the live value and the inline error) used to be reachable only by switching
 * to the Properties panel; this opens that same editor in a floating window
 * over the timeline, so the timeline stays live and scrubbable behind it.
 * One editor, two hosts — never a second implementation.
 */

import { openModal } from '@stores/modalStore';
import { documentMirror } from '@stores/documentMirror';
import { ExpressionEditor } from '@layout/Motion/ExpressionEditor';

/** Open the expression editor for `prop` of layer `nodeId`, floating over the timeline. */
export function openTimelineExpressionEditor(nodeId: string, prop: string): void {
  const name = documentMirror().layer(nodeId)?.name ?? 'Layer';
  openModal({
    id: 'timeline-expression-editor',
    title: `Expression — ${name}`,
    size: 'md',
    variant: 'floating',
    render: () => <ExpressionEditor nodeId={nodeId} prop={prop} />,
  });
}
