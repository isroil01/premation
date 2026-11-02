/**
 * The brush HUD of the Object Matte tool group (the approved Subjects Pro
 * design, board 1): one small chip in the viewer's corner saying which tool
 * is up, its brush size and hardness, what the next press does (new / add /
 * cut, foreground / background) and the keys that change it — so the user
 * never leaves the picture to read the options bar.
 *
 * Beside it, while a subject is being followed in the background
 * (subjectActions.ts `walkSubject` → `setTracking`), a progress chip with a
 * Stop: the walk is a Tasks-panel job, so nothing here blocks the tool.
 *
 * Reads the store with selectors only: the HUD re-renders on a size change
 * or a tracking tick, never on a pointer move or a played frame.
 */

import { useRotoBrushStore } from '@stores/rotoBrushStore';
import { layerSubjects } from '@core/workspace/subjects';
import { cancelSubjectWalk, subjectWalkRunning } from './subjectActions';
import { t } from '@core/i18n';
import styles from './SubjectToolHud.module.css';

export type SubjectHudTool = 'object-matte' | 'snap' | 'exact' | 'refine';

/** Stop every walk of the layer's subjects (the chip does not know which one is running). */
function stopTracking(nodeId: string | null): void {
  if (!nodeId) return;
  for (const s of layerSubjects(nodeId)) if (subjectWalkRunning(nodeId, s.id)) cancelSubjectWalk(nodeId, s.id);
}

export function TrackingChip({ nodeId }: { nodeId: string | null }): JSX.Element | null {
  const tracking = useRotoBrushStore((s) => s.tracking);
  const pct = useRotoBrushStore((s) => Math.round(s.trackingProgress * 100));
  if (!tracking) return null;
  return (
    <div className={styles.tracking} role="status" data-tracking-chip="">
      <span className={styles.spinner} aria-hidden="true" />
      <span>{t('workspace.subjects.trackingPct', 'Tracking {pct} %', { pct })}</span>
      <button type="button" className={styles.stop} onClick={() => stopTracking(nodeId)} title={t('workspace.subjects.trackingStopTitle', 'Stop following the subject (what is tracked so far stays)')}>
        {t('workspace.subjects.trackingStop', 'Stop')}
      </button>
    </div>
  );
}

export function SubjectToolHud({ tool, nodeId }: { tool: SubjectHudTool; nodeId: string | null }): JSX.Element | null {
  const size = useRotoBrushStore((s) => s.size);
  const hardness = useRotoBrushStore((s) => s.hardness);
  const kind = useRotoBrushStore((s) => s.kind);
  const marquee = useRotoBrushStore((s) => s.marquee);
  const brush = tool !== 'object-matte';
  const name = tool === 'object-matte'
    ? t('topNav.roto.objectMatteLabel', 'Object Matte')
    : tool === 'exact'
      ? t('topNav.roto.selectionBrushLabel', 'Selection Brush')
      : tool === 'refine'
        ? t('topNav.roto.refineEdgeLabel', 'Refine Edge')
        : t('topNav.roto.quickSelectionLabel', 'Quick Selection');
  const mode = tool === 'object-matte'
    ? (marquee === 'lasso' ? t('topNav.roto.marqueeLasso', 'Lasso') : t('topNav.roto.marqueeRect', 'Rectangle'))
    : tool === 'refine'
      ? t('workspace.subjects.hud.soften', 'Soften edge')
      : kind === 'bg'
        ? t('workspace.subjects.hud.cut', 'Cut')
        : t('workspace.subjects.hud.add', 'Add');
  const keys = brush
    ? t('workspace.subjects.hud.brushKeys', '[ ] size · Shift [ ] hardness · Ctrl-drag resize · Alt cuts')
    : t('workspace.subjects.hud.matteKeys', 'Click new · Shift add · Alt cut · drag box · Tab part ⇄ whole');
  // No layer to work on: the status chip says so; a HUD would only add noise.
  if (!nodeId) return null;
  return (
    <div className={styles.hud} data-subject-hud="" aria-label={name} title={keys}>
      <span className={styles.name}>{name}</span>
      <span className={styles.mode} data-mode={tool === 'object-matte' ? marquee : kind}>{mode}</span>
      {brush && (
        <>
          <span className={styles.value} title={t('workspace.subjects.hud.sizeTitle', 'Brush size ([ and ])')}>
            <span className={styles.dot} style={{ width: Math.max(4, Math.min(14, size / 6)), height: Math.max(4, Math.min(14, size / 6)) }} aria-hidden="true" />
            {t('workspace.subjects.hud.size', '{n} px', { n: size })}
          </span>
          <span className={styles.value} title={t('workspace.subjects.hud.hardnessTitle', 'Hardness (Shift [ and ])')}>
            {t('workspace.subjects.hud.hardness', '{n} %', { n: hardness })}
          </span>
        </>
      )}
      <span className={styles.keys}>{keys}</span>
    </div>
  );
}
