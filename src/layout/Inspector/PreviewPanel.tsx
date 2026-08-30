import { useState } from 'react';
import { useProjectStore } from '@stores/projectStore';
import { useCompositionStore } from '@stores/compositionStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { Icon } from '@components/Icon';
import { Switch } from '@components/Switch';
import styles from './PreviewPanel.module.css';

function formatTimecode(seconds: number, fps: number): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const f = total % Math.max(1, Math.round(fps));
  const s = Math.floor(total / Math.max(1, Math.round(fps)));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}:${pad(f)}`;
}

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

  return (
    <div className={styles.root}>
      {/* ── Status Head Readout ── */}
      <div className={styles.statusHead}>
        <span className={styles.timecodeDisplay}>{formatTimecode(time, fps || 30)}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span className={styles.fpsBadge}>{fps || 30} fps</span>
          <span className={styles.fpsBadge}>{compWidth}×{compHeight}</span>
        </div>
      </div>

      {/* ── AE RAM Transport Controls ── */}
      <div className={styles.transportBar}>
        <button
          type="button"
          className={styles.transportBtn}
          title="First Frame (Home)"
          onClick={handleFirstFrame}
        >
          <Icon name="skip-back" size="sm" />
        </button>

        <button
          type="button"
          className={styles.transportBtn}
          title="Previous Frame (Page Up / Ctrl+Left)"
          onClick={handlePrevFrame}
        >
          <Icon name="chevron-left" size="sm" />
        </button>

        <button
          type="button"
          className={`${styles.transportBtn} ${styles.transportBtnPrimary}`}
          title={playing ? 'Pause Preview (Spacebar)' : 'RAM Preview Play (Spacebar / Numpad 0)'}
          onClick={handleTogglePlay}
        >
          <Icon name={playing ? 'pause' : 'play'} size="sm" />
        </button>

        <button
          type="button"
          className={styles.transportBtn}
          title="Next Frame (Page Down / Ctrl+Right)"
          onClick={handleNextFrame}
        >
          <Icon name="chevron-right" size="sm" />
        </button>

        <button
          type="button"
          className={styles.transportBtn}
          title="Last Frame (End)"
          onClick={handleLastFrame}
        >
          <Icon name="skip-forward" size="sm" />
        </button>

        <button
          type="button"
          className={styles.transportBtn}
          title={`Loop Mode: ${loopMode === 'loop' ? 'Continuous Loop' : loopMode === 'ping-pong' ? 'Ping-Pong' : 'Play Once'}`}
          onClick={() => {
            setLoopMode(loopMode === 'loop' ? 'ping-pong' : loopMode === 'ping-pong' ? 'once' : 'loop');
          }}
        >
          <Icon name={loopMode === 'loop' ? 'loop' : loopMode === 'ping-pong' ? 'refresh' : 'play'} size="sm" />
        </button>
      </div>

      {/* ── Preview Options Card ── */}
      <div className={styles.settingsCard}>
        <div className={styles.row}>
          <span className={styles.label}>Shortcut</span>
          <select className={styles.select} defaultValue="space">
            <option value="space">Spacebar</option>
            <option value="num0">Numpad 0</option>
            <option value="shiftSpace">Shift + Spacebar</option>
          </select>
        </div>

        <div className={styles.row}>
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
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Skip Frames</span>
          <select
            className={styles.select}
            value={skip}
            onChange={(e) => setSkip(Number(e.target.value))}
          >
            <option value={0}>0 (Every Frame)</option>
            <option value={1}>1 (2× Speed)</option>
            <option value={2}>2 (3× Speed)</option>
            <option value={5}>5 (Fast Draft)</option>
          </select>
        </div>

        <div className={styles.row}>
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
        </div>

        <div className={styles.row}>
          <span className={styles.label}>Mute Audio</span>
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
