/**
 * ScrollProxyBar — a horizontal scrollbar drawn away from the element it scrolls.
 *
 * The timeline keeps its height for rows, so its two sideways scrollbars live in
 * the status bar. Each shows only while its target actually overflows. The thumb
 * is written straight to the DOM from the target's scroll event: a scroll must
 * not render React (performance discipline).
 */

import { useEffect, useRef, useState } from 'react';
import styles from './ScrollProxyBar.module.css';

const MIN_THUMB_PX = 18;

export interface ScrollProxyBarProps {
  /** The element this bar scrolls; null draws nothing. */
  target: HTMLElement | null;
  label: string;
}

/** The thumb for a scroll state, in the track's pixels. Pure, for the tests. */
export function proxyThumb(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
  trackWidth: number,
): { width: number; left: number } {
  const range = scrollWidth - clientWidth;
  const width = Math.min(trackWidth, Math.max(MIN_THUMB_PX, (trackWidth * clientWidth) / scrollWidth));
  const left = range > 0 ? (scrollLeft / range) * (trackWidth - width) : 0;
  return { width, left };
}

export function ScrollProxyBar({ target, label }: ScrollProxyBarProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    if (!target) {
      setOverflowing(false);
      return;
    }
    const sync = (): void => {
      const { scrollLeft, scrollWidth, clientWidth } = target;
      const over = scrollWidth - clientWidth > 1;
      setOverflowing(over);
      const track = trackRef.current;
      const thumb = thumbRef.current;
      if (!over || !track || !thumb) return;
      const { width, left } = proxyThumb(scrollLeft, scrollWidth, clientWidth, track.clientWidth);
      thumb.style.width = `${width}px`;
      thumb.style.transform = `translateX(${left}px)`;
    };
    sync();
    target.addEventListener('scroll', sync, { passive: true });
    if (typeof ResizeObserver === 'undefined') {
      return () => target.removeEventListener('scroll', sync);
    }
    // The target's width, its content's width (a zoom), and the track itself,
    // which reports here when it stops being `hidden` and has a width to draw in.
    const ro = new ResizeObserver(sync);
    ro.observe(target);
    for (const child of Array.from(target.children)) ro.observe(child);
    if (trackRef.current) ro.observe(trackRef.current);
    return () => {
      target.removeEventListener('scroll', sync);
      ro.disconnect();
    };
  }, [target]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!target || !track || !thumb || e.button !== 0) return;
    e.preventDefault();
    const range = target.scrollWidth - target.clientWidth;
    const rect = track.getBoundingClientRect();
    const travel = rect.width - thumb.getBoundingClientRect().width;
    if (!(range > 0) || !(travel > 0)) return;
    // Off the thumb: jump so the thumb centres on the click, then drag from there.
    if (e.target !== thumb) {
      const at = e.clientX - rect.left - thumb.getBoundingClientRect().width / 2;
      target.scrollLeft = (at / travel) * range;
    }
    const startX = e.clientX;
    const startScroll = target.scrollLeft;
    track.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      target.scrollLeft = startScroll + ((ev.clientX - startX) / travel) * range;
    };
    const up = (): void => {
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', up);
      track.removeEventListener('pointercancel', up);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
  };

  return (
    <div
      ref={trackRef}
      className={styles.track}
      role="scrollbar"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={0}
      title={label}
      hidden={!overflowing}
      onPointerDown={onPointerDown}
    >
      <div ref={thumbRef} className={styles.thumb} />
    </div>
  );
}
