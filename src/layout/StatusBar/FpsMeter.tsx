/**
 * FpsMeter — a real frames-per-second readout for the status bar (spec:
 * "GPU/FPS readout available in a status bar, toggleable, off by default").
 * Click to toggle; when on, a rAF loop measures the actual refresh rate.
 */

import { useEffect, useRef, useState } from 'react';

export function FpsMeter(): JSX.Element {
  const [on, setOn] = useState(false);
  const [fps, setFps] = useState(0);
  const raf = useRef(0);

  useEffect(() => {
    if (!on) return;
    let frames = 0;
    let last = performance.now();
    const loop = (): void => {
      frames++;
      const now = performance.now();
      if (now - last >= 500) {
        setFps(Math.round((frames * 1000) / (now - last)));
        frames = 0;
        last = now;
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [on]);

  return (
    <button
      type="button"
      onClick={() => setOn((v) => !v)}
      title={on ? 'Hide FPS' : 'Show FPS'}
      style={{
        font: 'inherit',
        fontFamily: 'var(--font-family-mono)',
        fontVariantNumeric: 'tabular-nums',
        color: on ? 'var(--color-success)' : 'var(--color-text-muted)',
        cursor: 'pointer',
        background: 'none',
        padding: 0,
      }}
    >
      {on ? `${fps} fps` : 'fps'}
    </button>
  );
}
