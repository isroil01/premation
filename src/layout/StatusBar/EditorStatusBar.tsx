/**
 * EditorStatusBar — everything the bottom strip shows, wired to its stores.
 *
 * Extracted from App.tsx, where all of this sat as ~100 lines of inline
 * styles (one of them a hover colour applied by mutating `style` in
 * onMouseOver). App.tsx now passes the one thing it derives itself — the
 * layer count — and this owns the rest.
 *
 *   left    save state · N layers · N selected · info readout
 *   centre  the composition chip (name, size, fps, dirty dot)
 *   right   job tray · VU · timeline zoom · fps · timecode · video health · search
 *
 * The account button used to end this row. It is in the top bar's right
 * cluster now (TopNav on the web, the title bar in Electron), beside Preview
 * and Export, where "who am I signed in as" belongs.
 */

import { Icon } from '@components/Icon';
import { Kbd } from '@components/Kbd';
import { cn } from '@utils/cn';
import { useProjectStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { openPalette } from '@stores/commandPaletteStore';
import { openCompositionSettings } from '@layout/Composition/CompositionSettingsDialog';
import { useActiveCompName } from '@layout/Composition/activeCompName';
import { isMacKeyboard } from '@core/commands/formatChord';
import { countLabel } from './countLabel';
import { StatusBar } from './StatusBar';
import { FpsMeter } from './FpsMeter';
import { InfoReadout } from './InfoReadout';
import { VUMeter } from './VUMeter';
import { TimelineZoom } from './TimelineZoom';
import { StatusBarTimecode } from './StatusBarTimecode';
import { VideoHealth } from './VideoHealth';
import { JobTray } from './JobTray';
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
  const activeDirty = useProjectStore((s) => (s.activeTabId ? s.tabs[s.activeTabId]?.dirty ?? false : false));
  // The COMPOSITION's name, not the tab's title — a tab keeps the title it was
  // minted with ("Main Comp") through every rename. See `activeCompName.ts`.
  const compName = useActiveCompName();
  const compFps = useCompositionStore((s) => s.fps);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compStartFrame = useCompositionStore((s) => s.startFrame);

  return (
    <StatusBar
      left={
        <>
          {/* Real state, not a hardcoded "Ready": amber while unsaved. */}
          <span className={cn(styles.stateDot, activeDirty && styles.stateDotDirty)} aria-hidden>●</span>
          <span className={styles.drop4}>{activeDirty ? 'Unsaved changes' : 'Ready'}</span>
          <span className={styles.drop4}><Sep /></span>
          <span>{countLabel(layerCount, 'layer')}</span>
          {selectionCount > 0 ? (
            <>
              <Sep />
              <span>{selectionCount} selected</span>
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
          title={compName ? `${compName} — Composition settings` : 'Composition settings'}
          onClick={() => openCompositionSettings()}
        >
          <Icon name="layers" size="sm" className={styles.compIcon} />
          <span className={styles.compName}>{compName ?? 'Untitled'}</span>
          <span className={cn(styles.compMeta, styles.drop3)}>
            {compWidth}×{compHeight} · {compFps}fps
          </span>
          {activeDirty ? (
            <span aria-label="Unsaved changes" title="Unsaved changes" className={styles.dirtyDot} />
          ) : null}
        </button>
      }
      right={
        <>
          <JobTray />
          <span className={cn(styles.passthrough, styles.drop4)}><VUMeter /></span>
          {/* Timeline zoom. It had a 22px footer row to itself at the
              bottom of the timeline panel, empty across its whole left
              half; the status bar is already the strip for readouts you
              glance at and occasionally poke. */}
          <TimelineZoom />
          <span className={cn(styles.cluster, styles.drop2)}>
            <Sep />
            <FpsMeter />
          </span>
          <Sep />
          <StatusBarTimecode fps={compFps} startFrame={compStartFrame} />
          <VideoHealth />
          <Sep />
          <button
            type="button"
            className={styles.search}
            data-tour="command-palette"
            onClick={() => openPalette()}
            title="Search commands, layers, effects, presets… (? for docs)"
          >
            <Icon name="search" size="sm" />
            <span className={styles.drop2}>Search</span>
            <span className={cn(styles.cluster, styles.drop1)}>
              <Kbd size="sm" chord={isMacKeyboard() ? '⇧⌘P' : 'Ctrl+Shift+P'} />
            </span>
          </button>
        </>
      }
    />
  );
}
