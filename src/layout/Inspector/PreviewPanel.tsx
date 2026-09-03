import { useState } from 'react';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { Icon } from '@components/Icon';
import { Switch } from '@components/Switch';
import { cn } from '@utils/cn';
import styles from './PreviewPanel.module.css';

function formatTimecode(seconds: number, fps: number): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const f = total % Math.max(1, Math.round(fps));
  const s = Math.floor(total / Math.max(1, Math.round(fps)));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(f)}`;
}

/**
 * Preview — the transport and the RAM-preview settings, as one flat column.
 *
 * Readout, transport row, settings rows. It used to wrap each of those in its
 * own bordered card and give the play button a filled block; a panel this small
 * needs one rule between its groups, not three boxes.
 */
export function PreviewPanel(): JSX.Element {
  const activeTabId = useProjectStore((s) => s.activeTabId);
  const playing = useProjectStore((s) => (activeTabId ? s.tabs[activeTabId]?.playing ?? false : false));
  const time = useProjectStore((s) => (activeTabId ? s.tabs[activeTabId]?.time ?? 0 : 0));
  const setPlaying = useProjectStore((s) => s.actions.setPlaying);
  const setTime = useProjectStore((s) => s.actions.setTime);

  const fps = useCompositionStore((s) => s.fps);
  const duration = useCompositionStore((s) => s.durationSeconds);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);

  const [loopMode, setLoopMode] = useState<'loop' | 'ping-pong' | 'once'>('loop');
  const [range, setRange] = useState<'work-area' | 'entire-comp' | 'current-forward'>('work-area');
  const [skip, setSkip] = useState<number>(0);
  const [resolution, setResolution] = useState<'auto' | 'full' | 'half' | 'third' | 'quarter'>('auto');
  const [muteAudio, setMuteAudio] = useState(false);

  const handleFirstFrame = () => {
    setTime(0, 0);
  };

  const handlePrevFrame = () => {
    const frameDuration = 1 / (fps || 30);
    const targetT = Math.max(0, time - frameDuration * (skip + 1));
    setTime(targetT, Math.round(targetT * (fps || 30)));
  };

  const handleTogglePlay = () => {
    const next = !playing;
    setPlaying(next);
    const controller = getTimelineController();
    if (next) controller.play();
    else controller.pause();
  };

  const handleNextFrame = () => {
    const frameDuration = 1 / (fps || 30);
    const targetT = Math.min(duration, time + frameDuration * (skip + 1));
    setTime(targetT, Math.round(targetT * (fps || 30)));
  };

  const handleLastFrame = () => {
    setTime(duration, Math.round(duration * (fps || 30)));
  };

  const loopLabel = loopMode === 'loop' ? 'Continuous loop' : loopMode === 'ping-pong' ? 'Ping-pong' : 'Play once';

  return (
    <div className={styles.root}>
      {/* ── Readout ── */}
      <div className={styles.readout}>
        <span className={styles.timecode}>{formatTimecode(time, fps || 30)}</span>
        <span className={styles.meta}>{fps || 30} fps · {compWidth}×{compHeight}</span>
      </div>

      {/* ── Transport ── */}
      <div className={styles.transport} role="toolbar" aria-label="Preview transport">
        <button type="button" className={styles.transportBtn} title="First frame (Home)" aria-label="First frame" onClick={handleFirstFrame}>
          <Icon name="skip-back" size="sm" />
        </button>
        <button type="button" className={styles.transportBtn} title="Previous frame (Page Up)" aria-label="Previous frame" onClick={handlePrevFrame}>
          <Icon name="chevron-left" size="sm" />
        </button>
        <button
          type="button"
          className={cn(styles.transportBtn, styles.transportPlay)}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
          onClick={handleTogglePlay}
        >
          <Icon name={playing ? 'pause' : 'play'} size="md" />
        </button>
        <button type="button" className={styles.transportBtn} title="Next frame (Page Down)" aria-label="Next frame" onClick={handleNextFrame}>
          <Icon name="chevron-right" size="sm" />
        </button>
        <button type="button" className={styles.transportBtn} title="Last frame (End)" aria-label="Last frame" onClick={handleLastFrame}>
          <Icon name="skip-forward" size="sm" />
        </button>
        <span className={styles.transportGap} />
        <button
          type="button"
          className={cn(styles.transportBtn, loopMode !== 'once' && styles.transportOn)}
          title={`Loop: ${loopLabel}`}
          aria-label={`Loop mode: ${loopLabel}`}
          onClick={() => {
            setLoopMode(loopMode === 'loop' ? 'ping-pong' : loopMode === 'ping-pong' ? 'once' : 'loop');
          }}
        >
          <Icon name={loopMode === 'loop' ? 'loop' : loopMode === 'ping-pong' ? 'refresh' : 'play'} size="sm" />
        </button>
      </div>

      {/* ── Playback settings ── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Playback</span>

        <label className={styles.row}>
          <span className={styles.label}>Shortcut</span>
          <select className={styles.select} defaultValue="space">
            <option value="space">Spacebar</option>
            <option value="num0">Numpad 0</option>
            <option value="shiftSpace">Shift + Spacebar</option>
          </select>
        </label>

        <label className={styles.row}>
          <span className={styles.label}>Range</span>
          <select
            className={styles.select}
            value={range}
            onChange={(e) => setRange(e.target.value as typeof range)}
          >
            <option value="work-area">Work Area</option>
            <option value="entire-comp">Entire Comp</option>
            <option value="current-forward">From Current Time</option>
          </select>
        </label>

        <label className={styles.row}>
          <span className={styles.label}>Skip frames</span>
          <select
            className={styles.select}
            value={skip}
            onChange={(e) => setSkip(Number(e.target.value))}
          >
            <option value={0}>0 — every frame</option>
            <option value={1}>1 — 2× speed</option>
            <option value={2}>2 — 3× speed</option>
            <option value={5}>5 — fast draft</option>
          </select>
        </label>

        <label className={styles.row}>
          <span className={styles.label}>Resolution</span>
          <select
            className={styles.select}
            value={resolution}
            onChange={(e) => setResolution(e.target.value as typeof resolution)}
          >
            <option value="auto">Auto</option>
            <option value="full">Full (100%)</option>
            <option value="half">Half (50%)</option>
            <option value="third">Third (33%)</option>
            <option value="quarter">Quarter (25%)</option>
          </select>
        </label>

        <div className={styles.row}>
          <span className={styles.label}>Mute audio</span>
          <Switch
            checked={muteAudio}
            onChange={(e) => setMuteAudio(e.currentTarget.checked)}
            aria-label="Mute preview audio"
          />
        </div>
      </div>
    </div>
  );
}
