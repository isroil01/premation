/**
 * LiveTimecode — the playhead as text, exact on every frame, zero React
 * renders per tick.
 *
 * The transport bar and the timeline toolbar both printed the timecode from
 * `useCurrentTime()`, which re-rendered their whole component — a toolbar of
 * buttons and menus — 60×/s to change eight characters. This span owns its
 * text node instead: React renders it empty once, and `useLivePlayhead` writes
 * the text on every tick (only when the string actually changes, which at a
 * 30 fps comp on a 60 Hz display is every other tick).
 */

import { useCallback, useRef } from 'react';
import { framesToTimecode } from '@core/time/timecode';
import { useLivePlayhead } from './useLivePlayhead';

export interface LiveTimecodeProps {
  fps: number;
  startFrame?: number;
  /** `timecode` = MM:SS:FF (the default); `frames` = zero-padded frame count. */
  format?: 'timecode' | 'frames';
  className?: string;
}

export function formatPlayhead(time: number, fps: number, startFrame = 0, format: 'timecode' | 'frames' = 'timecode'): string {
  // The frame count is on the same axis as the timecode: a comp that starts
  // at frame 100 reads 00100 at its first frame, as AE's does.
  return format === 'frames'
    ? String(Math.round(time * fps) + startFrame).padStart(5, '0')
    : framesToTimecode(time, fps, startFrame);
}

export function LiveTimecode({ fps, startFrame = 0, format = 'timecode', className }: LiveTimecodeProps): JSX.Element {
  const ref = useRef<HTMLSpanElement | null>(null);
  const apply = useCallback((t: number): void => {
    const el = ref.current;
    if (!el) return;
    const text = formatPlayhead(t, fps, startFrame, format);
    if (el.textContent !== text) el.textContent = text;
  }, [fps, startFrame, format]);
  useLivePlayhead(apply);
  // No children: the text node is this component's, not React's — a React
  // child here would be reconciled against a node the subscription replaced.
  return <span ref={ref} className={className} data-live-timecode="" />;
}
