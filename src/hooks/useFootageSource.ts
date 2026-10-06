/**
 * Which footage layer a tracking-style panel works on: the selected layer when
 * it is footage, else the one the user chose in the panel, else the
 * composition's first footage layer. Shared by the Tracker and Content-Aware
 * Fill panels.
 */

import { useMemo, useState } from 'react';
import { useSelectionStore } from '@stores/selectionStore';
import { useMirrorLayer } from '@hooks/useMirror';
import { useActiveCompLayers } from '@hooks/useMirrorFields';
import { uiKindOf } from '@core/mirror/layerKinds';

const isFootageKind = (kind: string | null): boolean => kind === 'video' || kind === 'image';

export interface FootageSource {
  /** The layer the panel acts on, or null when the comp has no footage. */
  activeId: string | null;
  /** The primary selection, when it is footage. */
  selectedId: string | null;
  layers: Array<{ id: string; name: string }>;
  choose(id: string): void;
}

export function useFootageSource(): FootageSource {
  const selected = useSelectionStore((s) => s.ids);
  const compLayers = useActiveCompLayers();
  const layers = useMemo(
    () => compLayers.filter((l) => isFootageKind(uiKindOf(l))).map((l) => ({ id: l.id, name: l.name || l.id })),
    [compLayers],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const primary = selected[0] ?? null;
  const primaryLayer = useMirrorLayer(primary);
  const primaryIsFootage = isFootageKind(uiKindOf(primaryLayer));
  const activeId = primaryIsFootage ? primary : (chosen && layers.some((l) => l.id === chosen) ? chosen : layers[0]?.id ?? null);
  return { activeId, selectedId: primaryIsFootage ? primary : null, layers, choose: setChosen };
}
