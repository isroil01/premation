import { useState, useEffect } from 'react';
import { useActiveWorkspace } from '@stores/projectStore';
import { getTimelineController } from '@core/timeline/TimelineController';
import { Icon } from '@components/Icon';
import styles from './PresentationModeWindow.module.css';

export function PresentationModeWindow(): JSX.Element {
  const workspace = useActiveWorkspace();
  const playheadTimeSec = workspace?.time ?? 0;
  const [isPlaying, setIsPlaying] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const togglePlay = () => {
    const tc = getTimelineController();
    if (isPlaying) {
      tc.pause();
      setIsPlaying(false);
    } else {
      tc.play();
      setIsPlaying(true);
    }
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  return (
    <div className={styles.root}>
      {/* Clean Full Viewport Frame */}
      <div className={styles.canvasContainer}>
        <div style={{ color: 'rgba(255, 255, 255, 0.4)', fontSize: 'var(--font-size-md)', fontFamily: 'sans-serif' }}>
          [ Presentation Canvas — Synchronized 60 FPS Viewport ]
        </div>
      </div>

      {/* Hover Overlay Playback Bar */}
      <div className={styles.controlOverlay}>
        <button
          type="button"
          className={styles.btn}
          onClick={togglePlay}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          <Icon name={isPlaying ? 'pause' : 'play'} size="md" />
        </button>

        <span className={styles.timeReadout}>
          {playheadTimeSec.toFixed(2)}s
        </span>

        <span className={styles.badge}>60 FPS</span>
        <span className={styles.badge}>1080p</span>

        <button
          type="button"
          className={styles.btn}
          onClick={toggleFullscreen}
          title={fullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
        >
          <Icon name={fullscreen ? 'minimize' : 'maximize'} size="md" />
        </button>
      </div>
    </div>
  );
}
