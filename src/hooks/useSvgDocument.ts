/**
 * An SVG layer's stored document as the ENGINE reports it (`getSvgDocument`,
 * ENGINE_API.md §15.12) — asked again when the layer's header or tree changes
 * in the mirror. Null until the answer lands and for a layer without one.
 */

import { useEffect, useState } from 'react';
import type { SvgDocument } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';
import { useMirrorKeys } from './useMirror';

export function useSvgDocument(layer: string | null | undefined): SvgDocument | null {
  const rev = useMirrorKeys(layer ? [`layer:${layer}`, `tree:${layer}`] : []);
  const [answer, setAnswer] = useState<{ layer: string; doc: SvgDocument | null } | null>(null);
  useEffect(() => {
    if (!layer) return undefined;
    let live = true;
    void engine().query({ type: 'getSvgDocument', layer }).then((res) => {
      if (live) setAnswer({ layer, doc: res.ok ? res.value : null });
    });
    return () => {
      live = false;
    };
  }, [layer, rev]);
  return answer && answer.layer === layer ? answer.doc : null;
}
