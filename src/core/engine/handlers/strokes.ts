/** The shape stroke stack's command (B3z, strokeStack.ts): `removeStroke`. */

import { graph, requireLayer } from '../doc';
import { newScope, scopeLayer } from '../state';
import { planRemoveStroke } from '../strokeStack';
import type { HandlerTable } from '../handler';

export const strokeHandlers: HandlerTable = {
  removeStroke: (cmd) => {
    requireLayer(cmd.layer);
    const apply = planRemoveStroke(cmd.layer, graph.getNode(cmd.layer)!, cmd.index);
    return {
      scope: scopeLayer(newScope(), cmd.layer),
      label: `Remove Stroke ${cmd.index + 1}`,
      apply: () => {
        apply();
        return {};
      },
    };
  },
};
