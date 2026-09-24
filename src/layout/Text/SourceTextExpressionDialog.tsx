/**
 * The Source Text expression editor, as a tool window.
 *
 * AE reaches it by Alt-clicking Source Text's stopwatch. Here the Character
 * panel's Source Text row belongs to another surface, so the editor is opened
 * by the `text.sourceTextExpression` command — and once an expression is
 * attached, Source Text also appears among the Motion panel's expression
 * properties, since `animatedProps` lists expressed properties.
 *
 * The editor is the SAME `ExpressionEditor` every property uses; it detects
 * Source Text and previews text + style instead of a number.
 */

import { SOURCE_TEXT_PROP } from '@motion/animation';
import { openModal } from '@stores/modalStore';
import { documentMirror } from '@stores/documentMirror';
import { installSourceTextProvider } from '@core/textExpr/sourceTextProvider';
import { ExpressionEditor } from '@layout/Motion/ExpressionEditor';

export const SOURCE_TEXT_EXPRESSION_MODAL_ID = 'source-text-expression';

export function openSourceTextExpressionEditor(nodeId: string): void {
  installSourceTextProvider();
  const name = documentMirror().layer(nodeId)?.name ?? 'Text';
  openModal({
    // Stable id: a floating window remembers where it was put.
    id: SOURCE_TEXT_EXPRESSION_MODAL_ID,
    title: `Source Text Expression — ${name}`,
    size: 'md',
    variant: 'floating',
    render: () => <ExpressionEditor nodeId={nodeId} prop={SOURCE_TEXT_PROP} />,
  });
}
