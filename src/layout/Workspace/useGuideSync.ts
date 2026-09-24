/**
 * Keeps the engine's live ruler guides and the DOCUMENT's copy in step.
 *
 * The workspace engine owns the guides you drag (world positions); the
 * guides store's `userGuides` is what a project saves (value + unit + pin edge
 * + colour — see `guideGeometry`). Three directions of change:
 *
 *  • engine → document  — any add / move / edit / delete re-serializes;
 *  • document → engine  — opening a project replaces the engine's user guides;
 *  • composition resize — every %-unit or end-pinned guide is re-resolved from
 *                         its stored value against the new size.
 *
 * A re-entrancy flag stops each direction echoing back through the other.
 * Mount once, from the main viewport.
 */

import { useEffect } from 'react';
import { getWorkspaceController } from '@core/workspace/WorkspaceController';
import { useGuidesStore } from '@stores/guidesStore';
import { activeCompSizeNow } from '@hooks/useMirrorFrame';
import { documentMirror } from '@stores/documentMirror';
import { useProjectStore } from '@stores/projectStore';
import {
  guidePositionFromValue,
  resolveGuideOnResize,
  storedGuidesKey,
  toStoredGuide,
  type CompExtent,
  type StoredGuide,
} from '@core/workspace/guideGeometry';

function compExtent(): CompExtent {
  const s = activeCompSizeNow();
  return { w: s.width || 1920, h: s.height || 1080 };
}

export function useGuideSync(): void {
  useEffect(() => {
    const controller = getWorkspaceController();
    const guides = controller.ws.guides;
    let comp = compExtent();
    let applying = false;

    const engineStored = (): StoredGuide[] =>
      guides.list().filter((g) => g.kind === 'user').map((g) => toStoredGuide(g, comp));

    const toDocument = (): void => {
      if (applying) return;
      const list = engineStored();
      const store = useGuidesStore.getState();
      if (storedGuidesKey(list) === storedGuidesKey(store.userGuides)) return;
      applying = true;
      try {
        store.setUserGuides(list);
      } finally {
        applying = false;
      }
    };

    const toEngine = (list: readonly StoredGuide[]): void => {
      if (applying) return;
      if (storedGuidesKey(engineStored()) === storedGuidesKey(list)) return;
      applying = true;
      try {
        guides.replaceUserGuides(
          list.map((s) => ({
            axis: s.axis,
            position: guidePositionFromValue(s.value, s.axis, s.unit, s.edge, comp),
            locked: s.locked,
            unit: s.unit,
            edge: s.edge,
            color: s.color,
          })),
        );
      } finally {
        applying = false;
      }
      controller.requestRender();
    };

    // First mount: a document that already carries guides wins; otherwise
    // whatever the engine has (guides drawn before the viewport remounted)
    // becomes the document's.
    const initial = useGuidesStore.getState().userGuides;
    if (initial.length > 0) toEngine(initial);
    else toDocument();

    const offEngine = guides.events.on('changed', toDocument);
    const offStore = useGuidesStore.subscribe((s, prev) => {
      if (s.userGuides !== prev.userGuides) toEngine(s.userGuides);
    });
    // The size is the mirror's (B4): listen to its composition records, and to
    // the project store for a tab switch, and compare the resolved size.
    const onComp = (): void => {
      const next = compExtent();
      if (next.w === comp.w && next.h === comp.h) return;
      const from = comp;
      comp = next;
      applying = true;
      try {
        for (const g of guides.list()) {
          if (g.kind !== 'user') continue;
          const next = resolveGuideOnResize(g.position, g.axis, g.unit ?? 'px', g.edge ?? 'start', from, comp);
          if (next !== g.position) guides.update(g.id, { position: next });
        }
      } finally {
        applying = false;
      }
      // Values are invariant under the resize by construction; re-serialize
      // anyway so a rounding difference cannot leave the two out of step.
      toDocument();
      controller.requestRender();
    };
    const offTab = useProjectStore.subscribe(onComp);
    const offComps = documentMirror().subscribe(['comps'], onComp);

    return () => {
      offEngine.dispose();
      offStore();
      offTab();
      offComps();
    };
  }, []);
}
