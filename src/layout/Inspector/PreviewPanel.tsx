/**
 * Preview panel — AE's Preview panel: studio transport plus playback & monitor settings.
 *
 * Every control here DRIVES real engine and store state:
 *   • Play/Pause → TimelineController + projectStore
 *   • Loop       → TimelineController's per-comp loop flag
 *   • Range      → TimelineController Work Area (Entire Comp / Work Area / Playhead)
 *   • Skip       → Step size (skip + 1) frames on prev/next buttons
 *   • Resolution → renderQualityStore (Auto adaptive / Full / Half / Quarter)
 *   • Draft Mode → renderQualityStore draft flag (skips motion-blur for 60fps scrub)
 *   • Audio      → audioEngine master mute + live stereo VU level monitoring
 */

import { useEffect, useRef, useState } from 'react';
import { useProjectStore } from '@stores/projectStore';
import { useCurrentTime, setTime as setPlayheadTime } from '@stores/playbackClockStore';
import { useRenderQualityStore, type PreviewResolution } from '@stores/renderQualityStore';
import { documentMirror } from '@stores/documentMirror';
import { activeCompIdNow, compFps, useActiveMirrorComp } from '@hooks/useMirror';
import { flicksToSeconds, type CompSettings } from '@motion/engine-api';
import { isTransportLooping, pauseTransport, playTransport, setTransportLooping } from '@core/timeline/timelineView';
import { edit } from '@core/engine/uiEdits';
import { compTime } from '@core/engine/propRefs';
import { audioEngine } from '@core/audio/AudioEngine';
import { toDb, meterFraction } from '@core/audio/audioLevels';
import { Icon } from '@components/Icon';
import { IconButton } from '@components/IconButton';
import { Button } from '@components/Button';
import { cn } from '@utils/cn';
import styles from './PreviewPanel.module.css';

type PlayRange = 'work-area' | 'entire-comp' | 'current-forward';
type ResolutionChoice = 'auto' | PreviewResolution;

