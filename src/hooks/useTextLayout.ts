/**
 * A text layer's layout as the ENGINE measures it (`getTextLayout`,
 * ENGINE_API.md §15.12): the render box, the wrap, the paragraph box
 * (content height, overflow, fit scale). Asked again whenever the layer's
 * header, property tree or keys change in the mirror — never per played frame.
 * Null until the first answer lands, for a non-text layer, and where the
 * engine cannot measure (no fonts).
 */

import { useEffect, useState } from 'react';
import type { TextLayout } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { useMirrorKeys, useRetainTree } from './useMirror';

export function useTextLayout(layer: string | null | undefined): TextLayout | null {
  useRetainTree(layer);
  const rev = useMirrorKeys(layer ? [`layer:${layer}`, `tree:${layer}`, `keys:${layer}`] : []);
  const [answer, setAnswer] = useState<{ layer: string; layout: TextLayout | null } | null>(null);
  useEffect(() => {
    if (!layer) return undefined;
    let live = true;
    void engine().query({ type: 'getTextLayout', layer, time: 0 }).then((res) => {
      if (live) setAnswer({ layer, layout: res.ok ? res.value : null });
    });
    return () => {
      live = false;
    };
  }, [layer, rev]);
  return answer && answer.layer === layer ? answer.layout : null;
}
