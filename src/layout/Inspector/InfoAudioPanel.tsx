import { useState, useEffect, useRef } from 'react';
import { useInfoStore } from '@stores/infoStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { audioEngine } from '@core/audio/AudioEngine';
import { toDb, meterFraction } from '@core/audio/audioLevels';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { Icon } from '@components/Icon';
import { cn } from '@utils/cn';
import styles from './InfoAudioPanel.module.css';

/**
 * Info & Audio — three flat readout groups: the pointer, the composition, and
 * the master meter.
 *
 * Rows, not cards. The panel used to draw each group in its own bordered,
 * rounded box, so a 280px column held three boxes inside a box; a readout is a
 * list of labelled values, and a rule between groups is all the structure it
 * needs.
 */
export function InfoAudioPanel(): JSX.Element {
  const { x, y, rgba, present } = useInfoStore();
  const selectedIds = useSelectionStore((s) => s.ids);
  const compWidth = useCompositionStore((s) => s.width);
  const compHeight = useCompositionStore((s) => s.height);
  const compFps = useCompositionStore((s) => s.fps);
  const playing = useWorkspaceStore((s) => (s.activeTabId ? (s.tabs[s.activeTabId]?.playing ?? false) : false));

  const [bars, setBars] = useState<{ l: number; r: number }>({ l: 0, r: 0 });
  const [volumeDb, setVolumeDb] = useState(0);
  const [muted, setMuted] = useState(false);
  const raf = useRef(0);

  useEffect(() => {
    if (!playing) {
      setBars({ l: 0, r: 0 });
      return;
    }
    const loop = (): void => {
      const lv = audioEngine.getLevels();
      if (lv) {
        setBars({ l: meterFraction(toDb(lv.l.peak)), r: meterFraction(toDb(lv.r.peak)) });
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing]);

  const swatch =
    rgba && rgba.a > 0
      ? `rgba(${rgba.r}, ${rgba.g}, ${rgba.b}, ${(rgba.a / 255).toFixed(2)})`
      : 'transparent';

  const hexColor = rgba
    ? `#${rgba.r.toString(16).padStart(2, '0')}${rgba.g.toString(16).padStart(2, '0')}${rgba.b.toString(16).padStart(2, '0')}`.toUpperCase()
    : '—';

  const primaryNode = selectedIds[0] ? defaultSceneGraph.getNode(selectedIds[0]) : null;
  const volumeLabel = `${volumeDb > 0 ? `+${volumeDb}` : volumeDb} dB`;

  return (
    <div className={styles.root}>
      {/* ── Pointer ── */}
      <section className={styles.group} aria-label="Pointer">
        <div className={styles.groupHead}>
          <span className={styles.groupLabel}>Pointer</span>
          <span className={cn(styles.status, present && styles.statusLive)}>{present ? 'Live' : 'Idle'}</span>
        </div>
        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.key}>X</span>
            <span className={cn(styles.value, styles.mono)}>{present ? `${x} px` : '—'}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Y</span>
            <span className={cn(styles.value, styles.mono)}>{present ? `${y} px` : '—'}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>RGB</span>
            <span className={cn(styles.value, styles.mono)}>
              {rgba ? (
                <>
                  <span className={styles.colorSwatch} style={{ background: swatch }} />
                  {`${rgba.r}, ${rgba.g}, ${rgba.b}`}
                </>
              ) : '—'}
            </span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Alpha</span>
            <span className={cn(styles.value, styles.mono)}>{rgba ? `${Math.round((rgba.a / 255) * 100)}%` : '—'}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Hex</span>
            <span className={cn(styles.value, styles.mono)}>{hexColor}</span>
          </div>
        </div>
      </section>

      {/* ── Composition ── */}
      <section className={styles.group} aria-label="Composition">
        <div className={styles.groupHead}>
          <span className={styles.groupLabel}>Composition</span>
        </div>
        <div className={styles.rows}>
          <div className={styles.row}>
            <span className={styles.key}>Size</span>
            <span className={cn(styles.value, styles.mono)}>{compWidth} × {compHeight}</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Frame rate</span>
            <span className={cn(styles.value, styles.mono)}>{compFps} fps</span>
          </div>
          <div className={styles.row}>
            <span className={styles.key}>Selected</span>
            <span className={styles.value} title={primaryNode?.name ?? undefined}>
              {primaryNode ? `${primaryNode.name}${selectedIds.length > 1 ? ` +${selectedIds.length - 1}` : ''}` : 'None'}
            </span>
          </div>
        </div>
      </section>

      {/* ── Audio ── */}
      <section className={styles.group} aria-label="Audio">
        <div className={styles.groupHead}>
          <span className={styles.groupLabel}>Audio</span>
          <button
            type="button"
            className={cn(styles.iconBtn, muted && styles.iconBtnMuted)}
            onClick={() => setMuted(!muted)}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute audio' : 'Mute audio'}
            title={muted ? 'Unmute audio' : 'Mute audio'}
          >
            <Icon name={muted ? 'audio-off' : 'audio'} size="sm" />
          </button>
        </div>

        <div className={styles.meterTrack}>
          <div className={styles.channelRow}>
            <span className={styles.channelLabel}>L</span>
            <div className={styles.meterBar}>
              <div className={styles.meterCover} style={{ transform: `scaleX(${muted ? 1 : (1 - bars.l).toFixed(3)})` }} />
            </div>
          </div>
          <div className={styles.channelRow}>
            <span className={styles.channelLabel}>R</span>
            <div className={styles.meterBar}>
              <div className={styles.meterCover} style={{ transform: `scaleX(${muted ? 1 : (1 - bars.r).toFixed(3)})` }} />
            </div>
          </div>
          <div className={styles.scaleRow} aria-hidden="true">
            <span>-48</span>
            <span>-24</span>
            <span>-12</span>
            <span>-6</span>
            <span>0</span>
            <span>+6</span>
          </div>
        </div>

        <div className={styles.row}>
          <span className={styles.key}>Master</span>
          <input
            type="range"
            min="-48"
            max="12"
            value={volumeDb}
            onChange={(e) => setVolumeDb(Number(e.target.value))}
            className={styles.volumeSlider}
            aria-label="Master volume"
            title={`Master volume: ${volumeLabel}`}
          />
          <span className={cn(styles.value, styles.mono, styles.volumeValue)}>{volumeLabel}</span>
        </div>
      </section>
    </div>
  );
}