export function PreviewPanel(): JSX.Element {
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const playing = useProjectStore((s) => (activeTabId ? s.tabs[activeTabId]?.playing ?? false : false));
  const time = useCurrentTime();
  const setPlaying = useProjectStore((s) => s.actions.setPlaying);

  const setTime = (t: number, frame: number): void => {
    if (activeTabId) setPlayheadTime(activeTabId, t, frame);
  };

  const comp = useActiveMirrorComp();
  // The rate as the settings dialog states it (NTSC 30000/1001 → 29.97), so
  // the frame maths and the readout match what the user typed.
  const fps = Number(compFps(comp).toFixed(3)) || 30;
  const duration = comp ? flicksToSeconds(comp.settings.duration) : 0;
  const compWidth = comp?.settings.width ?? 0;
  const compHeight = comp?.settings.height ?? 0;

  // Loop playback state (transport, not the document)
  const [looping, setLoopingState] = useState(() => isTransportLooping());
  useEffect(() => {
    setLoopingState(isTransportLooping());
  }, [activeTabId]);

  const setLooping = (on: boolean): void => {
    setTransportLooping(on);
    setLoopingState(on);
  };

  // Work area range
  const [range, setRangeState] = useState<PlayRange>(() =>
    hasWorkArea(activeSettingsNow()) ? 'work-area' : 'entire-comp',
  );
  const setRange = (next: PlayRange): void => {
    const compId = activeCompIdNow();
    if (next === 'entire-comp') {
      if (compId && hasWorkArea(activeSettingsNow())) void edit('Clear Work Area', { type: 'clearWorkArea', comp: compId });
    } else if (next === 'current-forward' && duration > time && compId) {
      void edit('Work Area', { type: 'setWorkArea', comp: compId, range: { start: compTime(time), duration: compTime(duration - time) } });
    }
    setRangeState(next);
  };

  // Skip frames stepping
  const [skip, setSkip] = useState<number>(0);

  // Render resolution & adaptive quality
  const resolution = useRenderQualityStore((s) => s.resolution);
  const adaptive = useRenderQualityStore((s) => s.adaptive);
  const draft = useRenderQualityStore((s) => s.draft);
  const setDraft = useRenderQualityStore((s) => s.setDraft);

  const resolutionChoice: ResolutionChoice = adaptive ? 'auto' : resolution;
  const setResolutionChoice = (next: ResolutionChoice): void => {
    const rq = useRenderQualityStore.getState();
    if (next === 'auto') {
      rq.setAdaptive(true);
      rq.setResolution(1);
    } else {
      rq.setAdaptive(false);
      rq.setResolution(next);
    }
  };

  // Audio mute and live meter
  const [muteAudio, setMuteAudioState] = useState(() => audioEngine.isMasterMuted());
  const [meterBars, setMeterBars] = useState<{ l: number; r: number }>({ l: 0, r: 0 });
  const rafRef = useRef<number>(0);

  const setMuteAudio = (muted: boolean): void => {
    audioEngine.setMasterMuted(muted);
    setMuteAudioState(muted);
  };

  useEffect(() => {
    if (!playing || muteAudio) {
      setMeterBars({ l: 0, r: 0 });
      return;
    }
    const tick = (): void => {
      const lv = audioEngine.getLevels();
      if (lv) {
        setMeterBars({
          l: meterFraction(toDb(lv.l.peak)),
          r: meterFraction(toDb(lv.r.peak)),
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, muteAudio]);

  // Frame navigation handlers
  const handleFirstFrame = (): void => {
    setTime(0, 0);
  };

  const handlePrevFrame = (): void => {
    const frameDuration = 1 / fps;
    const targetT = Math.max(0, time - frameDuration * (skip + 1));
    setTime(targetT, Math.round(targetT * fps));
  };

  const handleTogglePlay = (): void => {
    const next = !playing;
    setPlaying(next);
    if (next) playTransport();
    else pauseTransport();
  };

  const handleNextFrame = (): void => {
    const frameDuration = 1 / fps;
    const targetT = Math.min(duration, time + frameDuration * (skip + 1));
    setTime(targetT, Math.round(targetT * fps));
  };

  const handleLastFrame = (): void => {
    setTime(duration, Math.round(duration * fps));
  };

  const currentFrame = Math.round(time * fps);
  const totalFrames = Math.max(1, Math.round(duration * fps));

  return (
    <div className={styles.root}>
      {/* ── 1. Timecode HUD Monitor Card ── */}
      <div className={styles.hudCard}>
        <div className={styles.hudPrimary}>
          <div className={styles.timecodeGroup}>
            <span className={styles.timecodeCurrent}>{formatTimecode(time, fps)}</span>
            <span className={styles.timecodeDuration}>/ {formatTimecode(duration, fps)}</span>
          </div>

          <div className={cn(styles.statusPill, playing && styles.statusPillLive)}>
            <span className={styles.statusDot} />
            <span>{playing ? 'Playing' : 'Paused'}</span>
          </div>
        </div>

        <div className={styles.hudSecondary}>
          <span>
            Frame <strong>{currentFrame}</strong> / {totalFrames}
          </span>
          <span className={styles.specsBadge}>
            {compWidth}×{compHeight} · {fps} fps
          </span>
        </div>
      </div>

      {/* ── 2. Pro Transport Deck ── */}
      <div className={styles.transportDeck} role="toolbar" aria-label="Preview transport controls">
        <IconButton
          aria-label="First frame (Home)"
          tooltip="First frame (Home)"
          variant="ghost"
          size="sm"
          onClick={handleFirstFrame}
        >
          <Icon name="skip-back" size="sm" />
        </IconButton>

        <IconButton
          aria-label="Previous frame"
          tooltip={skip > 0 ? `Step back ${skip + 1} frames (Page Up)` : 'Previous frame (Page Up)'}
          variant="ghost"
          size="sm"
          onClick={handlePrevFrame}
        >
          <Icon name="chevron-left" size="sm" />
        </IconButton>

        <IconButton
          aria-label={playing ? 'Pause' : 'Play'}
          tooltip={playing ? 'Pause playback (Space)' : 'Play preview (Space)'}
          variant="primary"
          size="md"
          onClick={handleTogglePlay}
        >
          <Icon name={playing ? 'pause' : 'play'} size="md" />
        </IconButton>

        <IconButton
          aria-label="Next frame"
          tooltip={skip > 0 ? `Step forward ${skip + 1} frames (Page Down)` : 'Next frame (Page Down)'}
          variant="ghost"
          size="sm"
          onClick={handleNextFrame}
        >
          <Icon name="chevron-right" size="sm" />
        </IconButton>

        <IconButton
          aria-label="Last frame (End)"
          tooltip="Last frame (End)"
          variant="ghost"
          size="sm"
          onClick={handleLastFrame}
        >
          <Icon name="skip-forward" size="sm" />
        </IconButton>

        <span className={styles.transportDivider} />

        <IconButton
          aria-label={looping ? 'Disable loop' : 'Enable loop'}
          tooltip={looping ? 'Loop playback active' : 'Play once'}
          variant={looping ? 'secondary' : 'ghost'}
          active={looping}
          size="sm"
          onClick={() => setLooping(!looping)}
        >
          <Icon name="loop" size="sm" />
        </IconButton>
      </div>

      {/* ── 3. Playback Range & Frame Stepping Card ── */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={styles.sectionTitle}>Playback Range</span>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingLabelRow}>
            <span className={styles.settingLabel}>Loop Boundary</span>
            <span className={styles.settingHint}>
              {range === 'work-area' ? 'Work Area Bounds' : range === 'entire-comp' ? 'Entire Comp' : 'From Playhead'}
            </span>
          </div>

          <div className={styles.segmented} role="radiogroup" aria-label="Playback range">
            <button
              type="button"
              role="radio"
              aria-checked={range === 'work-area'}
              className={cn(styles.segmentedItem, range === 'work-area' && styles.segmentedItemActive)}
              onClick={() => setRange('work-area')}
            >
              Work Area
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={range === 'entire-comp'}
              className={cn(styles.segmentedItem, range === 'entire-comp' && styles.segmentedItemActive)}
              onClick={() => setRange('entire-comp')}
            >
              Entire Comp
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={range === 'current-forward'}
              className={cn(styles.segmentedItem, range === 'current-forward' && styles.segmentedItemActive)}
              onClick={() => setRange('current-forward')}
            >
              From Time
            </button>
          </div>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingLabelRow}>
            <span className={styles.settingLabel}>Step Jump Multiplier</span>
            <span className={styles.settingHint}>+{skip + 1} frame{skip > 0 ? 's' : ''}</span>
          </div>

          <div className={styles.segmented} role="radiogroup" aria-label="Frame step rate">
            <button
              type="button"
              role="radio"
              aria-checked={skip === 0}
              className={cn(styles.segmentedItem, skip === 0 && styles.segmentedItemActive)}
              onClick={() => setSkip(0)}
            >
              1 Frame
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={skip === 1}
              className={cn(styles.segmentedItem, skip === 1 && styles.segmentedItemActive)}
              onClick={() => setSkip(1)}
            >
              2 Frames
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={skip === 2}
              className={cn(styles.segmentedItem, skip === 2 && styles.segmentedItemActive)}
              onClick={() => setSkip(2)}
            >
              3 Frames
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={skip === 5}
              className={cn(styles.segmentedItem, skip === 5 && styles.segmentedItemActive)}
              onClick={() => setSkip(5)}
            >
              6 Frames
            </button>
          </div>
        </div>
      </div>

      {/* ── 4. Resolution & Performance Card ── */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span className={styles.sectionTitle}>Quality & Performance</span>
        </div>

        <div className={styles.settingRow}>
          <div className={styles.settingLabelRow}>
            <span className={styles.settingLabel}>Render Resolution</span>
            <span className={styles.settingHint}>
              {resolutionChoice === 'auto' ? 'Adaptive' : resolutionChoice === 1 ? '100%' : resolutionChoice === 2 ? '50%' : resolutionChoice === 3 ? '33%' : '25%'}
            </span>
          </div>

          <div className={styles.segmented} role="radiogroup" aria-label="Render resolution">
            <button
              type="button"
              role="radio"
              aria-checked={resolutionChoice === 'auto'}
              className={cn(styles.segmentedItem, resolutionChoice === 'auto' && styles.segmentedItemActive)}
              onClick={() => setResolutionChoice('auto')}
            >
              Auto
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={resolutionChoice === 1}
              className={cn(styles.segmentedItem, resolutionChoice === 1 && styles.segmentedItemActive)}
              onClick={() => setResolutionChoice(1)}
            >
              Full
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={resolutionChoice === 2}
              className={cn(styles.segmentedItem, resolutionChoice === 2 && styles.segmentedItemActive)}
              onClick={() => setResolutionChoice(2)}
            >
              Half
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={resolutionChoice === 4}
              className={cn(styles.segmentedItem, resolutionChoice === 4 && styles.segmentedItemActive)}
              onClick={() => setResolutionChoice(4)}
            >
              Quarter
            </button>
          </div>
        </div>

        <div className={styles.draftRow}>
          <div className={styles.settingRow}>
            <span className={styles.settingLabel}>Draft 3D / Fast Scrub</span>
            <span className={styles.settingHint}>Skips motion blur during playback</span>
          </div>

          <Button
            size="xs"
            variant={draft ? 'secondary' : 'ghost'}
            icon={<Icon name="draft-3d" size="sm" />}
            aria-label="Toggle Draft Quality"
            aria-pressed={draft}
            onClick={() => setDraft(!draft)}
          >
            {draft ? 'Draft ON' : 'Draft OFF'}
          </Button>
        </div>
      </div>

      {/* ── 5. Audio Monitoring Deck ── */}
      <div className={styles.card}>
        <div className={styles.audioDeck}>
          <div className={styles.audioHeader}>
            <span className={styles.sectionTitle}>Audio Monitoring</span>

            <Button
              size="xs"
              variant={muteAudio ? 'danger' : 'ghost'}
              icon={<Icon name={muteAudio ? 'audio-off' : 'audio'} size="sm" />}
              aria-label={muteAudio ? 'Unmute preview audio' : 'Mute preview audio'}
              aria-pressed={muteAudio}
              onClick={() => setMuteAudio(!muteAudio)}
            >
              {muteAudio ? 'Muted' : 'Mute'}
            </Button>
          </div>

          <div className={styles.meterContainer}>
            <div className={styles.meterRow}>
              <span className={styles.channelLabel}>L</span>
              <div className={styles.meterTrack}>
                <div
                  className={cn(styles.meterFill, meterBars.l > 0.88 && styles.meterFillPeak)}
                  style={{ width: `${Math.round(meterBars.l * 100)}%` }}
                />
              </div>
              <span className={styles.meterStatusText}>
                {muteAudio ? 'OFF' : meterBars.l > 0 ? `${(meterBars.l * 48 - 48).toFixed(0)} dB` : '—'}
              </span>
            </div>

            <div className={styles.meterRow}>
              <span className={styles.channelLabel}>R</span>
              <div className={styles.meterTrack}>
                <div
                  className={cn(styles.meterFill, meterBars.r > 0.88 && styles.meterFillPeak)}
                  style={{ width: `${Math.round(meterBars.r * 100)}%` }}
                />
              </div>
              <span className={styles.meterStatusText}>
                {muteAudio ? 'OFF' : meterBars.r > 0 ? `${(meterBars.r * 48 - 48).toFixed(0)} dB` : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ── 6. Keyboard Shortcuts Footer ── */}
      <div className={styles.shortcutFooter}>
        <span className={styles.shortcutTitle}>Pro Keyboard Shortcuts</span>
        <div className={styles.shortcutGrid}>
          <div className={styles.shortcutItem}>
            <span>Play / Pause</span>
            <kbd className={styles.kbd}>Space</kbd>
          </div>
          <div className={styles.shortcutItem}>
            <span>Step Frame</span>
            <kbd className={styles.kbd}>PgUp / PgDn</kbd>
          </div>
          <div className={styles.shortcutItem}>
            <span>First / Last</span>
            <kbd className={styles.kbd}>Home / End</kbd>
          </div>
          <div className={styles.shortcutItem}>
            <span>Work Area In / Out</span>
            <kbd className={styles.kbd}>B / N</kbd>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The active composition's settings, read at call time. */
function activeSettingsNow(): CompSettings | undefined {
  const id = activeCompIdNow();
  return id ? documentMirror().comp(id)?.settings : undefined;
}

/** Whether a work area is set: the API states "none" as the whole composition. */
function hasWorkArea(s: CompSettings | undefined): boolean {
  return !!s && !(s.workArea.start === 0 && s.workArea.duration === s.duration);
}

function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.round(t * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

export default PreviewPanel;
