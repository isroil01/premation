/**
 * The drag read-out badge for slip / slide / roll and keyframe drags — the
 * text it shows and the floating element that shows it.
 */

import styles from './Timeline.module.css';

/** Where the badge sits (client px) and what it says. */
export interface DragHudState {
  x: number;
  y: number;
  lines: string[];
}

/**
 * The drag read-out for slip / slide / roll, in FRAMES.
 *
 * Frames, not seconds or timecode: these are edits you make one or two frames
 * at a time, and "+0.067s" is not a quantity anyone cuts with. The second line
 * is the resulting in/out — the actual question a slip answers ("which part of
 * the shot am I on now?"), which the delta alone cannot tell you.
 *
 * Pure and module-level so it is not rebuilt on every pointermove, and so the
 * arithmetic is readable apart from the DOM work around it.
 */
export function hudLines(
  d: {
    mode: 'move' | 'start' | 'end' | 'slip' | 'slide' | 'roll';
    start: number;
    duration: number;
    sourceInSec: number;
    live: { start: number; duration: number; sourceInSec: number };
    roll?: { deltaSec: number; left: { duration: number }; right: { start: number; duration: number } };
  },
  fps: number,
): string[] {
  const f = (sec: number): number => Math.round(sec * fps);
  const signed = (frames: number): string => `${frames > 0 ? '+' : ''}${frames}`;
  if (d.mode === 'roll' && d.roll) {
    const delta = f(d.roll.deltaSec);
    const cut = d.roll.right.start + d.roll.deltaSec;
    return [`Roll ${signed(delta)}f`, `cut @ ${f(cut)}f`];
  }
  if (d.mode === 'slip') {
    const delta = f(d.live.sourceInSec - d.sourceInSec);
    const inF = f(d.live.sourceInSec);
    return [`Slip ${signed(delta)}f`, `src ${inF} → ${inF + f(d.live.duration)}`];
  }
  const delta = f(d.live.start - d.start);
  const startF = f(d.live.start);
  return [`Slide ${signed(delta)}f`, `${startF} → ${startF + f(d.live.duration)}`];
}

/**
 * The read-out for a live multi-row stagger: what the pattern is, how far
 * apart adjacent rows now sit, and how much of the timeline it is rearranging.
 *
 * The step is reported as the value a user could type into the Stagger dialog
 * to reproduce it, not as the raw pointer travel — the gesture is a way to
 * DIAL a number, and a badge that shows pixels would make it unrepeatable.
 */
export function staggerHudLines(
  barCount: number,
  rowCount: number,
  stagger: { step: number; mode: string },
  fps: number,
): string[] {
  const frames = Math.round(stagger.step * fps * 10) / 10;
  const label = stagger.mode.charAt(0).toUpperCase() + stagger.mode.slice(1);
  const bars = barCount === rowCount ? `${rowCount} rows` : `${rowCount} rows · ${barCount} bars`;
  return [`${label} ${frames > 0 ? '+' : ''}${frames}f`, bars];
}

/**
 * The badge. Positioned in CLIENT coordinates and rendered at the panel root:
 * the pointer is captured by the lanes but travels over the ruler, the header
 * column and out of the panel entirely, and a badge positioned inside the
 * scrolling lanes would be left behind by its own scroll offset the moment the
 * drag auto-scrolled.
 */
export function DragHud({ hud }: { hud: DragHudState | null }): JSX.Element | null {
  if (!hud) return null;
  return (
    <div
      className={styles.dragHud}
      style={{ left: hud.x + 14, top: hud.y + 16 }}
      aria-hidden
    >
      {hud.lines.map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}
