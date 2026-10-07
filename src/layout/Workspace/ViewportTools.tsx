/**
 * The composition's one contextual SCENE tool in the transport row: the
 * motion-path toggle, shown while the single selected layer has Position
 * keyframes (AE draws the path of the selected layer; Ctrl+Alt+M here).
 *
 * **This renders in the transport bar, right of the play cluster**, before the
 * display controls (`ViewportDisplayControls`).
 *
 * What used to sit beside it and does not any more (2026-10-07), because each
 * had a better home and the row had grown to 24 buttons:
 *
 *  • the 3D-view badge — the 3D View menu at the left of the row already names
 *    the view and lights up off the Active Camera (`1` returns to it);
 *  • Auto-Bezier / Straighten path — keyframe actions, so rows of the
 *    keyframe right-click menu (Motion Path ▸);
 *  • the "make 3D" cube — AE's 3D switch is the timeline column and Layer ▸
 *    3D Layer;
 *  • the "Animated" chip — the timeline's diamonds say it.
 *
 * The Free/Fixed camera lock is `Tabs/EditorTabs.tsx`.
 */

import { useMemo } from 'react';
import { Icon } from '@components/Icon';
import { useGuidesStore } from '@stores/guidesStore';
import { useSelectionStore } from '@stores/selectionStore';
import { documentMirror } from '@stores/documentMirror';
import { useMirrorKeys } from '@hooks/useMirror';
import { hasPositionKeys } from '@core/mirror/motionFacts';
import styles from './ViewportTools.module.css';

export function ViewportTools(): JSX.Element | null {
  const motionPathVisible = useGuidesStore((s) => s.motionPathVisible);
  const toggleMotionPath = useGuidesStore((s) => s.toggleMotionPath);

  // Re-render when the selection or a selected layer's keyframes change, so
  // the toggle appears and disappears with the path.
  const selectedIds = useSelectionStore((s) => s.ids);
  const watchKeys = useMemo(() => selectedIds.map((id) => `keys:${id}`), [selectedIds]);
  useMirrorKeys(watchKeys);

  const singleId = selectedIds.length === 1 ? selectedIds[0] : null;
  if (!singleId || !hasPositionKeys(documentMirror(), singleId)) return null;

  return (
    <div className={styles.tools}>
      <div className={styles.group}>
        <button
          className={`${styles.headerBtn} ${motionPathVisible ? styles.headerBtnActive : ''}`}
          onClick={toggleMotionPath}
          aria-label="Show motion path"
          aria-pressed={motionPathVisible}
          title={motionPathVisible ? 'Hide Motion Path (Ctrl+Alt+M)' : 'Show Motion Path (Ctrl+Alt+M)'}
        >
          <Icon name="path" size="md" />
        </button>
        <span className={styles.sep} />
      </div>
    </div>
  );
}
