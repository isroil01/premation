/**
 * EditorStatusBar — everything the bottom strip shows, wired to its stores.
 *
 * Extracted from App.tsx, where all of this sat as ~100 lines of inline
 * styles (one of them a hover colour applied by mutating `style` in
 * onMouseOver). App.tsx now passes the one thing it derives itself — the
 * layer count — and this owns the rest.
 *
 *   left    the assistant's current step, the subject tools' message or a quiet
 *           notice · N layers · the timeline's render time, cache, Switches / Modes,
 *           the layer columns' scrollbar
 *   centre  the composition's name (dirty dot while unsaved)
 *   right   job tray · VU · fps · video health · the timeline's scrollbar and zoom
 *
 * The account button used to end this row. It is in the top bar's right
 * cluster now (TopNav on the web, the title bar in Electron), beside Preview
 * and Export, where "who am I signed in as" belongs.
 */

import { useEffect } from 'react';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import { useProjectStore } from '@stores/projectStore';
import { latestQuietNotification, useUIStore } from '@stores/uiStore';
import { useClaudeStore } from '@stores/claudeStore';
import { useTimelineStatusSlotStore } from '@stores/timelineStatusSlotStore';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { useActiveCompName } from '@layout/Composition/activeCompName';
import { t } from '@core/i18n';
import { StatusBar } from './StatusBar';
import { FpsMeter } from './FpsMeter';
import { VUMeter } from './VUMeter';
import { VideoHealth } from './VideoHealth';
import { JobTray } from './JobTray';
import { AssistantWorkLine } from './AssistantWorkLine';
import { SubjectToolNotice } from '@layout/Workspace/SubjectToolHud';
import { useRotoBrushStore } from '@stores/rotoBrushStore';
import styles from './EditorStatusBar.module.css';

export interface EditorStatusBarProps {
  /** Layers in the active composition, as the timeline derives them. */
  layerCount: number;
}

function Sep(): JSX.Element {
  return <span className={styles.dot} aria-hidden>·</span>;
}

export function EditorStatusBar({ layerCount }: EditorStatusBarProps): JSX.Element {
  const assistantOn = useClaudeStore((s) => s.desk.busy || !!s.desk.group);
  // The subject tools speak here, off the picture they work on (SubjectToolHud.tsx).
  const subjectNotice = useRotoBrushStore((s) => !!s.notice || s.tracking);
  // Routine feedback is said here, not in a card over the work (NotificationHost).
  const quietNotice = useUIStore(latestQuietNotification);
  useEffect(() => {
    useUIStore.getState().setNoticeLineMounted(true);
    return () => useUIStore.getState().setNoticeLineMounted(false);
  }, []);
  const activeDirty = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.dirty ?? false : false));
  // The COMPOSITION's name, not the tab's title — a tab keeps the title it was
  // minted with ("Main Comp") through every rename. See `activeCompName.ts`.
  const compName = useActiveCompName();
  // The timeline's readouts and view controls draw here (TimelineFooter).
  const setLeftSlot = useTimelineStatusSlotStore((s) => s.setLeft);
  const setRightSlot = useTimelineStatusSlotStore((s) => s.setRight);

  return (
    <StatusBar
      left={
        <>
          {assistantOn ? <AssistantWorkLine /> : subjectNotice ? <SubjectToolNotice /> : quietNotice ? (
            <span className={styles.notice} role="status" title={quietNotice.detail ?? quietNotice.message} data-status-notice="">
              <span className={styles.noticeText}>{quietNotice.message}</span>
              {quietNotice.action && (
                <button type="button" className={styles.noticeAction} onClick={() => quietNotice.action?.onSelect()}>
                  {quietNotice.action.label}
                </button>
              )}
            </span>
          ) : null}
          {assistantOn || subjectNotice || quietNotice ? <Sep /> : null}
          <span>
            {layerCount === 1
              ? t('statusBar.layers.one', '{n} layer', { n: layerCount })
              : t('statusBar.layers.other', '{n} layers', { n: layerCount })}
          </span>
          <div ref={setLeftSlot} className={styles.timelineSlot} />
        </>
      }
      center={
        <button
          type="button"
          className={styles.comp}
          title={compName
            ? t('statusBar.comp.settingsNamed', '{name} — Composition settings', { name: compName })
            : t('statusBar.comp.settings', 'Composition settings')}
          onClick={() => openCompositionSettings()}
        >
          <Icon name="layers" size="sm" className={styles.compIcon} />
          <span className={styles.compName}>{compName ?? t('statusBar.comp.untitled', 'Untitled')}</span>
          {activeDirty ? (
            <span aria-label={t('statusBar.state.unsaved', 'Unsaved changes')} title={t('statusBar.state.unsaved', 'Unsaved changes')} className={styles.dirtyDot} />
          ) : null}
        </button>
      }
      right={
        <>
          <JobTray />
          <span className={cn(styles.passthrough, styles.drop4)}><VUMeter /></span>
          <span className={cn(styles.cluster, styles.drop2)}><FpsMeter /></span>
          <VideoHealth />
          <div ref={setRightSlot} className={styles.timelineSlot} />
        </>
      }
    />
  );
}
