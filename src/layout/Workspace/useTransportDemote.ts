/**
 * How many control groups the transport bar has had to shed to fit.
 *
 * Measured, not guessed at breakpoints: the bar's natural width depends on what
 * the viewport tools are currently showing, how long the composition is
 * (`00:00:00 / 00:10:00` is wider than `/ 0:05`), and the user's UI scale. A
 * container query would have to encode all of that as a number, and be wrong
 * whenever one of them changed.
 *
 * One step per measurement, with hysteresis:
 *
 *   - overflowing   → shed one more group, and remember the width that would be
 *                     needed to take it back
 *   - room to spare → take one back, but only past that remembered width
 *
 * Without the remembered width the bar oscillates: restoring a group makes it
 * overflow, which sheds it, which leaves room, which restores it again.
 */

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { MAX_DEMOTE_LEVEL } from './transportOverflow';

/** Slack before restoring, so a 1px rounding difference cannot start a loop. */
const HYSTERESIS_PX = 12;

export function useTransportDemote(ref: RefObject<HTMLElement | null>): number {
  const [level, setLevel] = useState(0);
  /**
   * The level, again, as a ref.
   *
   * The decision has to be made from a FRESH DOM read paired with the level
   * that read belongs to, and it has to write `widthToUndo` as it goes. Doing
   * that inside a `setLevel` updater looked tidy and was wrong twice over: the
   * updater is impure (React may run it more than once, writing the ref again),
   * and several ResizeObserver callbacks can land before any re-render, so
   * every one of them read the same stale `level` from the closure and stamped
   * the same threshold into all four slots. The ladder then could not be walked
   * back a step at a time.
   */
  const levelRef = useRef(0);
  /** `widthToUndo[n]` — client width at which level n can drop back to n-1. */
  const widthToUndo = useRef<number[]>([]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    /**
     * The width a flex row's children actually need, gaps included.
     *
     * Not `scrollWidth`. Both side columns are flex rows that lean toward the
     * centre — the left one is `justify-content: flex-end` — so when its
     * children no longer fit they overflow off its LEFT edge, and `scrollWidth`
     * reports nothing at all for overflow in that direction. Measured that way
     * the left half of the bar could be 148px past its means with the deficit
     * reading zero, and the row would sit there clipped rather than shedding
     * anything.
     */
    const contentWidth = (row: Element): number => {
      const kids = Array.from(row.children);
      if (kids.length === 0) return 0;
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      let total = gap * (kids.length - 1);
      for (const kid of kids) total += kid.getBoundingClientRect().width;
      return total;
    };

    /** How many pixels short the row is — the worst column decides. */
    const deficit = (): number => {
      let worst = el.scrollWidth - el.clientWidth;
      for (const col of Array.from(el.children)) {
        worst = Math.max(worst, contentWidth(col) - col.clientWidth);
      }
      return worst;
    };

    const measure = (): void => {
      // A zero-width bar is a hidden panel, not a cramped one. Measuring it
      // sheds every group and records nonsense thresholds that then keep them
      // shed once the panel comes back.
      if (el.clientWidth === 0) return;

      const overflow = deficit();
      const n = levelRef.current;

      if (overflow > 1) {
        if (n >= MAX_DEMOTE_LEVEL) return;
        widthToUndo.current[n + 1] = el.clientWidth + overflow + HYSTERESIS_PX;
        levelRef.current = n + 1;
        setLevel(n + 1);
        return;
      }

      if (n === 0) return;
      const needed = widthToUndo.current[n];
      if (needed === undefined || el.clientWidth >= needed) {
        levelRef.current = n - 1;
        setLevel(n - 1);
      }
    };

    // Runs once per level change too — `level` is a dependency, so each new
    // layout gets measured against the level that produced it.
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // A group's own content can change width without the bar resizing: the
    // quality label going Full → Quarter, the viewport tools gaining a badge.
    // Watching the children catches that; the same `measure` handles it, so
    // there is still exactly one decision path.
    for (const child of Array.from(el.children)) ro.observe(child);

    // A window resize belts the observer's braces. The two overlap almost
    // always, and `measure` is idempotent — it reads the DOM and moves at most
    // one step — so a doubled call costs a layout read. What it buys is a row
    // that still adapts where ResizeObserver does not deliver: a hidden or
    // throttled tab, an embedded webview, a headless capture.
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, level]);

  return level;
}
