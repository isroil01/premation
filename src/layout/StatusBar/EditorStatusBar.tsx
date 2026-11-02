/**
 * EditorStatusBar — everything the bottom strip shows, wired to its stores.
 *
 * Extracted from App.tsx, where all of this sat as ~100 lines of inline
 * styles (one of them a hover colour applied by mutating `style` in
 * onMouseOver). App.tsx now passes the one thing it derives itself — the
 * layer count — and this owns the rest.
 *
 *   left    save state, or the assistant's current step, or the subject tools' message
 *           ("Segmenting…", the walk's Stop) · N layers · N selected · info readout
 *   centre  the composition chip (name, size, fps, dirty dot)
 *   right   job tray · VU · timeline zoom · fps · timecode · video health ·
 *           project health dot (opens Cache & Memory ▸ Health) · search
 *
 * The account button used to end this row. It is in the top bar's right
 * cluster now (TopNav on the web, the title bar in Electron), beside Preview
 * and Export, where "who am I signed in as" belongs.
 */

import { Icon } from '@components/Icon';
import { Kbd } from '@components/Kbd';
import { cn } from '@utils/cn';
import { useProjectStore } from '@stores/projectStore';
import { useClaudeStore } from '@stores/claudeStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useActiveMirrorComp } from '@hooks/useMirror';
import { settingsFps, settingsStartFrame } from '@core/mirror/compFacts';
import { openPalette } from '@stores/commandPaletteStore';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { useActiveCompName } from '@layout/Composition/activeCompName';
import { isMacKeyboard } from '@core/commands/formatChord';
import { t } from '@core/i18n';
import { StatusBar } from './StatusBar';
import { FpsMeter } from './FpsMeter';
import { InfoReadout } from './InfoReadout';
import { VUMeter } from './VUMeter';
import { StatusBarTimecode } from './StatusBarTimecode';
import { VideoHealth } from './VideoHealth';
import { ProjectHealthDot } from './ProjectHealthDot';
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
  const selectionCount = useSelectionStore((s) => s.ids.length);
  const assistantOn = useClaudeStore((s) => s.desk.busy || !!s.desk.group);
  // The subject tools speak here, off the picture they work on (SubjectToolHud.tsx).
  const subjectNotice = useRotoBrushStore((s) => !!s.notice || s.tracking);
  const activeDirty = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.dirty ?? false : false));
  // The COMPOSITION's name, not the tab's title — a tab keeps the title it was
  // minted with ("Main Comp") through every rename. See `activeCompName.ts`.
  const compName = useActiveCompName();
  const compSettings = useActiveMirrorComp()?.settings;
  const compFps = settingsFps(compSettings);
  const compWidth = compSettings?.width ?? 1920;
  const compHeight = compSettings?.height ?? 1080;
  const compStartFrame = settingsStartFrame(compSettings);

  return (
    <StatusBar
      left={
        <>
          {/* Real state, not a hardcoded "Ready": amber while unsaved. */}
          <span className={cn(styles.stateDot, activeDirty && styles.stateDotDirty)} aria-hidden>●</span>
          {assistantOn ? <AssistantWorkLine /> : subjectNotice ? <SubjectToolNotice /> : (
            <span className={styles.drop4}>{activeDirty ? t('statusBar.state.unsaved', 'Unsaved changes') : t('statusBar.state.ready', 'Ready')}</span>
          )}
          <span className={assistantOn || subjectNotice ? undefined : styles.drop4}><Sep /></span>
          <span>
            {layerCount === 1
              ? t('statusBar.layers.one', '{n} layer', { n: layerCount })
              : t('statusBar.layers.other', '{n} layers', { n: layerCount })}
          </span>
          {selectionCount > 0 ? (
            <>
              <Sep />
              <span>{t('statusBar.selection.count', '{n} selected', { n: selectionCount })}</span>
            </>
          ) : null}
          <span className={cn(styles.cluster, styles.drop3)}>
            <Sep />
            <InfoReadout />
          </span>
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
          <span className={cn(styles.compMeta, styles.drop3)}>
            {compWidth}×{compHeight} · {compFps}fps
          </span>
          {activeDirty ? (
            <span aria-label={t('statusBar.state.unsaved', 'Unsaved changes')} title={t('statusBar.state.unsaved', 'Unsaved changes')} className={styles.dirtyDot} />
          ) : null}
        </button>
      }
      right={
        <>
          <JobTray />
          <span className={cn(styles.passthrough, styles.drop4)}><VUMeter /></span>
          {/* Timeline zoom: back in the timeline's own footer (2026-10-14),
              beside the render time and Toggle Switches / Modes, as in AE. */}
          <span className={cn(styles.cluster, styles.drop2)}>
            <Sep />
            <FpsMeter />
          </span>
          <Sep />
          <StatusBarTimecode fps={compFps} startFrame={compStartFrame} />
          <VideoHealth />
          <Sep />
          <ProjectHealthDot />
          <Sep />
          <button
            type="button"
            className={styles.search}
            data-tour="command-palette"
            onClick={() => openPalette()}
            title={t('statusBar.search.title', 'Search commands, layers, effects, presets… (? for docs)')}
          >
            <Icon name="search" size="sm" />
            <span className={styles.drop2}>{t('statusBar.search.label', 'Search')}</span>
            <span className={cn(styles.cluster, styles.drop1)}>
              <Kbd size="sm" chord={isMacKeyboard() ? '⇧⌘P' : 'Ctrl+Shift+P'} />
            </span>
          </button>
        </>
      }
    />
  );
}
