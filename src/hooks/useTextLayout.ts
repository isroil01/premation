/**
 * A text layer's layout as the ENGINE measures it (`getTextLayout`,
 * ENGINE_API.md §15.12): the render box, the wrap, the paragraph box
 * (content height, overflow, fit scale), the glyph boxes (§15.14). Asked again
 * whenever the layer's header, property tree or keys change in the mirror, or
 * the `overrides` change (the in-place editor's typed draft — one query per
 * keystroke) — never per played frame. Null until the first answer lands, for a
 * non-text layer, and where the engine cannot measure (no fonts). While a new
 * answer is on its way the previous one for the same layer stays.
 */

import { useEffect, useState } from 'react';
import type { TextLayout, TextLayoutOverrides } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { useMirrorKeys, useRetainTree } from './useMirror';

export function useTextLayout(layer: string | null | undefined, overrides?: TextLayoutOverrides): TextLayout | null {
  useRetainTree(layer);
  // The layout follows the Text group and the masks a text path runs along (and the header,
  // the tree's shape, the keys) — not every write on the layer: a Position drag re-measures nothing.
  const rev = useMirrorKeys(layer ? [`layer:${layer}`, `struct:${layer}`, `grp:${layer}|text`, `grp:${layer}|masks`, `keys:${layer}`] : []);
  const [answer, setAnswer] = useState<{ layer: string; layout: TextLayout | null } | null>(null);
  const overrideKey = overrides ? JSON.stringify(overrides) : '';
  useEffect(() => {
    if (!layer) return undefined;
    let live = true;
    const o = overrideKey ? (JSON.parse(overrideKey) as TextLayoutOverrides) : undefined;
    void engine().query({ type: 'getTextLayout', layer, time: 0, ...(o ? { overrides: o } : {}) }).then((res) => {
      if (live) setAnswer({ layer, layout: res.ok ? res.value : null });
    });
    return () => {
      live = false;
    };
  }, [layer, rev, overrideKey]);
  return answer && answer.layer === layer ? answer.layout : null;
}
