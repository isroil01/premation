/**
 * The document-wide search facts (B4): every layer's effect match names and
 * expression sources, from the engine's `getSearchFacts` — what the Layers
 * panel's Effects / Expressions search fields match. Asked only while such a
 * search is active, once per document revision; the last answer stays until
 * the next lands.
 */

import { useEffect, useState } from 'react';
import type { LayerSearchFacts } from '@motion/engine-api';
import { engine } from '@core/engine/engineInstance';

export type SearchFacts = ReadonlyMap<string, LayerSearchFacts>;

export function useSearchFacts(active: boolean, revision: number): SearchFacts | null {
  const [facts, setFacts] = useState<SearchFacts | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    void engine().query({ type: 'getSearchFacts', layers: [] }).then((r) => {
      if (!live || !r.ok) return;
      setFacts(new Map(r.value.layers.map((f) => [f.layer, f])));
    });
    return () => {
      live = false;
    };
  }, [active, revision]);
  return active ? facts : null;
}
