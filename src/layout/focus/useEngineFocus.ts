/**
 * Focus Mode's ghosting, drawn by the engine: the viewport is told the working
 * set (`setViewportFocus`) and dims every other layer in its frames. Editor
 * state — exports, thumbnails and other viewports are untouched.
 */

import { useEffect, useRef } from 'react';
import { useFocusStore, focusActiveSet } from '@stores/focusStore';
import { documentMirror } from '@stores/documentMirror';
import { engine } from '@core/engine/engineInstance';
import { withEngineViewport } from '@core/engine/windowViewport';

export function useEngineFocus(viewport: number): void {
  const path = useFocusStore((s) => s.path);
  const isolatedId = useFocusStore((s) => s.isolatedId);
  /** The set last sent, joined: '' = no focus. */
  const sent = useRef('');

  useEffect(() => {
    const sync = (): void => {
      const set = focusActiveSet(path, isolatedId);
      const layers = set ? [...set] : [];
      const key = layers.join(',');
      if (key === sent.current) return;
      sent.current = key;
      // `viewport` is the window's local id (windowViewport.ts).
      withEngineViewport(viewport, (id) => { void engine().execute({ type: 'setViewportFocus', viewport: id, layers }); });
    };
    sync();
    // A layer created inside the focused group joins the working set.
    return documentMirror().subscribe(['layers'], sync);
    // path is a ReadonlyArray — compared by content, as useFocusContext does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path.join(','), isolatedId, viewport]);

  // The viewport going away takes its focus with it.
  useEffect(
    () => () => {
      if (!sent.current) return;
      sent.current = '';
      withEngineViewport(viewport, (id) => { void engine().execute({ type: 'setViewportFocus', viewport: id, layers: [] }); });
    },
    [viewport],
  );
}
