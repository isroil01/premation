/**
 * VUMeter — a stereo audio level meter for the status bar (AE's Audio panel VU).
 * Reads the AudioEngine's master L/R analysers on a rAF loop WHILE PLAYING only
 * (idle otherwise, like FpsMeter), and paints two peak bars with a green→amber→
 * red gradient. Hidden entirely when Web Audio has produced no analyser yet
 * (no audio in the project / unsupported), so it never shows dead chrome.
 */

import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '@stores/projectStore';
import { audioEngine } from '@core/audio/AudioEngine';
import { toDb, meterFraction } from '@core/audio/audioLevels';

interface Bars {
  l: number;
  r: number;
}

export function VUMeter(): JSX.Element | null {
  const playing = useWorkspaceStore((s) => (s.activeTabId ? (s.tabs[s.activeTabId]?.playing ?? false) : false));
  const [bars, setBars] = useState<Bars>({ l: 0, r: 0 });
  // Whether the engine ever produced levels — decides if we render at all.
  const [available, setAvailable] = useState(false);
  const raf = useRef(0);

  useEffect(() => {
    if (!playing) {
      setBars({ l: 0, r: 0 });
      return;
    }
    const loop = (): void => {
      const lv = audioEngine.getLevels();
      if (lv) {
        if (!available) setAvailable(true);
        setBars({ l: meterFraction(toDb(lv.l.peak)), r: meterFraction(toDb(lv.r.peak)) });
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, available]);

  if (!available) return null;

  return (
    <span
      title="Audio levels (L / R)"
      aria-label="Audio VU meter"
      style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, width: 46, verticalAlign: 'middle' }}
    >
      <Bar level={bars.l} />
      <Bar level={bars.r} />
    </span>
  );
}

function Bar({ level }: { level: number }): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, level)) * 100);
  return (
    <span style={{ position: 'relative', height: 4, borderRadius: 2, background: 'var(--color-surface-3)', overflow: 'hidden' }}>
      <span
        style={{
          position: 'absolute',
          inset: 0,
          width: `${pct}%`,
          borderRadius: 2,
          // Green up to ~70%, amber toward the top, red near clip.
          background: 'linear-gradient(90deg, var(--color-success) 0%, var(--color-success) 65%, #e6b400 82%, var(--color-danger, #e5484d) 100%)',
          transition: 'width 60ms linear',
        }}
      />
    </span>
  );
}
