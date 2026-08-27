import { useState, useEffect, useRef } from 'react';
import { useInfoStore } from '@stores/infoStore';
import { useWorkspaceStore } from '@stores/projectStore';
import { useSelectionStore } from '@stores/selectionStore';
import { useCompositionStore } from '@stores/compositionStore';
import { audioEngine } from '@core/audio/AudioEngine';
import { toDb, meterFraction } from '@core/audio/audioLevels';
import defaultSceneGraph from '@core/scene/DefaultSceneGraph';
import { Icon } from '@components/Icon';
import styles from './InfoAudioPanel.module.css';

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

  return (
    <div className={styles.root}>
      {/* ── Info Card (Coordinates & RGBA) ── */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span>Pointer Info</span>
          <span style={{ color: 'var(--color-selection, #2988ff)' }}>{present ? 'Live' : 'Idle'}</span>
        </div>

        <div className={styles.grid}>
          <div className={styles.statRow}>
            <span className={styles.statKey}>X:</span>
            <span className={styles.statVal}>{present ? `${x} px` : '—'}</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statKey}>Y:</span>
            <span className={styles.statVal}>{present ? `${y} px` : '—'}</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statKey}>RGB:</span>
            <span className={styles.statVal}>
              {rgba ? (
                <>
                  <span className={styles.colorSwatch} style={{ background: swatch }} />
                  {`${rgba.r}, ${rgba.g}, ${rgba.b}`}
                </>
              ) : '—'}
            </span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statKey}>Alpha:</span>
            <span className={styles.statVal}>{rgba ? `${Math.round((rgba.a / 255) * 100)}%` : '—'}</span>
          </div>
          <div className={styles.statRow} style={{ gridColumn: 'span 2' }}>
            <span className={styles.statKey}>Hex:</span>
            <span className={styles.statVal}>{hexColor}</span>
          </div>
        </div>
      </div>

      {/* ── Selection / Comp Stats ── */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span>Composition Specs</span>
        </div>
        <div className={styles.grid}>
          <div className={styles.statRow}>
            <span className={styles.statKey}>Size:</span>
            <span className={styles.statVal}>{compWidth} × {compHeight}</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statKey}>FPS:</span>
            <span className={styles.statVal}>{compFps} fps</span>
          </div>
          <div className={styles.statRow} style={{ gridColumn: 'span 2' }}>
            <span className={styles.statKey}>Selected:</span>
            <span className={styles.statVal}>
              {primaryNode ? `${primaryNode.name} (${selectedIds.length} layer${selectedIds.length > 1 ? 's' : ''})` : 'None'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Audio Monitor (Dual Peak VU Meter) ── */}
      <div className={styles.card}>
        <div className={styles.cardHeader}>
          <span>Audio Master Levels</span>
          <button
            type="button"
            style={{ border: 'none', background: 'transparent', color: muted ? '#ef4444' : 'var(--color-text-secondary)', cursor: 'pointer', padding: 0 }}
            onClick={() => setMuted(!muted)}
            title={muted ? 'Unmute Audio' : 'Mute Audio'}
          >
            <Icon name={muted ? 'audio-off' : 'audio'} size="sm" />
          </button>
        </div>

        <div className={styles.meterTrack}>
          <div className={styles.channelRow}>
            <span className={styles.channelLabel}>L</span>
            <div className={styles.meterBar}>
              <div className={styles.meterFill} style={{ width: muted ? '0%' : `${Math.round(bars.l * 100)}%` }} />
            </div>
          </div>
          <div className={styles.channelRow}>
            <span className={styles.channelLabel}>R</span>
            <div className={styles.meterBar}>
              <div className={styles.meterFill} style={{ width: muted ? '0%' : `${Math.round(bars.r * 100)}%` }} />
            </div>
          </div>
        </div>

        <div className={styles.scaleRow}>
          <span>-48</span>
          <span>-24</span>
          <span>-12</span>
          <span>-6</span>
          <span>0</span>
          <span>+6</span>
        </div>

        <div className={styles.volumeRow}>
          <Icon name="sound" size="sm" />
          <input
            type="range"
            min="-48"
            max="12"
            value={volumeDb}
            onChange={(e) => setVolumeDb(Number(e.target.value))}
            className={styles.volumeSlider}
            title={`Master Volume: ${volumeDb > 0 ? `+${volumeDb}` : volumeDb} dB`}
          />
          <span style={{ fontSize: 'var(--font-size-micro)', fontFamily: 'monospace', minWidth: 36, textAlign: 'right' }}>
            {volumeDb > 0 ? `+${volumeDb}` : volumeDb} dB
          </span>
        </div>
      </div>
    </div>
  );
}
